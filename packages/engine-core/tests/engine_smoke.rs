use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side, TURN_SEQUENCE};
use engine_core::engine::{ComputeRequest, Engine, EngineError};
use engine_core::evaluator::{MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::forced_branches::{ForcedBranch, ForcedMode, PathStep};
use engine_core::role_solver::ChampionMeta;
use engine_core::scenarios::Perspective;
use engine_core::pools::{Penalties, RolePoolMap, TeamPool};
use engine_core::pools::Role;
use engine_core::search::SearchParams;
use std::collections::HashMap;

pub(crate) fn default_request(state: DraftState) -> ComputeRequest {
    ComputeRequest {
        state,
        our_side: Side::Blue,
        our_pool: TeamPool {
            display: RolePoolMap {
                top: vec![],
                jungle: vec![],
                middle: vec![],
                adc: vec![],
                support: vec![],
            },
            search: vec![],
        },
        opp_pool: TeamPool {
            display: RolePoolMap {
                top: vec![],
                jungle: vec![],
                middle: vec![],
                adc: vec![],
                support: vec![],
            },
            search: vec![],
        },
        cross_game_exclusions: vec![],
        search_params: SearchParams::default(),
        latency_budget_ms: 5000,
        champion_meta: HashMap::new(),
        meta_overrides: None,
        phase_weights_blue: PhaseWeightTable {
            ban1: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
            pick1: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
            ban2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
            pick2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
        },
        phase_weights_red: PhaseWeightTable {
            ban1: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
            pick1: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
            ban2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
            pick2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
                coverage: 0.0,
            },
        },
        penalties: Penalties {
            out_of_role: 0.0,
            out_of_pool: 0.0,
        },
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    }
}

fn pool_with(champs: &[&str]) -> TeamPool {
    TeamPool {
        display: RolePoolMap {
            top: vec![],
            jungle: vec![],
            middle: vec![],
            adc: vec![],
            support: vec![],
        },
        search: champs.iter().map(|c| (*c).into()).collect(),
    }
}

fn fast_forward_to_slot(state: &mut DraftState, slot: usize) {
    for i in 0..slot {
        let id = format!("filler{}", i);
        match (TURN_SEQUENCE[i].action_type, TURN_SEQUENCE[i].side) {
            (ActionType::Ban, Side::Blue) => state.blue_bans.push(id),
            (ActionType::Ban, Side::Red) => state.red_bans.push(id),
            (ActionType::Pick, Side::Blue) => state.blue_picks.push(id),
            (ActionType::Pick, Side::Red) => state.red_picks.push(id),
        }
    }
}

fn step(slot: usize, ids: &[&str]) -> PathStep {
    PathStep {
        slot,
        champion_ids: ids.iter().map(|id| (*id).to_string()).collect(),
    }
}

#[test]
fn empty_engine_returns_empty_tree() {
    // Task 7.1 skeleton: a default-constructed Engine + empty draft state
    // produces an empty TreeNode and zeroed meta counters. Task 7.2 replaces
    // this stub with a real search; this test then becomes a regression check
    // that the boundary signature is preserved.
    let engine = Engine::new(MetaData::default(), HashMap::new());
    let req = default_request(DraftState::default());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).expect("compute must not error");

    assert_eq!(resp.tree.children.len(), 0);
    assert_eq!(resp.tree.champion_ids.len(), 0);
    assert_eq!(resp.scenarios.len(), 0);
    assert!(resp.depth_reached >= 1);
    assert_eq!(resp.forced_branches_dropped, 0);
    assert_eq!(resp.transpositions_found, 0);
    assert!(!resp.cancelled);
}

#[test]
fn compute_errs_cancelled_when_token_already_cancelled() {
    let engine = Engine::new(MetaData::default(), HashMap::new());
    let req = default_request(DraftState::default());
    let cancel = CancelHandle::new();
    cancel.cancel();
    let resp = engine.compute(req, &cancel);

    assert!(matches!(resp, Err(EngineError::Cancelled)));
}

