//! Spike-only static-eval prior. Used to shortlist root candidates before MCTS
//! sees them. Mirrors the *shape* of `evaluator::score_pick` (comp-strength
//! winrate component + role-coverage marginal gain) but skips `EvalContext` —
//! it operates only on the existing `SpikeFixture`'s meta + winrates.

use crate::coverage::coverage_marginal_gain;
use crate::draft_state::{is_taken, ActionType, DraftState, Side};
use crate::role_solver::position_factor;

use super::tree::MoveId;
use super::SpikeFixture;

#[derive(Clone, Copy, Debug)]
pub struct ShortlistInput {
    pub side: Side,
    pub action_type: ActionType,
}

const ROLES: [crate::pools::Role; 5] = [
    crate::pools::Role::Top,
    crate::pools::Role::Jungle,
    crate::pools::Role::Middle,
    crate::pools::Role::Adc,
    crate::pools::Role::Support,
];

/// Score every legal champion at this state. Returns (move, score) pairs,
/// unsorted. Caller picks top-K via `shortlist_top_k`.
pub fn compute_prior_scores(
    state: &DraftState,
    fixture: &SpikeFixture,
    input: ShortlistInput,
) -> Vec<(MoveId, f64)> {
    let is_pick = matches!(input.action_type, ActionType::Pick);
    let our_picks: &[String] = match (input.action_type, input.side) {
        (ActionType::Pick, Side::Blue) => &state.blue_picks,
        (ActionType::Pick, Side::Red) => &state.red_picks,
        (ActionType::Ban, Side::Blue) => &state.red_picks,
        (ActionType::Ban, Side::Red) => &state.blue_picks,
    };

    fixture
        .all_champions
        .iter()
        .filter(|c| !is_taken(c, state))
        .map(|c| {
            let wr = fixture.winrates.get(c).copied().unwrap_or(0.5);
            let cov_gain = coverage_marginal_gain(our_picks, c, &fixture.meta);

            // Best position factor across roles — proxy for "this champ
            // contributes to the team's role-needs" before assignment.
            let mut best_pos = 0.0f64;
            if let Some(meta) = fixture.meta.get(c) {
                for r in &ROLES {
                    let f = position_factor(*r, &meta.positions);
                    if f > best_pos {
                        best_pos = f;
                    }
                }
            }

            // Composite shape mirrors evaluator::score_pick weights at default:
            // comp_strength (winrate) + role_coverage marginal gain. We use
            // best_pos as an additional weak signal so role-locked champs at
            // unrelated positions don't outrank role-relevant flex picks.
            let score = wr + 0.5 * cov_gain + 0.05 * best_pos;
            let mv = MoveId { champion: c.clone(), is_pick };
            (mv, score)
        })
        .collect()
}

/// Top-K candidates by prior score, sorted descending.
pub fn shortlist_top_k(
    state: &DraftState,
    fixture: &SpikeFixture,
    input: ShortlistInput,
    k: usize,
) -> Vec<MoveId> {
    let mut scored = compute_prior_scores(state, fixture, input);
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(k).map(|(mv, _)| mv).collect()
}
