//! Pareto frontier extraction over the 3-axis ValueVector. The frontier is
//! computed at the root only; selection still uses scalar UCT internally.

use super::policy::{Mcts, VisitedSubtree};
use super::tree::MoveId;
use super::ValueVector;
use crate::draft_state::Side;

#[derive(Clone, Debug)]
pub struct ParetoFrontierEntry {
    pub mv: MoveId,
    pub visits: u32,
    pub mean_value: ValueVector,
}

/// Non-dominated children of `mcts.active_root`, sorted by visits descending.
/// Children with zero visits are dropped (no estimate yet).
pub fn root_pareto_frontier(mcts: &Mcts) -> Vec<ParetoFrontierEntry> {
    let dist = mcts.root_visit_distribution();
    let candidates: Vec<ParetoFrontierEntry> = dist
        .into_iter()
        .filter(|(_, visits, _)| *visits > 0)
        .map(|(mv, visits, mean_value)| ParetoFrontierEntry { mv, visits, mean_value })
        .collect();
    extract_frontier(&candidates)
}

/// Pure dominance filter — testable in isolation.
pub fn extract_frontier(entries: &[ParetoFrontierEntry]) -> Vec<ParetoFrontierEntry> {
    let mut frontier: Vec<ParetoFrontierEntry> = Vec::new();
    for entry in entries {
        let dominated_by_existing = frontier
            .iter()
            .any(|f| f.mean_value.dominates(&entry.mean_value));
        if dominated_by_existing {
            continue;
        }
        // Drop existing members the new entry now dominates.
        frontier.retain(|f| !entry.mean_value.dominates(&f.mean_value));
        frontier.push(entry.clone());
    }
    frontier.sort_by(|a, b| b.visits.cmp(&a.visits));
    frontier
}

/// Minimum visits across eligible (non-stub) siblings required to compute a
/// Pareto frontier. Below this, sibling vectors are too noisy to compare.
pub const MIN_PARETO_VISITS: u32 = 16;

/// Sibling-frontier membership across the 3-axis `ValueVector`.
///
/// Returns a vector parallel to `siblings`:
/// - `Some(true)` — eligible sibling, on the frontier.
/// - `Some(false)` — eligible sibling, dominated; OR a stub (always Some(false)
///   when the gate passes, or when there are fewer than 2 eligible siblings).
/// - `None` — gate failed: < 2 non-stub eligible siblings, or min(visits across
///   eligible) < `MIN_PARETO_VISITS`. Applied only to non-stub siblings.
///
/// `parent_side_to_move` orients the dominance check: blue maximizes, red
/// minimizes (since `ValueVector` is `blue - red`).
pub fn frontier_membership(
    siblings: &[VisitedSubtree],
    parent_side_to_move: Side,
) -> Vec<Option<bool>> {
    let eligible_idx: Vec<usize> = siblings
        .iter()
        .enumerate()
        .filter_map(|(i, s)| if !s.is_untried_stub { Some(i) } else { None })
        .collect();

    let gate_passes = if eligible_idx.len() < 2 {
        false
    } else {
        let min_v = eligible_idx
            .iter()
            .map(|i| siblings[*i].visits)
            .min()
            .unwrap();
        min_v >= MIN_PARETO_VISITS
    };

    if !gate_passes {
        return siblings
            .iter()
            .map(|s| if s.is_untried_stub { Some(false) } else { None })
            .collect();
    }

    // Orient: negate for red so dominance-by-max works for both sides.
    let oriented: Vec<ValueVector> = eligible_idx
        .iter()
        .map(|i| {
            let v = siblings[*i].mean_value;
            if parent_side_to_move == Side::Red { v.neg() } else { v }
        })
        .collect();

    // For each eligible sibling, on-frontier iff no other eligible sibling dominates it.
    let mut on_frontier = vec![false; eligible_idx.len()];
    for idx_in_eligible in 0..eligible_idx.len() {
        let mut dominated = false;
        for other_idx_in_eligible in 0..eligible_idx.len() {
            if idx_in_eligible == other_idx_in_eligible {
                continue;
            }
            if oriented[other_idx_in_eligible].dominates(&oriented[idx_in_eligible]) {
                dominated = true;
                break;
            }
        }
        on_frontier[idx_in_eligible] = !dominated;
    }

    // Map back to siblings-shaped result.
    let mut out: Vec<Option<bool>> =
        siblings.iter().map(|_| Some(false)).collect();
    for (idx_in_eligible, &sib_idx) in eligible_idx.iter().enumerate() {
        out[sib_idx] = Some(on_frontier[idx_in_eligible]);
    }
    out
}
