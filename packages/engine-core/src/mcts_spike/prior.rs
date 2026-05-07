//! v3 prior. Uses production `evaluator::score_pick` against an `EvalContext`
//! synthesized from the spike fixture (see `eval_ctx::build_spike_eval_ctx`).
//! The shortlist's top-K is, by construction, AB's top-K minus pair-pick
//! aggregation effects — that's the v3 alignment fix.

use crate::draft_state::{is_taken, ActionType, DraftState, Side};
use crate::evaluator::{score_pick, EvalContext};
use crate::pools::Role;
use crate::role_solver::{position_factor, ChampionMeta};
use std::collections::HashMap;

use super::tree::MoveId;
use super::SpikeFixture;

#[derive(Clone, Copy, Debug)]
pub struct ShortlistInput {
    pub side: Side,
    pub action_type: ActionType,
}

const ROLES: [Role; 5] = [
    Role::Top,
    Role::Jungle,
    Role::Middle,
    Role::Adc,
    Role::Support,
];

/// Pick the role to score `champion` at: their highest-`position_factor` role.
/// Mirrors how `search.rs` picks a primary role for `score_pick`. Returns
/// `Role::Top` as a safe default if the champion has no metadata.
fn primary_role(champion: &str, meta: &HashMap<String, ChampionMeta>) -> Role {
    let Some(m) = meta.get(champion) else {
        return Role::Top;
    };
    let mut best_role = Role::Top;
    let mut best_factor = -1.0f64;
    for r in &ROLES {
        let f = position_factor(*r, &m.positions);
        if f > best_factor {
            best_factor = f;
            best_role = *r;
        }
    }
    best_role
}

/// Score every legal champion at this state via production `score_pick`.
/// Returns (move, score) pairs, unsorted. Caller picks top-K via
/// `shortlist_top_k`. `ctx` MUST be built from the same fixture used to
/// drive MCTS — see `eval_ctx::build_spike_eval_ctx`.
pub fn compute_prior_scores(
    state: &DraftState,
    fixture: &SpikeFixture,
    ctx: &EvalContext,
    input: ShortlistInput,
) -> Vec<(MoveId, f64)> {
    let is_pick = matches!(input.action_type, ActionType::Pick);
    fixture
        .all_champions
        .iter()
        .filter(|c| !is_taken(c, state))
        .map(|c| {
            let role = primary_role(c, &fixture.meta);
            let scores = score_pick(c, role, state, ctx, input.action_type);
            let mv = MoveId::single(c.clone(), is_pick);
            (mv, scores.composite)
        })
        .collect()
}

/// Top-K candidates by prior score, sorted descending.
pub fn shortlist_top_k(
    state: &DraftState,
    fixture: &SpikeFixture,
    ctx: &EvalContext,
    input: ShortlistInput,
    k: usize,
) -> Vec<MoveId> {
    let mut scored = compute_prior_scores(state, fixture, ctx, input);
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(k).map(|(mv, _)| mv).collect()
}
