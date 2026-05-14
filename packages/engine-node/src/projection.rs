//! Projects between protocol_types::EngineRequest/Response (the wire shape, JSON-shaped
//! via typify-generated structs) and engine-core's internal ComputeRequest/Response.
//!
//! Drops in v1: opponentModel, playerModel, config.profile, request.protocolVersion,
//! request.requestId. The internal compute path doesn't read them yet.

use std::collections::HashMap;

use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::engine::{ComputeRequest, ComputeResponse, EngineError};
use engine_core::evaluator::{PhaseWeightTable, PhaseWeights, ScoreSet};
use engine_core::forced_branches::{ForcedBranch, ForcedMode, PathStep};
use engine_core::pools::{Penalties, RolePoolMap, TeamPool};
use engine_core::role_solver::{ChampionMeta, RoleAssignment, WeightedAssignment};
use engine_core::scenarios::{Perspective, Scenario};
use engine_core::search::{SearchParams, TreeNode};

use engine_core::protocol_types as proto;

pub const PROTOCOL_VERSION: &str = "1.0.0";
pub const ENGINE_ID: &str = "firstpick/v1.0.0";

// ---- Request: protocol → internal ComputeRequest ---------------------------

pub fn request_to_core(
    req: &proto::EngineRequest,
    champion_meta: HashMap<String, ChampionMeta>,
) -> Result<ComputeRequest, EngineError> {
    let state = build_draft_state(&req.draft_state)?;
    let our_side = convert_pools_side(req.pools.our_side);
    let our_pool = convert_pool_blue(&req.pools.blue);
    let opp_pool = convert_pool_red(&req.pools.red);
    let (our_pool, opp_pool) = if our_side == Side::Blue {
        (our_pool, opp_pool)
    } else {
        (opp_pool, our_pool)
    };

    let cross_game_exclusions = req.pools.cross_game_exclusions.clone();
    let search_params = build_search_params(req)?;
    let latency_budget_ms = req.config.search.latency_budget_ms.max(0) as u64;

    let phase_weights_blue = phase_table_blue(&req.config.weights.phase_weights.blue);
    let phase_weights_red = phase_table_red(&req.config.weights.phase_weights.red);
    let penalties = Penalties {
        out_of_role: req.config.weights.penalties.out_of_role,
        out_of_pool: req.config.weights.penalties.out_of_pool,
    };

    Ok(ComputeRequest {
        state,
        our_side,
        our_pool,
        opp_pool,
        cross_game_exclusions,
        search_params,
        latency_budget_ms,
        champion_meta,
        meta_overrides: None,
        phase_weights_blue,
        phase_weights_red,
        penalties,
        synergy_multiplier: req.config.weights.synergy_multiplier,
        counter_multiplier: req.config.weights.counter_multiplier,
        flex_retention_weight: req.config.weights.flex_retention_weight,
        reveal_cost_weight: req.config.weights.reveal_cost_weight,
    })
}

fn build_draft_state(ds: &proto::EngineRequestDraftState) -> Result<DraftState, EngineError> {
    if ds.format != "standard" {
        return Err(EngineError::InvalidInput {
            path: vec!["draftState".into(), "format".into()],
        });
    }
    let mut blue_bans: Vec<(i64, String)> = ds
        .bans
        .iter()
        .filter(|b| matches!(b.side, proto::EngineRequestDraftStateBansItemSide::Blue))
        .map(|b| (b.slot, b.champion_id.clone()))
        .collect();
    let mut red_bans: Vec<(i64, String)> = ds
        .bans
        .iter()
        .filter(|b| matches!(b.side, proto::EngineRequestDraftStateBansItemSide::Red))
        .map(|b| (b.slot, b.champion_id.clone()))
        .collect();
    let mut blue_picks: Vec<(i64, String)> = ds
        .picks
        .iter()
        .filter(|p| matches!(p.side, proto::EngineRequestDraftStatePicksItemSide::Blue))
        .map(|p| (p.slot, p.champion_id.clone()))
        .collect();
    let mut red_picks: Vec<(i64, String)> = ds
        .picks
        .iter()
        .filter(|p| matches!(p.side, proto::EngineRequestDraftStatePicksItemSide::Red))
        .map(|p| (p.slot, p.champion_id.clone()))
        .collect();
    blue_bans.sort_by_key(|(s, _)| *s);
    red_bans.sort_by_key(|(s, _)| *s);
    blue_picks.sort_by_key(|(s, _)| *s);
    red_picks.sort_by_key(|(s, _)| *s);
    Ok(DraftState {
        blue_bans: blue_bans.into_iter().map(|(_, c)| c).collect(),
        red_bans: red_bans.into_iter().map(|(_, c)| c).collect(),
        blue_picks: blue_picks.into_iter().map(|(_, c)| c).collect(),
        red_picks: red_picks.into_iter().map(|(_, c)| c).collect(),
    })
}