#[test]
fn engine_error_invalid_input_carries_path() {
    // Sanity check on the error shape: InvalidInput.path is a Vec<String>
    // mirroring the protocol's Zod-style path. napi-rs wrapping (Phase 9)
    // depends on this shape to populate EngineError.path on the JS side.
    let err = EngineError::InvalidInput {
        path: vec!["forcedBranches".into(), "0".into()],
    };
    match err {
        EngineError::InvalidInput { path } => {
            assert_eq!(path, vec!["forcedBranches".to_string(), "0".to_string()]);
        }
        _ => panic!("expected InvalidInput variant"),
    }
}

#[test]
fn compute_returns_real_tree_for_pick_turn() {
    // Pool needs to cover all 5 roles so feasibility prune passes. With a
    // 3-champ TOP-only pool, picks_remaining=5 but pool.len()=3 → infeasible.
    // Use 5 role-diverse champs + branch_width=3 to keep the == 3 assertion.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut req = default_request(state);
    req.our_pool = pool_with(&["A", "B", "C", "D", "E"]);
    req.opp_pool = pool_with(&["A", "B", "C", "D", "E"]);
    req.latency_budget_ms = 5000;
    req.search_params.max_depth = 1;
    req.search_params.branch_width = 3;
    req.meta_overrides = Some(MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.70),
            ("C".to_string(), 0.50),
            ("D".to_string(), 0.35),
            ("E".to_string(), 0.20),
        ]),
        ..Default::default()
    });
    req.champion_meta = HashMap::from([
        ("A".to_string(), ChampionMeta { id: "A".to_string(), positions: vec![Role::Top],     ..Default::default() }),
        ("B".to_string(), ChampionMeta { id: "B".to_string(), positions: vec![Role::Jungle],  ..Default::default() }),
        ("C".to_string(), ChampionMeta { id: "C".to_string(), positions: vec![Role::Middle],  ..Default::default() }),
        ("D".to_string(), ChampionMeta { id: "D".to_string(), positions: vec![Role::Adc],     ..Default::default() }),
        ("E".to_string(), ChampionMeta { id: "E".to_string(), positions: vec![Role::Support], ..Default::default() }),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).unwrap();

    assert_eq!(resp.tree.children.len(), 3);
    assert!(resp.depth_reached >= 1);
    assert!(!resp.tree.children[0].champion_ids.is_empty());
    assert!(!resp.cancelled);
}

#[test]
fn compute_errs_cancelled_when_cancelled_before_first_depth() {
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut req = default_request(state);
    req.our_pool = pool_with(&["A", "B", "C"]);
    req.opp_pool = pool_with(&["A", "B", "C"]);
    req.latency_budget_ms = 5000;
    req.search_params.max_depth = 1;
    req.search_params.branch_width = 5;
    req.meta_overrides = Some(MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.70),
            ("C".to_string(), 0.20),
        ]),
        ..Default::default()
    });
    req.champion_meta = HashMap::from([
        (
            "A".to_string(),
            ChampionMeta {
                id: "A".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "B".to_string(),
            ChampionMeta {
                id: "B".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "C".to_string(),
            ChampionMeta {
                id: "C".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    cancel.cancel();

    let resp = engine.compute(req, &cancel);
    assert!(matches!(resp, Err(EngineError::Cancelled)));
}

#[test]
fn compute_returns_partial_on_budget_exhaustion() {
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let champs = ["A", "B", "C", "D", "E", "F", "G", "H"];
    let mut req = default_request(state);
    req.our_pool = pool_with(&champs);
    req.opp_pool = pool_with(&champs);
    req.latency_budget_ms = 1;
    req.search_params.max_depth = 8;
    req.search_params.branch_width = 5;
    req.meta_overrides = Some(MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.80),
            ("C".to_string(), 0.70),
            ("D".to_string(), 0.60),
            ("E".to_string(), 0.50),
            ("F".to_string(), 0.40),
            ("G".to_string(), 0.30),
            ("H".to_string(), 0.20),
        ]),
        ..Default::default()
    });
    req.champion_meta = champs
        .into_iter()
        .map(|champ| {
            (
                champ.to_string(),
                ChampionMeta {
                    id: champ.to_string(),
                    positions: vec![Role::Top],
                    ..Default::default()
                },
            )
        })
        .collect();

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).unwrap();

    assert!(resp.depth_reached >= 1);
    // `cancelled` is reserved for external supersession cancels; budget-exhaust
    // returns a usable partial result and must NOT set cancelled. Backend uses
    // this flag to decide whether to persist the snapshot — timeout-partial
    // results are persisted, supersession-cancels are swallowed.
    assert!(!resp.cancelled, "budget exhaustion is not a cancellation; see engine.rs::compute");
}

