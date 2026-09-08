//! Public engine API. The skeleton lives here in Task 7.1; Task 7.2 wires
//! `search` + iterative deepening, Task 7.3 adds scenario extraction.

use crate::cancellation::CancelHandle;
use crate::draft_state::{DraftState, Phase, Side};
use crate::evaluator::{EvalContext, MetaData, PhaseWeightTable};
use crate::iterative_deepening::{self, SearchResult};
use crate::pools::{Penalties, TeamPool};
use crate::role_solver::ChampionMeta;
use crate::scenarios::{extract_scenarios, Scenario};
use crate::search::{search_with_stats, SearchParams, SearchStats, TreeNode};
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
    fn from(err: crate::cancellation::CancelError) -> Self {
        match err {
            crate::cancellation::CancelError::Cancelled => EngineError::Cancelled,
            // The depth is not known at a wake point; `deepen` catches this
            // and returns the last completed depth (or re-tags the error).
            crate::cancellation::CancelError::DeadlineExceeded => EngineError::Timeout(0),
        }
    }
}

/// The iterative-deepening floor for `state`: pair-start roots need depth 2
/// (see `compute`), and the request may only RAISE it. Pure so the policy is
/// testable without a timed search.
pub fn effective_min_completed_depth(state: &DraftState, requested: Option<usize>) -> usize {
    let pair_floor = state
        .current_turn()
        .map(|t| if t.pair_start { 2 } else { 1 })
        .unwrap_or(1);
    pair_floor.max(requested.unwrap_or(0))
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
    /// Optional floor on the depth iterative deepening must complete before
    /// its bail heuristics may return (wire: `config.search.minCompletedDepth`).
    /// Combined with the pair-start floor by `effective_min_completed_depth`;
    /// never overrides the deadline.
    pub min_completed_depth: Option<usize>,
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
    /// Streaming (engine target § 2): true on a per-depth partial handed to
    /// `compute_streaming`'s sink, false on the returned final.
    pub in_progress: bool,
    /// The depth now being searched when `in_progress`; 0 on the final.
    pub depth_in_progress: usize,
    /// The budget or deadline cut the search: `depth_reached` is the last
    /// completed depth (`SearchResult::partial`). Never true on a partial.
    pub budget_hit: bool,
}

impl Engine {
    pub fn new(meta: MetaData, champion_meta: HashMap<String, ChampionMeta>) -> Self {
        crate::rayon_pool::ensure_rayon_pool();
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
        self.compute_streaming(request, cancel, &mut |_| {})
    }

    /// `compute` with a sink for per-depth partials (engine target § 2). The
    /// sink receives a full response (tree, scenarios, stats) for every depth
    /// that completed while a deeper one was starting — see
    /// `iterative_deepening::deepen_with_hook` for exactly when that is. The
    /// returned final is never also sent to the sink.
    pub fn compute_streaming(
        &self,
        request: ComputeRequest,
        cancel: &CancelHandle,
        on_partial: &mut dyn FnMut(ComputeResponse),
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
            min_completed_depth,
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
            fm: None,
        };
        // At pair-start root states, the slot-17-class invariant: a tree with
        // remaining_depth=1 has every pair child hit the rem=0 terminal at the
        // pair's other slot, so `collect_leaves` produces scenarios that are
        // missing the next decision (e.g. R5 after a B4-B5 pair). Ask the
        // deepening loop to complete at least depth 2 from these states even
        // when the budget heuristic would otherwise bail. Capped by max_depth,
        // and the floor yields to the budget deadline (iterative_deepening.rs).
        let min_completed_depth = effective_min_completed_depth(&state, min_completed_depth);

        // One builder for partials and the final. `cancelled` is derived from
        // the handle by the caller (see below); partials are never cancelled.
        let build = |tree: &TreeNode,
                     stats: &SearchStats,
                     depth: usize,
                     in_progress: bool,
                     depth_in_progress: usize,
                     budget_hit: bool|
         -> ComputeResponse {
            let scenarios = extract_scenarios(
                tree,
                &eval_ctx.champion_meta,
                5,
                &state.blue_picks,
                &state.red_picks,
            );
            ComputeResponse {
                tree: tree.clone(),
                scenarios,
                nodes_evaluated: stats.nodes_evaluated,
                compute_time_ms: start.elapsed().as_millis() as u64,
                pruning_rate: if stats.nodes_evaluated + stats.nodes_pruned > 0 {
                    stats.nodes_pruned as f64
                        / (stats.nodes_evaluated + stats.nodes_pruned) as f64
                } else {
                    0.0
                },
                depth_reached: depth,
                transpositions_found: stats.transpositions_found,
                forced_branches_dropped: stats.forced_branches_dropped,
                cancelled: false,
                in_progress,
                depth_in_progress,
                budget_hit,
            }
        };

        let result = iterative_deepening::deepen_with_hook(
            |depth, handle| {
                let mut params = search_params.clone();
                params.max_depth = depth;
                let (tree, stats) = search_with_stats(&state, &params, &eval_ctx, handle)?;
                Ok(SearchResult {
                    score: tree.scores.composite,
                    depth,
                    partial: false,
                    payload: (tree, stats),
                })
            },
            search_params.max_depth,
            Duration::from_millis(latency_budget_ms),
            min_completed_depth,
            cancel,
            |completed: &SearchResult<(TreeNode, SearchStats)>| {
                let (tree, stats) = &completed.payload;
                on_partial(build(tree, stats, completed.depth, true, completed.depth + 1, false));
            },
        );

        match result {
            Ok(result) => {
                let (tree, stats) = result.payload;
                let mut response = build(&tree, &stats, result.depth, false, 0, result.partial);
                // `cancelled` gates the backend's swallow-vs-persist decision and
                // is ONLY true for external supersession: a deadline returns Ok
                // without tripping the handle, an external cancel trips it.
                response.cancelled = cancel.is_cancelled();
                Ok(response)
            }
            Err(EngineError::Cancelled) => Err(EngineError::Cancelled),
            Err(err) => Err(err),
        }
    }
}