fn convert_pools_side(s: proto::EngineRequestPoolsOurSide) -> Side {
    match s {
        proto::EngineRequestPoolsOurSide::Blue => Side::Blue,
        proto::EngineRequestPoolsOurSide::Red => Side::Red,
    }
}

fn convert_pool_blue(p: &proto::EngineRequestPoolsBlue) -> TeamPool {
    TeamPool {
        display: RolePoolMap {
            top: p.display.top.clone(),
            jungle: p.display.jungle.clone(),
            middle: p.display.middle.clone(),
            adc: p.display.adc.clone(),
            support: p.display.support.clone(),
        },
        search: p.search.clone(),
    }
}

fn convert_pool_red(p: &proto::EngineRequestPoolsRed) -> TeamPool {
    TeamPool {
        display: RolePoolMap {
            top: p.display.top.clone(),
            jungle: p.display.jungle.clone(),
            middle: p.display.middle.clone(),
            adc: p.display.adc.clone(),
            support: p.display.support.clone(),
        },
        search: p.search.clone(),
    }
}

fn build_search_params(req: &proto::EngineRequest) -> Result<SearchParams, EngineError> {
    let branch_width = req.config.search.branch_width.max(1) as usize;
    let pair_branch_width = req.config.search.pair_branch_width.max(1) as usize;
    let max_depth = req.config.search.max_depth.max(0) as usize;
    let forced_branches = convert_forced_branches(&req.config.forced_branches)?;
    Ok(SearchParams {
        branch_width,
        pair_branch_width,
        max_depth,
        disable_alpha_beta: false,
        forced_branches,
    })
}

fn convert_forced_branches(
    branches: &[proto::EngineRequestConfigForcedBranchesItem],
) -> Result<Vec<ForcedBranch>, EngineError> {
    let mut out = Vec::with_capacity(branches.len());
    for (idx, b) in branches.iter().enumerate() {
        let target_slot = b.target_slot as usize;
        let path: Vec<PathStep> = b
            .path
            .iter()
            .map(|p| PathStep {
                slot: p.slot as usize,
                champion_ids: p.champion_ids.clone(),
            })
            .collect();
        if path.iter().any(|step| step.slot >= target_slot) {
            return Err(EngineError::InvalidInput {
                path: vec!["forcedBranches".into(), idx.to_string()],
            });
        }
        let mode = match b.mode {
            proto::EngineRequestConfigForcedBranchesItemMode::Sole => ForcedMode::Sole,
            proto::EngineRequestConfigForcedBranchesItemMode::Include => ForcedMode::Include,
        };
        out.push(ForcedBranch {
            path,
            target_slot,
            champion_id: b.champion_id.clone(),
            mode,
        });
    }
    Ok(out)
}

fn phase_table_blue(b: &proto::EngineRequestConfigWeightsPhaseWeightsBlue) -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: b.ban1.info, comp: b.ban1.comp, coverage: b.ban1.coverage },
        pick1: PhaseWeights { info: b.pick1.info, comp: b.pick1.comp, coverage: b.pick1.coverage },
        ban2: PhaseWeights { info: b.ban2.info, comp: b.ban2.comp, coverage: b.ban2.coverage },
        pick2: PhaseWeights { info: b.pick2.info, comp: b.pick2.comp, coverage: b.pick2.coverage },
    }
}

