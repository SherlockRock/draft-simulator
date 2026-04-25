use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side, TURN_SEQUENCE};
use engine_core::engine::{ComputeRequest, Engine, EngineError};
use engine_core::evaluator::{MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::role_solver::ChampionMeta;
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
            },
            pick1: PhaseWeights {
                info: 0.0,
                comp: 0.0,
            },
            ban2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
            },
            pick2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
            },
        },
        phase_weights_red: PhaseWeightTable {
            ban1: PhaseWeights {
                info: 0.0,
                comp: 0.0,
            },
            pick1: PhaseWeights {
                info: 0.0,
                comp: 0.0,
            },
            ban2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
            },
            pick2: PhaseWeights {
                info: 0.0,
                comp: 0.0,
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
            },
        ),
        (
            "B".to_string(),
            ChampionMeta {
                id: "B".to_string(),
                positions: vec![Role::Top],
            },
        ),
        (
            "C".to_string(),
            ChampionMeta {
                id: "C".to_string(),
                positions: vec![Role::Top],
            },
        ),
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
            },
        ),
        (
            "B".to_string(),
            ChampionMeta {
                id: "B".to_string(),
                positions: vec![Role::Top],
            },
        ),
        (
            "C".to_string(),
            ChampionMeta {
                id: "C".to_string(),
                positions: vec![Role::Top],
            },
        ),
    ]);

    let engine = Engine::new(MetaData::default(), HashMap::new());
    let cancel = CancelHandle::new();
    cancel.cancel();

    let resp = engine.compute(req, &cancel);
    assert!(matches!(resp, Err(EngineError::Cancelled)));
}
