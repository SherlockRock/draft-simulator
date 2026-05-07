//! v4 prior. Uses production `evaluator::score_pick` against an `EvalContext`
//! synthesized from the spike fixture (see `eval_ctx::build_spike_eval_ctx`).
//!
//! v4 adds pair-aware shortlisting: at `pair_start` turns, the shortlist
//! enumerates pair candidates via `pair_filter::seed_pair_candidates` and
//! ranks them by additive single-score composite (mirroring production
//! `search.rs::expand_pair::build_pair_candidates`). At non-pair turns, the
//! prior emits singletons exactly as v3.

use crate::coverage::missing_roles;
use crate::draft_state::{is_taken, ActionType, DraftState, Phase, Side};
use crate::evaluator::{score_pick, EvalContext};
use crate::feasibility::can_complete_roles;
use crate::pair_filter::{seed_pair_candidates, PairFilterConfig};
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

/// Per-pair-turn cap: number of pair candidates `seed_pair_candidates` will
/// emit at a pair_start turn. Matches v3 AB's `pair_branch_width=200` so the
/// pair candidate sets are apples-to-apples between MCTS and AB.
pub(crate) const PAIR_BRANCH_WIDTH: usize = 200;

/// Per-role bucket size for Pick2 role-coverage seeding. Matches production.
const PER_ROLE_TOP: usize = 8;

/// Top-K global singles seed for bucket-1 of seed_pair_candidates.
const SINGLE_TOP_K: usize = 32;

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
/// Returns (champion, score) pairs, unsorted. Excludes already-taken champs.
fn score_singles(
    state: &DraftState,
    fixture: &SpikeFixture,
    ctx: &EvalContext,
    action_type: ActionType,
) -> Vec<(String, f64)> {
    fixture
        .all_champions
        .iter()
        .filter(|c| !is_taken(c, state))
        .map(|c| {
            let role = primary_role(c, &fixture.meta);
            let s = score_pick(c, role, state, ctx, action_type).composite;
            (c.clone(), s)
        })
        .collect()
}