fn phase_table_red(r: &proto::EngineRequestConfigWeightsPhaseWeightsRed) -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: r.ban1.info, comp: r.ban1.comp, coverage: r.ban1.coverage },
        pick1: PhaseWeights { info: r.pick1.info, comp: r.pick1.comp, coverage: r.pick1.coverage },
        ban2: PhaseWeights { info: r.ban2.info, comp: r.ban2.comp, coverage: r.ban2.coverage },
        pick2: PhaseWeights { info: r.pick2.info, comp: r.pick2.comp, coverage: r.pick2.coverage },
    }
}

// ---- Response: internal → protocol ----------------------------------------

pub fn core_to_response(resp: ComputeResponse) -> proto::EngineResponse {
    let scenarios = resp.scenarios.iter().map(to_protocol_scenario).collect();
    // Build per-scenario must-keep paths so wire-tree truncation never drops
    // a child the scenarios reference. Each path is a sequence of
    // sorted-championIds vectors (the same content-addressing the frontend's
    // `pathStepsToIndexPath` uses).
    let must_keep_paths: Vec<Vec<Vec<String>>> = resp
        .scenarios
        .iter()
        .map(|s| {
            s.tree_path
                .iter()
                .map(|step| {
                    let mut ids = step.champion_ids.clone();
                    ids.sort();
                    ids
                })
                .collect()
        })
        .collect();
    proto::EngineResponse {
        engine_id: ENGINE_ID.to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        request_id: None,
        meta: proto::EngineResponseMeta {
            cancelled: resp.cancelled,
            compute_time_ms: resp.compute_time_ms as f64,
            depth_reached: resp.depth_reached as i64,
            forced_branches_dropped: resp.forced_branches_dropped as i64,
            nodes_evaluated: resp.nodes_evaluated as i64,
            pruning_rate: resp.pruning_rate.clamp(0.0, 1.0),
            transpositions_found: resp.transpositions_found as i64,
            // αβ never sets MCTS-specific metadata; field carries through
            // serde with `skip_serializing_if = "Option::is_none"`.
            mcts_meta: None,
            // Phase 7b Decision 6/7: streaming-only fields. αβ is one-shot, so
            // `partial` is always None and `root_path` stays empty.
            partial: None,
            root_path: Vec::new(),
        },
        scenarios,
        tree: to_protocol_tree(&resp.tree, &must_keep_paths),
    }
}

/// Maximum children emitted per node in the rendered tree. The engine search
/// runs at full `pair_branch_width` (e.g. 500) for quality, but the frontend
/// renders one node per child — at 500 siblings the tree becomes unreadable.
/// `expand_pair` already sorts `children` DESC by composite, so taking the
/// top-K here keeps the strongest candidates and discards the long tail.
/// Single-pick turns naturally have ≤ `branch_width` children (default 5),
/// so this cap only meaningfully truncates pair turns.
///
/// Set higher than the 5-scenario count so Likely scenarios picked by
/// feature-distance (not top-by-composite) usually fall inside this window
/// and the frontend's `pathStepsToIndexPath` walk succeeds. The clean fix
/// is a scenario-aware "must-keep" set in `core_to_response`; this is a
/// blunter knob.
const TREE_DISPLAY_WIDTH: usize = 32;

