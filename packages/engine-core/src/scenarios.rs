use crate::draft_state::{ActionType, Side};
use crate::evaluator::ScoreSet;
use crate::forced_branches::PathStep;
use crate::role_solver::WeightedAssignment;
use crate::search::TreeNode;

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

#[derive(Clone, Debug)]
pub struct LeafInfo {
    pub path: Vec<PathStep>,
    pub blue_picks: Vec<String>,
    pub red_picks: Vec<String>,
    pub blue_bans: Vec<String>,
    pub red_bans: Vec<String>,
    pub scores: ScoreSet,
}

pub fn collect_leaves(tree: &TreeNode) -> Vec<LeafInfo> {
    fn walk(
        node: &TreeNode,
        path: &mut Vec<PathStep>,
        blue_picks: &mut Vec<String>,
        red_picks: &mut Vec<String>,
        blue_bans: &mut Vec<String>,
        red_bans: &mut Vec<String>,
        leaves: &mut Vec<LeafInfo>,
    ) {
        match (node.side, node.action_type) {
            (Some(Side::Blue), ActionType::Pick) => {
                blue_picks.extend(node.champion_ids.iter().cloned());
            }
            (Some(Side::Red), ActionType::Pick) => {
                red_picks.extend(node.champion_ids.iter().cloned());
            }
            (Some(Side::Blue), ActionType::Ban) => {
                blue_bans.extend(node.champion_ids.iter().cloned());
            }
            (Some(Side::Red), ActionType::Ban) => {
                red_bans.extend(node.champion_ids.iter().cloned());
            }
            (None, _) => {}
        }

        if node.children.is_empty() {
            leaves.push(LeafInfo {
                path: path.clone(),
                blue_picks: blue_picks.clone(),
                red_picks: red_picks.clone(),
                blue_bans: blue_bans.clone(),
                red_bans: red_bans.clone(),
                scores: node.scores,
            });
        } else {
            for child in &node.children {
                path.push(PathStep {
                    slot: child.slots.first().copied().unwrap_or(0),
                    champion_ids: child.champion_ids.clone(),
                });
                walk(
                    child,
                    path,
                    blue_picks,
                    red_picks,
                    blue_bans,
                    red_bans,
                    leaves,
                );
                path.pop();
            }
        }

        match (node.side, node.action_type) {
            (Some(Side::Blue), ActionType::Pick) => {
                blue_picks.truncate(blue_picks.len().saturating_sub(node.champion_ids.len()));
            }
            (Some(Side::Red), ActionType::Pick) => {
                red_picks.truncate(red_picks.len().saturating_sub(node.champion_ids.len()));
            }
            (Some(Side::Blue), ActionType::Ban) => {
                blue_bans.truncate(blue_bans.len().saturating_sub(node.champion_ids.len()));
            }
            (Some(Side::Red), ActionType::Ban) => {
                red_bans.truncate(red_bans.len().saturating_sub(node.champion_ids.len()));
            }
            (None, _) => {}
        }
    }

    let mut leaves = Vec::new();
    let mut path = Vec::new();
    let mut blue_picks = Vec::new();
    let mut red_picks = Vec::new();
    let mut blue_bans = Vec::new();
    let mut red_bans = Vec::new();

    for child in &tree.children {
        path.push(PathStep {
            slot: child.slots.first().copied().unwrap_or(0),
            champion_ids: child.champion_ids.clone(),
        });
        walk(
            child,
            &mut path,
            &mut blue_picks,
            &mut red_picks,
            &mut blue_bans,
            &mut red_bans,
            &mut leaves,
        );
        path.pop();
    }

    if tree.children.is_empty() {
        leaves.push(LeafInfo {
            path: Vec::new(),
            blue_picks: Vec::new(),
            red_picks: Vec::new(),
            blue_bans: Vec::new(),
            red_bans: Vec::new(),
            scores: tree.scores,
        });
    }

    leaves
}
