//! Public engine API. The skeleton lives here in Task 7.1; Task 7.2 wires
//! `search` + iterative deepening, Task 7.3 adds scenario extraction.

use crate::cancellation::CancelHandle;
use crate::draft_state::{DraftState, Phase, Side};
use crate::evaluator::{EvalContext, MetaData, PhaseWeightTable};
use crate::iterative_deepening::{self, SearchResult};
use crate::pools::{Penalties, TeamPool};
use crate::role_solver::ChampionMeta;
use crate::scenarios::Scenario;
use crate::search::{search_with_stats, SearchParams, TreeNode};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Top-level engine handle. Holds metadata loaded once at construction so
/// callers don't pay per-request load cost. Cheap to clone — Phase 9 will wrap
/// this in an `Arc` for the napi-rs boundary.
pub struct Engine {
    #[allow(dead_code)]
    meta: MetaData,
    #[allow(dead_code)]
    champion_meta: HashMap<String, ChampionMeta>,
}

/// Engine-level error taxonomy. Mirrors the protocol's `engine.*` codes:
/// `InvalidInput.path` is the Zod-style path to the offending field, used by
/// the napi-rs wrapper to populate `EngineError.path` on the JS side.
#[derive(Clone, Debug, thiserror::Error)]
pub enum EngineError {
    #[error("invalid input")]
    InvalidInput { path: Vec<String> },
    #[error("compute cancelled")]
    Cancelled,
    #[error("compute timed out at depth {0}")]
    Timeout(usize),
    #[error("internal engine error: {0}")]
    Internal(String),
}

impl From<crate::cancellation::CancelError> for EngineError {
    fn from(_: crate::cancellation::CancelError) -> Self {
        EngineError::Cancelled
    }
}

/// Request to `Engine::compute()`. Task 7.1 keeps this minimal; Task 7.2
/// populates the rest of the protocol shape (pools, config, forced branches,
/// cross-game exclusions) so the napi-rs layer can deserialize directly into
/// it from `protocol_types::EngineRequest`.
pub struct ComputeRequest {
    pub state: DraftState,
    pub our_side: Side,
    pub our_pool: TeamPool,
    pub opp_pool: TeamPool,
    pub cross_game_exclusions: Vec<String>,
    pub search_params: SearchParams,
    pub latency_budget_ms: u64,
    pub champion_meta: HashMap<String, ChampionMeta>,
    pub meta_overrides: Option<MetaData>,
    pub phase_weights_blue: PhaseWeightTable,
    pub phase_weights_red: PhaseWeightTable,
    pub penalties: Penalties,
    pub synergy_multiplier: f64,
    pub counter_multiplier: f64,
    pub flex_retention_weight: f64,
    pub reveal_cost_weight: f64,
}

/// Response shape mirrors spec § "Response schema" — `meta` aggregated as
/// flat fields here rather than a nested struct since this is the engine
/// boundary, not the protocol boundary. Phase 9's napi-rs layer maps these
/// onto `EngineResponse.meta.*`.
pub struct ComputeResponse {
    pub tree: TreeNode,
    pub scenarios: Vec<Scenario>,
    pub nodes_evaluated: usize,
    pub compute_time_ms: u64,
    pub pruning_rate: f64,
    pub depth_reached: usize,
    pub transpositions_found: usize,
    pub forced_branches_dropped: usize,
    pub cancelled: bool,
}

impl Engine {
    pub fn new(meta: MetaData, champion_meta: HashMap<String, ChampionMeta>) -> Self {
        Self {
            meta,
            champion_meta,
        }
    }

    /// Skeleton entry point. Task 7.2 replaces the body with `iterative_deepening`
    /// + `search` + scenario extraction. For now returns an empty tree so the
    /// napi-rs wrapper (Phase 9) can compile against the public API while the
    /// internals stabilize.
    pub fn compute(
        &self,
        request: ComputeRequest,
        cancel: &CancelHandle,
    ) -> Result<ComputeResponse, EngineError> {
        if cancel.is_cancelled() {
            return Err(EngineError::Cancelled);
        }

        let start = Instant::now();
        let ComputeRequest {
            state,
            our_side,
            our_pool,
            opp_pool,
            cross_game_exclusions,
            search_params,
            latency_budget_ms,
            champion_meta,
            meta_overrides,
            phase_weights_blue,
            phase_weights_red,
            penalties,
            synergy_multiplier,
            counter_multiplier,
            flex_retention_weight,
            reveal_cost_weight,
        } = request;
        let _ = cross_game_exclusions;

        let phase = state
            .current_turn()
            .map(|turn| turn.phase)
            .unwrap_or(Phase::Pick2);
        let (our_picks, opp_picks) = if our_side == Side::Blue {
            (state.blue_picks.clone(), state.red_picks.clone())
        } else {
            (state.red_picks.clone(), state.blue_picks.clone())
        };
        let eval_ctx = EvalContext {
            side: our_side,
            phase,
            our_pool,
            opp_pool,
            our_picks,
            opp_picks,
            penalties,
            champion_meta,
            meta: meta_overrides.unwrap_or_else(|| self.meta.clone()),
            phase_weights_blue,
            phase_weights_red,
            synergy_multiplier,
            counter_multiplier,
            flex_retention_weight,
            reveal_cost_weight,
        };
        let mut latest_stats = None;
        let result = iterative_deepening::deepen(
            |depth, handle| {
                let mut params = search_params.clone();
                params.max_depth = depth;
                let (tree, stats) = search_with_stats(&state, &params, &eval_ctx, handle)?;
                latest_stats = Some(stats);
                Ok(SearchResult {
                    score: tree.scores.composite,
                    depth,
                    partial: false,
                    payload: tree,
                })
            },
            search_params.max_depth,
            Duration::from_millis(latency_budget_ms),
            cancel,
        );

        match result {
            Ok(result) => {
                let stats = latest_stats.ok_or_else(|| {
                    EngineError::Internal("search completed without producing stats".into())
                })?;
                Ok(ComputeResponse {
                    tree: result.payload,
                    scenarios: vec![],
                    nodes_evaluated: 0,
                    compute_time_ms: start.elapsed().as_millis() as u64,
                    pruning_rate: 0.0,
                    depth_reached: result.depth,
                    transpositions_found: stats.transpositions_found,
                    forced_branches_dropped: stats.forced_branches_dropped,
                    cancelled: result.partial,
                })
            }
            Err(EngineError::Cancelled) => Err(EngineError::Cancelled),
            Err(err) => Err(err),
        }
    }
}
