use crate::cancellation::{ensure_not_cancelled, CancelError, CancelHandle};
use crate::draft_state::{ActionType, DraftState, Phase, Side};
use crate::evaluator::ScoreSet;
use crate::transposition::TranspositionCache;

#[derive(Clone, Debug)]
pub struct SearchParams {
    pub branch_width: usize,
    pub max_depth: usize,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            branch_width: 5,
            max_depth: 6,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TreeNode {
    pub champion_ids: Vec<String>,
    pub scores: ScoreSet,
    pub side: Option<Side>,
    pub slots: Vec<usize>,
    pub action_type: ActionType,
    pub phase: Phase,
    pub user_injected: bool,
    pub children: Vec<TreeNode>,
}

pub fn search(
    state: &DraftState,
    params: &SearchParams,
    cancel: &CancelHandle,
) -> Result<TreeNode, CancelError> {
    let mut cache = TranspositionCache::new();
    search_recursive(state, params, params.max_depth, cancel, &mut cache)
}

fn search_recursive(
    state: &DraftState,
    _params: &SearchParams,
    remaining_depth: usize,
    cancel: &CancelHandle,
    _cache: &mut TranspositionCache,
) -> Result<TreeNode, CancelError> {
    ensure_not_cancelled(cancel)?;

    let turn = state.current_turn();
    if turn.is_none() || remaining_depth == 0 {
        // Terminal or depth-bound: produce a leaf node with default score.
        // Branch expansion (singles + pair via pair_filter) lands in subsequent tasks.
        return Ok(TreeNode {
            champion_ids: vec![],
            scores: ScoreSet::default(),
            side: turn.map(|t| t.side),
            slots: vec![],
            action_type: turn.map(|t| t.action_type).unwrap_or(ActionType::Pick),
            phase: turn.map(|t| t.phase).unwrap_or(Phase::Pick2),
            user_injected: false,
            children: vec![],
        });
    }

    // Skeleton: produce a leaf at the current decision point. Tasks 5.5–5.8 expand.
    let t = turn.expect("guarded above");
    Ok(TreeNode {
        champion_ids: vec![],
        scores: ScoreSet::default(),
        side: Some(t.side),
        slots: vec![state.turn_index()],
        action_type: t.action_type,
        phase: t.phase,
        user_injected: false,
        children: vec![],
    })
}
