use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{DraftState, Side};
use engine_core::engine::{ComputeRequest, Engine, EngineError};
use engine_core::evaluator::{MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, RolePoolMap, TeamPool};
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
        latency_budget_ms: 0,
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

#[test]
fn empty_engine_returns_empty_tree() {
    // Task 7.1 skeleton: a default-constructed Engine + empty draft state
    // produces an empty TreeNode and zeroed meta counters. Task 7.2 replaces
    // this stub with a real search; this test then becomes a regression check
    // that the boundary signature is preserved.
    let engine = Engine::new(MetaData::default(), HashMap::new());
    let req = default_request(DraftState::default());
    let cancel = CancelHandle::new();
    let resp = engine.compute(req, &cancel).expect("skeleton must not error");

    assert_eq!(resp.tree.children.len(), 0);
    assert_eq!(resp.tree.champion_ids.len(), 0);
    assert_eq!(resp.scenarios.len(), 0);
    assert_eq!(resp.depth_reached, 0);
    assert_eq!(resp.forced_branches_dropped, 0);
    assert_eq!(resp.transpositions_found, 0);
    assert!(!resp.cancelled);
}

#[test]
fn compute_marks_response_cancelled_when_token_already_cancelled() {
    // Eager cancellation propagates: a handle cancelled before compute() runs
    // produces a response with cancelled = true. The skeleton doesn't yet do
    // any work, so it just echoes the handle's state — once 7.2 lands real
    // search, the same surface stays valid.
    let engine = Engine::new(MetaData::default(), HashMap::new());
    let req = default_request(DraftState::default());
    let cancel = CancelHandle::new();
    cancel.cancel();
    let resp = engine.compute(req, &cancel).expect("skeleton must not error");

    assert!(resp.cancelled);
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