/// Top-K champions in `role_pool` by score, scored at `role`.
fn top_k_for_role_spike(
    role: Role,
    state: &DraftState,
    fixture: &SpikeFixture,
    ctx: &EvalContext,
    action_type: ActionType,
    k: usize,
) -> Vec<String> {
    let mut scored: Vec<(String, f64)> = fixture
        .all_champions
        .iter()
        .filter(|c| !is_taken(c, state))
        .filter(|c| {
            fixture
                .meta
                .get(*c)
                .map(|m| position_factor(role, &m.positions) >= 0.4)
                .unwrap_or(false)
        })
        .map(|c| {
            let s = score_pick(c, role, state, ctx, action_type).composite;
            (c.clone(), s)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k);
    scored.into_iter().map(|(c, _)| c).collect()
}

/// Enumerate pair candidates at a `pair_start` turn. Mirrors the production
/// `search.rs::expand_pair` model:
///   1. Score every legal single via `score_pick` (perspective-swapped).
///   2. If Pick2 with ≥2 missing roles: build per-role top-K buckets.
///   3. Run `seed_pair_candidates` with bucket-1 (top-K globals) +
///      bucket-2 (role pairs). No forced_partner in the spike.
///   4. Feasibility-filter the pairs (push both, can_complete_roles).
///
/// Returns Vec of (first, second, additive_composite). `first ≤ second` by
/// canonical alphabetical order. The additive composite is the proxy used
/// by production for pair ranking — it ignores marginal-gain order.
pub(crate) fn enumerate_pair_candidates(
    state: &DraftState,
    fixture: &SpikeFixture,
    ctx: &EvalContext,
    action_type: ActionType,
    side: Side,
    phase: Phase,
) -> Vec<(String, String, f64)> {
    let mut scored_singles = score_singles(state, fixture, ctx, action_type);
    // seed_pair_candidates' bucket-1 expects DESC-sorted singles.
    scored_singles
        .sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Build role_buckets if Pick2 with ≥2 missing roles. `our_picks` come
    // from `state` per side.
    let our_picks: &[String] = match side {
        Side::Blue => &state.blue_picks,
        Side::Red => &state.red_picks,
    };
    let role_top_lists: Vec<Vec<String>> = if phase == Phase::Pick2 {
        let missing = missing_roles(our_picks, &fixture.meta, 0.9);
        if missing.len() >= 2 {
            missing
                .iter()
                .map(|role| {
                    top_k_for_role_spike(*role, state, fixture, ctx, action_type, PER_ROLE_TOP)
                })
                .collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // Pre-build owned string lookups so refs into them outlive the call to
    // seed_pair_candidates.
    let scored_refs: Vec<(&str, f64)> = scored_singles
        .iter()
        .map(|(s, f)| (s.as_str(), *f))
        .collect();
    let role_buckets_refs: Vec<(Vec<&str>, Vec<&str>)> = {
        let mut out: Vec<(Vec<&str>, Vec<&str>)> = Vec::new();
        for i in 0..role_top_lists.len() {
            for j in (i + 1)..role_top_lists.len() {
                let a: Vec<&str> = role_top_lists[i].iter().map(String::as_str).collect();
                let b: Vec<&str> = role_top_lists[j].iter().map(String::as_str).collect();
                out.push((a, b));
            }
        }
        out
    };

    let per_role_top = if role_buckets_refs.is_empty() { 0 } else { PER_ROLE_TOP };
    let cfg = PairFilterConfig {
        single_top_k: SINGLE_TOP_K,
        per_role_top,
        // Oversample bucket-1 4x then truncate by additive score below.
        max_pairs: (PAIR_BRANCH_WIDTH * 4).max(PAIR_BRANCH_WIDTH),
    };
    let pairs = seed_pair_candidates(&scored_refs, &role_buckets_refs, None, &cfg);

    // Score each pair as additive composite (matches production proxy).
    let single_lookup: HashMap<&str, f64> = scored_refs.iter().copied().collect();
    let mut scored_pairs: Vec<(String, String, f64)> = pairs
        .into_iter()
        .map(|p| {
            let v = single_lookup.get(p.first.as_str()).copied().unwrap_or(0.0)
                + single_lookup.get(p.second.as_str()).copied().unwrap_or(0.0);
            (p.first, p.second, v)
        })
        .collect();
    scored_pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    scored_pairs.truncate(PAIR_BRANCH_WIDTH);

    // Feasibility-filter: push both, ensure remaining picks can fill roles.
    use crate::draft_state::picks_remaining;
    let pool_full: Vec<String> = fixture
        .all_champions
        .iter()
        .filter(|c| !is_taken(c, state))
        .cloned()
        .collect();
    let our_locked: Vec<String> = our_picks.to_vec();
    let remaining = picks_remaining(state, side).saturating_sub(2);
    scored_pairs.retain(|(first, second, _)| {
        let cand_pool: Vec<String> = pool_full
            .iter()
            .filter(|c| c.as_str() != first.as_str() && c.as_str() != second.as_str())
            .cloned()
            .collect();
        let mut hypo_locked = our_locked.clone();
        hypo_locked.push(first.clone());
        hypo_locked.push(second.clone());
        can_complete_roles(&hypo_locked, &cand_pool, remaining, &fixture.meta)
    });

    scored_pairs
}

/// Score every legal champion at this state via production `score_pick`.
/// Returns (move, score) pairs, unsorted. Caller picks top-K via
/// `shortlist_top_k`. `ctx` MUST be built from the same fixture used to
/// drive MCTS — see `eval_ctx::build_spike_eval_ctx`.
///
/// At pair_start turns, returns (pair MoveId, additive_score) pairs. The
/// caller's `ctx.side` should match the turn-side perspective for the
/// scores to be meaningful.
pub fn compute_prior_scores(
    state: &DraftState,
    fixture: &SpikeFixture,
    ctx: &EvalContext,
    input: ShortlistInput,
) -> Vec<(MoveId, f64)> {
    let is_pick = matches!(input.action_type, ActionType::Pick);
    let pair_start = state
        .current_turn()
        .map(|t| t.pair_start)
        .unwrap_or(false);
    let phase = state
        .current_turn()
        .map(|t| t.phase)
        .unwrap_or(Phase::Pick2);

    if is_pick && pair_start {
        let pairs = enumerate_pair_candidates(state, fixture, ctx, input.action_type, input.side, phase);
        return pairs
            .into_iter()
            .map(|(first, second, score)| (MoveId::pair(first, second), score))
            .collect();
    }

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