#[test]
fn compute_propagates_forced_branches_dropped() {
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut req = default_request(state);
    req.our_pool = pool_with(&["A", "B", "C"]);
    req.opp_pool = pool_with(&["A", "B", "C"]);
    req.search_params.max_depth = 1;
    req.search_params.branch_width = 3;
    req.search_params.forced_branches = vec![ForcedBranch {
        path: vec![step(99, &["missing"])],
        target_slot: 6,
        champion_id: "C".to_string(),
        mode: ForcedMode::Include,
    }];
    req.meta_overrides = Some(MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.70),
            ("C".to_string(), 0.20),
        ]),
        ..Default::default()
    });
    req.champion_meta = HashMap::from([
        (
            "A".to_string(),
            ChampionMeta {
                id: "A".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "B".to_string(),
            ChampionMeta {
                id: "B".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "C".to_string(),
            ChampionMeta {
                id: "C".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).unwrap();

    assert_eq!(resp.forced_branches_dropped, 1);
}

#[test]
fn compute_propagates_user_injected_on_resolved_force() {
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut req = default_request(state);
    req.our_pool = pool_with(&["A", "B", "C"]);
    req.opp_pool = pool_with(&["A", "B", "C"]);
    req.search_params.max_depth = 1;
    req.search_params.branch_width = 2;
    req.search_params.forced_branches = vec![ForcedBranch {
        path: vec![],
        target_slot: 6,
        champion_id: "C".to_string(),
        mode: ForcedMode::Sole,
    }];
    req.meta_overrides = Some(MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.70),
            ("C".to_string(), 0.20),
        ]),
        ..Default::default()
    });
    req.champion_meta = HashMap::from([
        (
            "A".to_string(),
            ChampionMeta {
                id: "A".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "B".to_string(),
            ChampionMeta {
                id: "B".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "C".to_string(),
            ChampionMeta {
                id: "C".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).unwrap();

    assert_eq!(resp.forced_branches_dropped, 0);
    assert!(resp.tree.children.iter().any(|child| child.user_injected));
}

#[test]
fn compute_errs_invalid_input_on_reverse_fill_pair_force() {
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 8);

    let mut req = default_request(state);
    req.our_pool = pool_with(&["A", "B", "C"]);
    req.opp_pool = pool_with(&["A", "B", "C"]);
    req.search_params.max_depth = 1;
    req.search_params.branch_width = 3;
    req.search_params.forced_branches = vec![ForcedBranch {
        path: vec![],
        target_slot: 7,
        champion_id: "A".to_string(),
        mode: ForcedMode::Sole,
    }];
    req.champion_meta = HashMap::from([
        (
            "A".to_string(),
            ChampionMeta {
                id: "A".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "B".to_string(),
            ChampionMeta {
                id: "B".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
        (
            "C".to_string(),
            ChampionMeta {
                id: "C".to_string(),
                positions: vec![Role::Top],
                ..Default::default()
            },
        ),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel);

    match resp {
        Err(EngineError::InvalidInput { path }) => {
            assert_eq!(path, vec!["forcedBranches".to_string(), "0".to_string()]);
        }
        Err(other) => panic!("expected InvalidInput, got {}", other),
        Ok(_) => panic!("expected InvalidInput, got success"),
    }
}

#[test]
fn compute_reports_nodes_evaluated_and_pruning_rate() {
    // Role-diverse pool (2 champs per role, 10 total) so that early search
    // levels don't trip the feasibility prune. Note: feasibility still fires
    // at deeper levels where the per-side pool tightens — see the comment on
    // the no-ab pruning_rate assertion below.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    // A/B = TOP, C/D = JG, E/F = MID, G/H = ADC, I/J = SUP.
    // Both blue and red get all 10. With 10 per side, remaining picks stay
    // satisfiable through the full 4-pick Pick1 sequence explored at depth=4.
    let champs = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    let meta = MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.90),
            ("C".to_string(), 0.85),
            ("D".to_string(), 0.80),
            ("E".to_string(), 0.70),
            ("F".to_string(), 0.60),
            ("G".to_string(), 0.50),
            ("H".to_string(), 0.40),
            ("I".to_string(), 0.30),
            ("J".to_string(), 0.20),
        ]),
        ..Default::default()
    };
    let role_map: [Role; 10] = [
        Role::Top, Role::Top,
        Role::Jungle, Role::Jungle,
        Role::Middle, Role::Middle,
        Role::Adc, Role::Adc,
        Role::Support, Role::Support,
    ];
    let champion_meta: HashMap<String, ChampionMeta> = champs
        .into_iter()
        .zip(role_map.iter())
        .map(|(champ, role)| {
            (
                champ.to_string(),
                ChampionMeta {
                    id: champ.to_string(),
                    positions: vec![*role],
                    ..Default::default()
                },
            )
        })
        .collect();

    let mut req_ab = default_request(state.clone());
    req_ab.our_pool = pool_with(&champs);
    req_ab.opp_pool = pool_with(&champs);
    req_ab.latency_budget_ms = 5000;
    req_ab.search_params.max_depth = 4;
    req_ab.search_params.branch_width = 5;
    req_ab.search_params.disable_alpha_beta = false;
    req_ab.meta_overrides = Some(meta.clone());
    req_ab.champion_meta = champion_meta.clone();

    let mut req_no_ab = default_request(state);
    req_no_ab.our_pool = pool_with(&champs);
    req_no_ab.opp_pool = pool_with(&champs);
    req_no_ab.latency_budget_ms = 5000;
    req_no_ab.search_params.max_depth = 4;
    req_no_ab.search_params.branch_width = 5;
    req_no_ab.search_params.disable_alpha_beta = true;
    req_no_ab.meta_overrides = Some(meta);
    req_no_ab.champion_meta = champion_meta;

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();

    let resp_ab = engine.compute(req_ab, &cancel).unwrap();
    let resp_no_ab = engine.compute(req_no_ab, &cancel).unwrap();

    assert!(resp_ab.nodes_evaluated > 0);
    assert!(resp_no_ab.nodes_evaluated > 0);
    // Alpha-beta produces meaningful pruning (feasibility + cutoffs combined).
    assert!(resp_ab.pruning_rate > 0.05);
    // No-ab disables alpha-beta cuts; feasibility prune still fires at deeper
    // search levels where the role-coverage envelope tightens, so we can't
    // assert pruning_rate == 0. Verify instead that no-ab explores at least as
    // many nodes as ab (feasibility prune affects both runs identically; only
    // alpha-beta cuts differ).
    assert!(resp_no_ab.nodes_evaluated >= resp_ab.nodes_evaluated);
}

#[test]
fn compute_reports_compute_time_ms() {
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let champs = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    let meta = MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.98),
            ("B".to_string(), 0.92),
            ("C".to_string(), 0.86),
            ("D".to_string(), 0.78),
            ("E".to_string(), 0.70),
            ("F".to_string(), 0.62),
            ("G".to_string(), 0.54),
            ("H".to_string(), 0.46),
            ("I".to_string(), 0.38),
            ("J".to_string(), 0.30),
        ]),
        ..Default::default()
    };
    let champion_meta: HashMap<String, ChampionMeta> = champs
        .into_iter()
        .map(|champ| {
            (
                champ.to_string(),
                ChampionMeta {
                    id: champ.to_string(),
                    positions: vec![Role::Top],
                    ..Default::default()
                },
            )
        })
        .collect();

    let mut req = default_request(state);
    req.our_pool = pool_with(&champs);
    req.opp_pool = pool_with(&champs);
    req.latency_budget_ms = 5000;
    req.search_params.max_depth = 6;
    req.search_params.branch_width = 5;
    req.search_params.disable_alpha_beta = true;
    req.meta_overrides = Some(meta);
    req.champion_meta = champion_meta;

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).unwrap();

    assert!(resp.compute_time_ms > 0);
}

