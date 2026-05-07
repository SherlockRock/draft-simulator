//! Trajectory sampling helpers. The bench drives the schedule; this module
//! just packages a snapshot.

use super::pareto::{root_pareto_frontier, ParetoFrontierEntry};
use super::policy::Mcts;
use super::tree::MoveId;
use super::ValueVector;

#[derive(Clone, Debug)]
pub struct TrajectorySample {
    pub elapsed_ms: u128,
    pub iters_completed: u32,
    pub iter_per_sec_window: f64,
    pub root_total_visits: u32,
    pub top1: Option<MoveEntry>,
    pub top3: Vec<MoveEntry>,
    pub top5: Vec<MoveEntry>,
    pub frontier: Vec<ParetoFrontierEntry>,
    pub inherited_visits: u32,
    pub shortlist_size: usize,
}

#[derive(Clone, Debug)]
pub struct MoveEntry {
    pub mv: MoveId,
    pub visits: u32,
    pub mean_value: ValueVector,
}

pub fn capture(mcts: &Mcts, elapsed_ms: u128, iter_per_sec_window: f64) -> TrajectorySample {
    let dist = mcts.root_visit_distribution();
    let to_entry = |(mv, visits, mean): &(MoveId, u32, ValueVector)| MoveEntry {
        mv: mv.clone(),
        visits: *visits,
        mean_value: *mean,
    };
    let total: u32 = dist.iter().map(|(_, v, _)| *v).sum();
    let top1 = dist.first().map(to_entry);
    let top3 = dist.iter().take(3).map(to_entry).collect();
    let top5 = dist.iter().take(5).map(to_entry).collect();
    let frontier = root_pareto_frontier(mcts);
    TrajectorySample {
        elapsed_ms,
        iters_completed: mcts.total_iterations(),
        iter_per_sec_window,
        root_total_visits: total,
        top1,
        top3,
        top5,
        frontier,
        inherited_visits: mcts.inherited_visits_at_reroot(),
        shortlist_size: mcts.root_shortlist_size(),
    }
}

pub fn entries_label(entries: &[MoveEntry]) -> String {
    entries
        .iter()
        .map(|e| format!("{}:{}", e.mv.label(), e.visits))
        .collect::<Vec<_>>()
        .join("|")
}

pub fn frontier_label(frontier: &[ParetoFrontierEntry]) -> String {
    frontier
        .iter()
        .map(|f| format!("{}:{}", f.mv.label(), f.visits))
        .collect::<Vec<_>>()
        .join("|")
}

pub fn frontier_visits_summary(frontier: &[ParetoFrontierEntry]) -> String {
    if frontier.is_empty() {
        return String::new();
    }
    let visits: Vec<u32> = frontier.iter().map(|f| f.visits).collect();
    let min = *visits.iter().min().unwrap_or(&0);
    let max = *visits.iter().max().unwrap_or(&0);
    let avg = visits.iter().sum::<u32>() as f64 / visits.len() as f64;
    format!("min={}|max={}|avg={:.1}", min, max, avg)
}
