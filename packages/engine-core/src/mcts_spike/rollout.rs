//! Rollout policies. Both respect role-completion feasibility for picks.
//! Bans are NOT feasibility-checked (matches production: ban feasibility
//! only matters when a ban would brick the picking side, which is rare and
//! a v2 concern for the spike).

use crate::draft_state::{is_taken, picks_remaining, ActionType, DraftState, Side, TURN_SEQUENCE};

use super::feasibility_cache::FeasibilityCache;
use super::rng::SplitMix64;
use super::SpikeFixture;

#[derive(Clone, Copy, Debug)]
pub enum RolloutPolicy {
    UniformFeasible,
    WinrateWeightedFeasible,
}

#[derive(Clone, Copy, Debug)]
pub enum FeasibilityMode {
    Uncached, // calls engine_core::feasibility::can_complete_roles each step
    Cached,   // calls FeasibilityCache::can_complete_roles_cached
}

/// Plays out from `state` to terminal, returns the completed DraftState.
/// Caller scores it via `terminal_score`.
pub fn play_to_terminal(
    state: &mut DraftState,
    fixture: &SpikeFixture,
    cache: &FeasibilityCache,
    policy: RolloutPolicy,
    fmode: FeasibilityMode,
    rng: &mut SplitMix64,
) {
    while let Some(turn) = state.current_turn() {
        // Build the legal-and-not-taken candidate list.
        let mut candidates: Vec<&str> = fixture
            .all_champions
            .iter()
            .filter(|c| !is_taken(c, state))
            .map(|s| s.as_str())
            .collect();

        if candidates.is_empty() {
            // Should not happen with a real fixture, but guard anyway.
            return;
        }

        // For picks, restrict to feasibility-preserving candidates.
        if turn.action_type == ActionType::Pick {
            let locked: Vec<String> = match turn.side {
                Side::Blue => state.blue_picks.clone(),
                Side::Red => state.red_picks.clone(),
            };
            let remaining_after = picks_remaining(state, turn.side).saturating_sub(1);

            candidates.retain(|cand| {
                let mut hypo_locked = locked.clone();
                hypo_locked.push((*cand).to_string());
                let pool: Vec<String> = fixture
                    .all_champions
                    .iter()
                    .filter(|c| !is_taken(c, state) && c.as_str() != *cand)
                    .cloned()
                    .collect();
                check_feasible(&hypo_locked, &pool, remaining_after, fixture, cache, fmode)
            });

            if candidates.is_empty() {
                // No feasible pick — should not happen if we got here legally,
                // but guard. Fall back to any non-taken candidate.
                candidates = fixture
                    .all_champions
                    .iter()
                    .filter(|c| !is_taken(c, state))
                    .map(|s| s.as_str())
                    .collect();
                if candidates.is_empty() {
                    return;
                }
            }
        }

        let chosen = select_candidate(&candidates, fixture, policy, rng);
        apply_action(state, &chosen, turn.side, turn.action_type);
    }
}

fn select_candidate(
    candidates: &[&str],
    fixture: &SpikeFixture,
    policy: RolloutPolicy,
    rng: &mut SplitMix64,
) -> String {
    match policy {
        RolloutPolicy::UniformFeasible => {
            let idx = rng.gen_range(candidates.len());
            candidates[idx].to_string()
        }
        RolloutPolicy::WinrateWeightedFeasible => {
            let weights: Vec<f64> = candidates
                .iter()
                .map(|c| {
                    let wr = fixture.winrates.get(*c).copied().unwrap_or(0.5);
                    // Soft weighting — temperature 8.0 sharpens toward higher
                    // winrates without being deterministic. Spike default;
                    // can be retuned during measurement.
                    (wr * 8.0).exp()
                })
                .collect();
            let total: f64 = weights.iter().sum();
            let mut roll = rng.gen_unit() * total;
            for (i, w) in weights.iter().enumerate() {
                roll -= w;
                if roll <= 0.0 {
                    return candidates[i].to_string();
                }
            }
            candidates[candidates.len() - 1].to_string()
        }
    }
}

fn apply_action(state: &mut DraftState, champion: &str, side: Side, action_type: ActionType) {
    match (side, action_type) {
        (Side::Blue, ActionType::Ban) => state.blue_bans.push(champion.to_string()),
        (Side::Red, ActionType::Ban) => state.red_bans.push(champion.to_string()),
        (Side::Blue, ActionType::Pick) => state.blue_picks.push(champion.to_string()),
        (Side::Red, ActionType::Pick) => state.red_picks.push(champion.to_string()),
    }
}

fn check_feasible(
    locked: &[String],
    pool: &[String],
    remaining: usize,
    fixture: &SpikeFixture,
    cache: &FeasibilityCache,
    fmode: FeasibilityMode,
) -> bool {
    match fmode {
        FeasibilityMode::Uncached => crate::feasibility::can_complete_roles(
            locked,
            pool,
            remaining,
            &fixture.meta,
        ),
        FeasibilityMode::Cached => cache.can_complete_roles_cached(locked, pool, remaining),
    }
}

// Suppress unused-import warnings until policy.rs uses these types.
#[allow(dead_code)]
fn _silence_turn_sequence() {
    let _ = TURN_SEQUENCE.len();
}
