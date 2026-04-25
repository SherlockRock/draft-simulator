//! Public engine API. The skeleton lives here in Task 7.1; Task 7.2 wires
//! `search` + iterative deepening, Task 7.3 adds scenario extraction.

use crate::cancellation::CancelHandle;
use crate::draft_state::{ActionType, DraftState, Phase, Side};
use crate::evaluator::{MetaData, PhaseWeightTable, ScoreSet};
use crate::pools::{Penalties, TeamPool};
use crate::role_solver::ChampionMeta;
use crate::scenarios::Scenario;
use crate::search::{SearchParams, TreeNode};
use std::collections::HashMap;

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
        let _ = (
            request,
            &self.meta,
            &self.champion_meta,
            cancel,
        );
        Ok(ComputeResponse {
            tree: TreeNode {
                champion_ids: vec![],
                scores: ScoreSet::default(),
                side: None,
                slots: vec![],
                action_type: ActionType::Pick,
                phase: Phase::Ban1,
                user_injected: false,
                children: vec![],
            },
            scenarios: vec![],
            nodes_evaluated: 0,
            compute_time_ms: 0,
            pruning_rate: 0.0,
            depth_reached: 0,
            transpositions_found: 0,
            forced_branches_dropped: 0,
            cancelled: cancel.is_cancelled(),
        })
    }
}