#[test]
fn compute_returns_nonempty_scenarios_at_pick_turn() {
    // Pool needs to cover all 5 roles so feasibility prune passes.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut req = default_request(state);
    req.our_pool = pool_with(&["A", "B", "C", "D", "E"]);
    req.opp_pool = pool_with(&["A", "B", "C", "D", "E"]);
    req.latency_budget_ms = 5000;
    req.search_params.max_depth = 1;
    req.search_params.branch_width = 5;
    req.meta_overrides = Some(MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.70),
            ("C".to_string(), 0.50),
            ("D".to_string(), 0.35),
            ("E".to_string(), 0.20),
        ]),
        ..Default::default()
    });
    req.champion_meta = HashMap::from([
        ("A".to_string(), ChampionMeta { id: "A".to_string(), positions: vec![Role::Top],     ..Default::default() }),
        ("B".to_string(), ChampionMeta { id: "B".to_string(), positions: vec![Role::Jungle],  ..Default::default() }),
        ("C".to_string(), ChampionMeta { id: "C".to_string(), positions: vec![Role::Middle],  ..Default::default() }),
        ("D".to_string(), ChampionMeta { id: "D".to_string(), positions: vec![Role::Adc],     ..Default::default() }),
        ("E".to_string(), ChampionMeta { id: "E".to_string(), positions: vec![Role::Support], ..Default::default() }),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).unwrap();

    assert!((1..=5).contains(&resp.scenarios.len()));
    assert!(resp
        .scenarios
        .iter()
        .all(|scenario| !scenario.name.is_empty() && !scenario.tree_path.is_empty()));
}