/// Project an internal `TreeNode` to its wire form, capping each level's
/// children at `TREE_DISPLAY_WIDTH`. `must_keep_paths` carries scenarios'
/// content-addressed paths through this node — children whose championIds
/// match the head of any must-keep path are unconditionally preserved (in
/// addition to top-K by composite). For each kept child, the must-keep
/// paths that match it are filtered to their tails and threaded into the
/// recursive call so deeper levels also stay protected.
///
/// Why this is needed: scenarios are picked from leaves by leaf composite,
/// but the wire tree's children are sorted by back-propagated parent
/// composite. Under self-optimization those metrics diverge — so a
/// scenario-referenced pair-child can sit far outside the top-K and the
/// frontend's `pathStepsToIndexPath` walk would fail mid-path. Pass `&[]`
/// for callers that don't need protection (tests, raw projection).
fn to_protocol_tree(
    node: &TreeNode,
    must_keep_paths: &[Vec<Vec<String>>],
) -> proto::TreeNode {
    let must_keep_at_level: std::collections::HashSet<Vec<String>> = must_keep_paths
        .iter()
        .filter_map(|p| p.first().cloned())
        .collect();

    let mut included: std::collections::HashSet<Vec<String>> =
        std::collections::HashSet::new();
    let mut kept: Vec<&TreeNode> = Vec::with_capacity(TREE_DISPLAY_WIDTH);

    // Top-K-by-score (children are pre-sorted DESC by composite).
    for child in node.children.iter().take(TREE_DISPLAY_WIDTH) {
        let key = sorted_ids(&child.champion_ids);
        included.insert(key);
        kept.push(child);
    }
    // Plus must-keep children not already in top-K.
    for child in node.children.iter().skip(TREE_DISPLAY_WIDTH) {
        let key = sorted_ids(&child.champion_ids);
        if must_keep_at_level.contains(&key) && !included.contains(&key) {
            included.insert(key);
            kept.push(child);
        }
    }

    let proto_children: Vec<proto::TreeNode> = kept
        .iter()
        .map(|child| {
            let child_key = sorted_ids(&child.champion_ids);
            // Filter must-keep paths to those starting at this child, pass tails.
            let next_paths: Vec<Vec<Vec<String>>> = must_keep_paths
                .iter()
                .filter_map(|p| {
                    let head = p.first()?;
                    if *head == child_key {
                        Some(p[1..].to_vec())
                    } else {
                        None
                    }
                })
                .collect();
            to_protocol_tree(child, &next_paths)
        })
        .collect();

    proto::TreeNode {
        action_type: match node.action_type {
            ActionType::Ban => proto::TreeNodeActionType::Ban,
            ActionType::Pick => proto::TreeNodeActionType::Pick,
        },
        // v1: per-node assignment distribution is not populated by engine-core;
        // it lives only on Scenario.{blue,red}_likely_assignments. Frontend reads scenarios.
        assignment_distribution: vec![],
        champion_ids: node.champion_ids.clone(),
        children: proto_children,
        phase: convert_phase(node.phase),
        scores: tree_scores(&node.scores),
        side: node.side.map(convert_side_to_treenode),
        slots: node.slots.iter().map(|s| *s as i64).collect(),
        user_injected: node.user_injected,
        // αβ never emits MCTS metadata; the spike's mcts_dispatch path
        // populates this on the parallel branch.
        mcts_extras: None,
    }
}

fn sorted_ids(ids: &[String]) -> Vec<String> {
    let mut v = ids.to_vec();
    v.sort();
    v
}

fn convert_phase(p: Phase) -> proto::TreeNodePhase {
    match p {
        Phase::Ban1 => proto::TreeNodePhase::Ban1,
        Phase::Pick1 => proto::TreeNodePhase::Pick1,
        Phase::Ban2 => proto::TreeNodePhase::Ban2,
        Phase::Pick2 => proto::TreeNodePhase::Pick2,
    }
}

fn convert_side_to_treenode(s: Side) -> proto::TreeNodeSide {
    match s {
        Side::Blue => proto::TreeNodeSide::Blue,
        Side::Red => proto::TreeNodeSide::Red,
    }
}

#[allow(non_snake_case)]
fn tree_scores(s: &ScoreSet) -> proto::TreeNodeScores {
    proto::TreeNodeScores {
        comp_strength: s.compStrength,
        composite: s.composite,
        flex_retention: s.flexRetention,
        information_value: s.informationValue,
        reveal_cost: s.revealCost,
        role_coverage: s.roleCoverage,
    }
}

