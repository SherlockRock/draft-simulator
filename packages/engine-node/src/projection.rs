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
    let max_depth = req.config.search.max_depth.max(0) as usize;
    let forced_branches = convert_forced_branches(&req.config.forced_branches)?;
    Ok(SearchParams {
        branch_width,
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
        },
        scenarios,
        tree: to_protocol_tree(&resp.tree),
    }
}

fn to_protocol_tree(node: &TreeNode) -> proto::TreeNode {
    proto::TreeNode {
        action_type: match node.action_type {
            ActionType::Ban => proto::TreeNodeActionType::Ban,
            ActionType::Pick => proto::TreeNodeActionType::Pick,
        },
        // v1: per-node assignment distribution is not populated by engine-core;
        // it lives only on Scenario.{blue,red}_likely_assignments. Frontend reads scenarios.
        assignment_distribution: vec![],
        champion_ids: node.champion_ids.clone(),
        children: node.children.iter().map(to_protocol_tree).collect(),
        phase: convert_phase(node.phase),
        scores: tree_scores(&node.scores),
        side: node.side.map(convert_side_to_treenode),
        slots: node.slots.iter().map(|s| *s as i64).collect(),
        user_injected: node.user_injected,
    }
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
                            "pick2": { "comp": 0.7, "info": 0.3, "coverage": 0.6 },
                        },
                        "red": {
                            "ban1": { "comp": 0.5, "info": 0.5, "coverage": 0.0 },
                            "pick1": { "comp": 0.6, "info": 0.4, "coverage": 0.3 },
                            "ban2": { "comp": 0.5, "info": 0.5, "coverage": 0.4 },
                            "pick2": { "comp": 0.7, "info": 0.3, "coverage": 0.6 },
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
        let proto_root = to_protocol_tree(&root);
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
