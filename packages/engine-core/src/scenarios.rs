use crate::draft_state::{ActionType, Side};
use crate::evaluator::ScoreSet;
use crate::forced_branches::PathStep;
use crate::role_solver::{self, ChampionMeta, WeightedAssignment};
use crate::search::TreeNode;
use std::collections::HashMap;

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

pub fn feature_vector(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> [f64; 7] {
    if picks.is_empty() {
        return [0.0; 7];
    }

    let mut vector = [0.0; 7];
    let mut count = 0.0;

    for pick in picks {
        let Some(champion) = meta.get(pick) else {
            continue;
        };
        vector[0] += champion.damage_profile.physical;
        vector[1] += champion.damage_profile.magic;
        vector[2] += champion.scaling_profile.early;
        vector[3] += champion.scaling_profile.mid;
        vector[4] += champion.scaling_profile.late;
        vector[5] += champion.cc_profile.engage_quality;
        vector[6] += champion.cc_profile.peel_quality;
        count += 1.0;
    }

    if count == 0.0 {
        return [0.0; 7];
    }

    for value in &mut vector {
        *value /= count;
    }

    vector
}

pub fn label_scenario(picks: &[String], meta: &HashMap<String, ChampionMeta>) -> String {
    let vector = feature_vector(picks, meta);
    let mut traits = Vec::with_capacity(3);

    if vector[0] > 0.6 {
        traits.push("Physical Heavy");
    } else if vector[1] > 0.6 {
        traits.push("Magic Heavy");
    } else {
        traits.push("Mixed Damage");
    }

    if vector[2] > 0.6 {
        traits.push("Early Game");
    } else if vector[4] > 0.6 {
        traits.push("Late Scaling");
    } else {
        traits.push("Mid Game");
    }

    if vector[5] > 0.4 {
        traits.push("Hard Engage");
    } else if vector[6] > 0.4 {
        traits.push("Peel Focused");
    }

    traits.into_iter().take(2).collect::<Vec<_>>().join(" / ")
}

fn vector_distance(a: &[f64; 7], b: &[f64; 7]) -> f64 {
    let mut sum = 0.0;
    for (left, right) in a.iter().zip(b.iter()) {
        let diff = left - right;
        sum += diff * diff;
    }
    sum.sqrt()
}

pub fn extract_scenarios(
    tree: &TreeNode,
    champion_meta: &HashMap<String, ChampionMeta>,
    max_scenarios: usize,
) -> Vec<Scenario> {
    let leaves = collect_leaves(tree);
    if leaves.is_empty() || max_scenarios == 0 {
        return Vec::new();
    }

    let mut featured: Vec<(LeafInfo, [f64; 7])> = leaves
        .into_iter()
        .map(|leaf| {
            let vector = feature_vector(&leaf.blue_picks, champion_meta);
            (leaf, vector)
        })
        .collect();
    featured.sort_by(|(left_leaf, _), (right_leaf, _)| {
        right_leaf.scores.composite.total_cmp(&left_leaf.scores.composite)
    });

    let mut selected = vec![featured.remove(0)];

    while selected.len() < max_scenarios && !featured.is_empty() {
        let (farthest_idx, _) = featured
            .iter()
            .enumerate()
            .map(|(idx, (_, vector))| {
                let min_distance = selected
                    .iter()
                    .map(|(_, selected_vector)| vector_distance(vector, selected_vector))
                    .fold(f64::INFINITY, f64::min);
                (idx, min_distance)
            })
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .expect("featured is non-empty");
        selected.push(featured.remove(farthest_idx));
    }

    selected
        .into_iter()
        .enumerate()
        .map(|(idx, (leaf, _))| {
            let likely_assignments = if leaf.blue_picks.len() == 5
                && leaf
                    .blue_picks
                    .iter()
                    .all(|pick| champion_meta.contains_key(pick))
            {
                let picks: Vec<&str> = leaf.blue_picks.iter().map(String::as_str).collect();
                role_solver::solve(&picks, champion_meta)
            } else {
                Vec::new()
            };

            Scenario {
                name: label_scenario(&leaf.blue_picks, champion_meta),
                description: format!(
                    "{} vs {}",
                    leaf.blue_picks.join(", "),
                    leaf.red_picks.join(", ")
                ),
                perspective: if idx == 0 {
                    Perspective::Robust
                } else {
                    Perspective::Likely
                },
                indicators: Vec::new(),
                scores: leaf.scores,
                blue_picks: leaf.blue_picks,
                red_picks: leaf.red_picks,
                blue_bans: leaf.blue_bans,
                red_bans: leaf.red_bans,
                likely_assignments,
                tree_path: leaf.path,
            }
        })
        .collect()
}