fn to_protocol_scenario(s: &Scenario) -> proto::EngineResponseScenariosItem {
    proto::EngineResponseScenariosItem {
        blue_bans: s.blue_bans.clone(),
        blue_picks: s.blue_picks.clone(),
        description: s.description.clone(),
        indicators: s.indicators.clone(),
        blue_likely_assignments: s
            .blue_likely_assignments
            .iter()
            .map(to_protocol_blue_assignment)
            .collect(),
        red_likely_assignments: s
            .red_likely_assignments
            .iter()
            .map(to_protocol_red_assignment)
            .collect(),
        name: s.name.clone(),
        perspective: match s.perspective {
            Perspective::Robust => proto::EngineResponseScenariosItemPerspective::Robust,
            Perspective::Likely => proto::EngineResponseScenariosItemPerspective::Likely,
            Perspective::OffProfile => {
                proto::EngineResponseScenariosItemPerspective::OffProfile
            }
        },
        red_bans: s.red_bans.clone(),
        red_picks: s.red_picks.clone(),
        scores: scenario_scores(&s.scores),
        tree_path: s
            .tree_path
            .iter()
            .map(|step| proto::EngineResponseScenariosItemTreePathItem {
                slot: step.slot as i64,
                champion_ids: step.champion_ids.clone(),
            })
            .collect(),
    }
}

#[allow(non_snake_case)]
fn scenario_scores(s: &ScoreSet) -> proto::EngineResponseScenariosItemScores {
    proto::EngineResponseScenariosItemScores {
        comp_strength: s.compStrength,
        composite: s.composite,
        information_value: s.informationValue,
        role_coverage: s.roleCoverage,
    }
}

fn to_protocol_blue_assignment(
    a: &WeightedAssignment,
) -> proto::EngineResponseScenariosItemBlueLikelyAssignmentsItem {
    proto::EngineResponseScenariosItemBlueLikelyAssignmentsItem {
        assignment: blue_assignment_to_proto(&a.assignment),
        weight: a.weight,
    }
}

fn blue_assignment_to_proto(
    a: &RoleAssignment,
) -> proto::EngineResponseScenariosItemBlueLikelyAssignmentsItemAssignment {
    proto::EngineResponseScenariosItemBlueLikelyAssignmentsItemAssignment {
        adc: a.adc.clone(),
        jungle: a.jungle.clone(),
        middle: a.middle.clone(),
        support: a.support.clone(),
        top: a.top.clone(),
    }
}

fn to_protocol_red_assignment(
    a: &WeightedAssignment,
) -> proto::EngineResponseScenariosItemRedLikelyAssignmentsItem {
    proto::EngineResponseScenariosItemRedLikelyAssignmentsItem {
        assignment: red_assignment_to_proto(&a.assignment),
        weight: a.weight,
    }
}