#[test]
fn compute_scenarios_perspective_first_is_robust() {
    // Pool needs to cover all 5 roles so feasibility prune passes.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut req = default_request(state);
    req.our_pool = pool_with(&["A", "B", "C", "D", "E"]);
    req.opp_pool = pool_with(&["A", "B", "C", "D", "E"]);
    req.latency_budget_ms = 5000;
    req.search_params.max_depth = 1;
    req.search_params.branch_width = 5;
    req.meta_overrides = Some(MetaData {
        win_rates: HashMap::from([
            ("A".to_string(), 0.95),
            ("B".to_string(), 0.70),
            ("C".to_string(), 0.50),
            ("D".to_string(), 0.35),
            ("E".to_string(), 0.20),
        ]),
        ..Default::default()
    });
    req.champion_meta = HashMap::from([
        ("A".to_string(), ChampionMeta { id: "A".to_string(), positions: vec![Role::Top],     ..Default::default() }),
        ("B".to_string(), ChampionMeta { id: "B".to_string(), positions: vec![Role::Jungle],  ..Default::default() }),
        ("C".to_string(), ChampionMeta { id: "C".to_string(), positions: vec![Role::Middle],  ..Default::default() }),
        ("D".to_string(), ChampionMeta { id: "D".to_string(), positions: vec![Role::Adc],     ..Default::default() }),
        ("E".to_string(), ChampionMeta { id: "E".to_string(), positions: vec![Role::Support], ..Default::default() }),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).unwrap();

    assert_eq!(resp.scenarios[0].perspective, Perspective::Robust);
}
