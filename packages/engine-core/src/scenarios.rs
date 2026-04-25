use crate::evaluator::ScoreSet;
use crate::forced_branches::PathStep;
use crate::role_solver::WeightedAssignment;

#[derive(Clone, Debug)]
pub struct Scenario {
    pub name: String,
    pub description: String,
    pub perspective: Perspective,
    pub indicators: Vec<String>,
    pub scores: ScoreSet,
    pub blue_picks: Vec<String>,
    pub red_picks: Vec<String>,
    pub blue_bans: Vec<String>,
    pub red_bans: Vec<String>,
    pub likely_assignments: Vec<WeightedAssignment>,
    pub tree_path: Vec<PathStep>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Perspective {
    Robust,
    Likely,
    OffProfile,
}