fn red_assignment_to_proto(
    a: &RoleAssignment,
) -> proto::EngineResponseScenariosItemRedLikelyAssignmentsItemAssignment {
    proto::EngineResponseScenariosItemRedLikelyAssignmentsItemAssignment {
        adc: a.adc.clone(),
        jungle: a.jungle.clone(),
        middle: a.middle.clone(),
        support: a.support.clone(),
        top: a.top.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request() -> proto::EngineRequest {
        let raw = serde_json::json!({
            "protocolVersion": "1.0.0",
            "draftState": {
                "format": "standard",
                "bans": [],
                "picks": [],
                "currentPhase": "ban1",
                "currentSlot": 0,
                "currentSide": "blue",
            },
            "pools": {
                "ourSide": "blue",
                "blue": {
                    "display": { "TOP": [], "JUNGLE": [], "MIDDLE": [], "ADC": [], "SUPPORT": [] },
                    "search": [],
                },
                "red": {
                    "display": { "TOP": [], "JUNGLE": [], "MIDDLE": [], "ADC": [], "SUPPORT": [] },
                    "search": [],
                },
                "crossGameExclusions": [],
            },
            "opponentModel": { "type": "meta", "weights": {} },
            "playerModel": { "championTiers": { "core": [], "playable": [], "emergency": [] }, "weights": {} },
            "config": {
                "search": {
                    "branchWidth": 4,
                    "pairBranchWidth": 8,
                    "singlePairTopK": 8,
                    "maxDepth": 2,
                    "broadDepth": 2,
                    "extensionTurnThreshold": 8,
                    "latencyBudgetMs": 500,
                },
                "weights": {
                    "phaseWeights": {
                        "blue": {
                            "ban1": { "comp": 0.5, "info": 0.5, "coverage": 0.0 },
                            "pick1": { "comp": 0.6, "info": 0.4, "coverage": 0.3 },
                            "ban2": { "comp": 0.5, "info": 0.5, "coverage": 0.4 },
                            "pick2": { "comp": 0.7, "info": 0.3, "coverage": 1.5 },
                        },
                        "red": {
                            "ban1": { "comp": 0.5, "info": 0.5, "coverage": 0.0 },
                            "pick1": { "comp": 0.6, "info": 0.4, "coverage": 0.3 },
                            "ban2": { "comp": 0.5, "info": 0.5, "coverage": 0.4 },
                            "pick2": { "comp": 0.7, "info": 0.3, "coverage": 1.5 },
                        },
                    },
                    "penalties": { "outOfPool": 0.75, "outOfRole": 0.25 },
                    "synergyMultiplier": 1.0,
                    "counterMultiplier": 1.0,
                    "flexRetentionWeight": 1.0,
                    "revealCostWeight": 1.0,
                },
                "profile": "firstpick-default-v1",
                "forcedBranches": [],
            },
        });
        serde_json::from_value(raw).expect("sample request parses")
    }

    #[test]
    fn request_to_core_projects_search_params() {
        let req = sample_request();
        let core = request_to_core(&req, HashMap::new()).expect("projection ok");
        assert_eq!(core.search_params.branch_width, 4);
        assert_eq!(core.search_params.pair_branch_width, 8);
        assert_eq!(core.search_params.max_depth, 2);
        assert!(!core.search_params.disable_alpha_beta);
        assert_eq!(core.latency_budget_ms, 500);
        assert_eq!(core.our_side, Side::Blue);
        assert_eq!(core.penalties.out_of_pool, 0.75);
        assert_eq!(core.phase_weights_blue.pick1.comp, 0.6);
    }

    #[test]
    fn request_to_core_rejects_reverse_fill_pair_force() {
        let mut req = sample_request();
        req.config
            .forced_branches
            .push(serde_json::from_value(serde_json::json!({
                "championId": "Annie",
                "mode": "sole",
                "path": [{ "slot": 9, "championIds": ["Aatrox"] }],
                "targetSlot": 7,
            })).unwrap());
        match request_to_core(&req, HashMap::new()) {
            Err(EngineError::InvalidInput { path }) => {
                assert_eq!(path, vec!["forcedBranches".to_string(), "0".to_string()]);
            }
            Err(other) => panic!("expected InvalidInput, got {:?}", other),
            Ok(_) => panic!("expected InvalidInput, got Ok"),
        }
    }

    #[test]
    fn to_protocol_tree_recurses() {
        use engine_core::evaluator::ScoreSet;
        let leaf = TreeNode {
            champion_ids: vec!["A".into()],
            scores: ScoreSet::default(),
            side: Some(Side::Blue),
            slots: vec![6],
            action_type: ActionType::Pick,
            phase: Phase::Pick1,
            user_injected: false,
            children: vec![],
        };
        let root = TreeNode {
            champion_ids: vec![],
            scores: ScoreSet::default(),
            side: None,
            slots: vec![],
            action_type: ActionType::Pick,
            phase: Phase::Pick1,
            user_injected: false,
            children: vec![leaf],
        };
        let proto_root = to_protocol_tree(&root, &[]);
        assert_eq!(proto_root.children.len(), 1);
        assert_eq!(proto_root.children[0].champion_ids, vec!["A".to_string()]);
        assert!(matches!(
            proto_root.children[0].side,
            Some(proto::TreeNodeSide::Blue)
        ));
        // assignment_distribution must be empty in v1
        assert!(proto_root.assignment_distribution.is_empty());
        assert!(proto_root.children[0].assignment_distribution.is_empty());
    }

    #[test]
    fn to_protocol_tree_truncates_wide_children_to_display_width() {
        // expand_pair can produce up to pair_branch_width (~500) children at a
        // pair-pick turn. The wire payload caps at TREE_DISPLAY_WIDTH so the
        // frontend doesn't render hundreds of siblings.
        use engine_core::evaluator::ScoreSet;
        let mut wide_children: Vec<TreeNode> = Vec::new();
        for i in 0..200 {
            wide_children.push(TreeNode {
                champion_ids: vec![format!("Champ{}", i), format!("Other{}", i)],
                scores: ScoreSet { composite: -(i as f64), ..Default::default() },
                side: Some(Side::Blue),
                slots: vec![17, 18],
                action_type: ActionType::Pick,
                phase: Phase::Pick2,
                user_injected: false,
                children: vec![],
            });
        }
        let root = TreeNode {
            champion_ids: vec![],
            scores: ScoreSet::default(),
            side: Some(Side::Blue),
            slots: vec![17, 18],
            action_type: ActionType::Pick,
            phase: Phase::Pick2,
            user_injected: false,
            children: wide_children,
        };
        let projected = to_protocol_tree(&root, &[]);
        assert_eq!(
            projected.children.len(),
            TREE_DISPLAY_WIDTH,
            "wire tree must cap children at TREE_DISPLAY_WIDTH; got {}",
            projected.children.len()
        );
        // The first 8 (top-K, since input was already in DESC order) survive.
        assert_eq!(projected.children[0].champion_ids, vec!["Champ0".to_string(), "Other0".to_string()]);
        assert_eq!(projected.children[7].champion_ids, vec!["Champ7".to_string(), "Other7".to_string()]);
    }

    #[test]
    fn to_protocol_tree_keeps_must_keep_children_outside_top_k() {
        // Regression for the slot-17 R5-missing-from-tree bug. Scenarios
        // pick leaves by leaf-composite, but the wire tree truncates by
        // back-propagated parent composite — the two metrics diverge under
        // self-optimization, so scenario-referenced pair-children can sit
        // far outside the top-`TREE_DISPLAY_WIDTH`. Must-keep paths
        // unconditionally preserve those children.
        use engine_core::evaluator::ScoreSet;
        let mut wide_children: Vec<TreeNode> = Vec::new();
        for i in 0..200 {
            wide_children.push(TreeNode {
                champion_ids: vec![format!("Champ{}", i), format!("Other{}", i)],
                scores: ScoreSet { composite: -(i as f64), ..Default::default() },
                side: Some(Side::Blue),
                slots: vec![17, 18],
                action_type: ActionType::Pick,
                phase: Phase::Pick2,
                user_injected: false,
                children: vec![],
            });
        }
        let root = TreeNode {
            champion_ids: vec![],
            scores: ScoreSet::default(),
            side: Some(Side::Blue),
            slots: vec![17, 18],
            action_type: ActionType::Pick,
            phase: Phase::Pick2,
            user_injected: false,
            children: wide_children,
        };
        // A scenario that picks Champ150/Other150 — well outside top-32.
        let must_keep_paths: Vec<Vec<Vec<String>>> = vec![vec![
            vec!["Champ150".to_string(), "Other150".to_string()],
        ]];
        let projected = to_protocol_tree(&root, &must_keep_paths);
        // Top-K survives + the one must-keep child = 33 children.
        assert_eq!(projected.children.len(), TREE_DISPLAY_WIDTH + 1);
        let kept_keys: Vec<Vec<String>> = projected
            .children
            .iter()
            .map(|c| {
                let mut ids = c.champion_ids.clone();
                ids.sort();
                ids
            })
            .collect();
        let target = {
            let mut ids = vec!["Champ150".to_string(), "Other150".to_string()];
            ids.sort();
            ids
        };
        assert!(
            kept_keys.contains(&target),
            "must-keep child must survive truncation; got {:?}",
            kept_keys,
        );
    }

    #[test]
    fn to_protocol_tree_must_keep_recurses_into_kept_children() {
        // Must-keep paths longer than 1 protect the corresponding child at
        // each level. Even though `branch_width=5 < TREE_DISPLAY_WIDTH=32`
        // means deeper levels usually pass through unscathed, the recursive
        // contract is what makes slot-7-class states (where the second
        // pair-fanout sits at depth 1 of the engine tree) safe.
        use engine_core::evaluator::ScoreSet;
        // Build a 2-level wide tree: 100 children at depth 1, each with 100
        // grandchildren at depth 2.
        let mut grandchildren: Vec<TreeNode> = Vec::new();
        for j in 0..100 {
            grandchildren.push(TreeNode {
                champion_ids: vec![format!("R{}", j)],
                scores: ScoreSet { composite: -(j as f64), ..Default::default() },
                side: Some(Side::Red),
                slots: vec![19],
                action_type: ActionType::Pick,
                phase: Phase::Pick2,
                user_injected: false,
                children: vec![],
            });
        }
        let mut children: Vec<TreeNode> = Vec::new();
        for i in 0..100 {
            children.push(TreeNode {
                champion_ids: vec![format!("B{}", i)],
                scores: ScoreSet { composite: -(i as f64), ..Default::default() },
                side: Some(Side::Blue),
                slots: vec![17, 18],
                action_type: ActionType::Pick,
                phase: Phase::Pick2,
                user_injected: false,
                children: grandchildren.clone(),
            });
        }
        let root = TreeNode {
            champion_ids: vec![],
            scores: ScoreSet::default(),
            side: Some(Side::Blue),
            slots: vec![17, 18],
            action_type: ActionType::Pick,
            phase: Phase::Pick2,
            user_injected: false,
            children,
        };
        // Scenario goes through B80 (outside depth-1 top-32) → R90 (outside
        // depth-2 top-32). Both must survive their respective truncations.
        let must_keep_paths: Vec<Vec<Vec<String>>> = vec![vec![
            vec!["B80".to_string()],
            vec!["R90".to_string()],
        ]];
        let projected = to_protocol_tree(&root, &must_keep_paths);
        let b80 = projected
            .children
            .iter()
            .find(|c| c.champion_ids == vec!["B80".to_string()])
            .expect("B80 must be kept at depth 1");
        let r90_kept = b80
            .children
            .iter()
            .any(|c| c.champion_ids == vec!["R90".to_string()]);
        assert!(r90_kept, "R90 must be kept under B80 at depth 2");
        // Sibling kept-but-not-on-the-must-keep-path B0 must NOT pass R90 down
        // (only the matching path does).
        let b0 = projected
            .children
            .iter()
            .find(|c| c.champion_ids == vec!["B0".to_string()])
            .expect("B0 must be kept at depth 1 (top-K)");
        let b0_has_r90 = b0
            .children
            .iter()
            .any(|c| c.champion_ids == vec!["R90".to_string()]);
        assert!(
            !b0_has_r90,
            "B0 (not on must-keep path) should not include R90; must-keep is path-scoped"
        );
        // B0's children should be top-K only (32).
        assert_eq!(b0.children.len(), TREE_DISPLAY_WIDTH);
    }

    #[test]
    fn core_to_response_preserves_meta_and_constants() {
        use engine_core::evaluator::ScoreSet;
        let resp = ComputeResponse {
            tree: TreeNode {
                champion_ids: vec![],
                scores: ScoreSet::default(),
                side: None,
                slots: vec![],
                action_type: ActionType::Pick,
                phase: Phase::Pick1,
                user_injected: false,
                children: vec![],
            },
            scenarios: vec![],
            nodes_evaluated: 42,
            compute_time_ms: 13,
            pruning_rate: 0.5,
            depth_reached: 3,
            transpositions_found: 7,
            forced_branches_dropped: 0,
            cancelled: false,
        };
        let proto_resp = core_to_response(resp);
        assert_eq!(proto_resp.protocol_version, PROTOCOL_VERSION);
        assert_eq!(proto_resp.engine_id, ENGINE_ID);
        assert_eq!(proto_resp.meta.nodes_evaluated, 42);
        assert_eq!(proto_resp.meta.depth_reached, 3);
        assert_eq!(proto_resp.meta.compute_time_ms, 13.0);
    }
}
