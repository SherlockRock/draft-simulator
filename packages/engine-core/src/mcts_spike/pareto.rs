//! Pareto frontier extraction over the 3-axis ValueVector. The frontier is
//! computed at the root only; selection still uses scalar UCT internally.

use super::policy::Mcts;
use super::tree::MoveId;
use super::ValueVector;

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
