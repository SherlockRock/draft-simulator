use criterion::{black_box, criterion_group, criterion_main, Criterion};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::rayon_pool::ensure_rayon_pool;
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search_with_stats, SearchParams};
use std::collections::HashMap;

fn pool_with(champs: &[String]) -> TeamPool {
    TeamPool {
        display: RolePoolMap {
            top: vec![],
            jungle: vec![],
            middle: vec![],
            adc: vec![],
            support: vec![],
        },
        search: champs.to_vec(),
    }
}

fn weights_blue() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights {
            info: 0.65,
            comp: 0.35,
            coverage: 0.0,
        },
        pick1: PhaseWeights {
            info: 0.5,
            comp: 0.5,
            coverage: 0.0,
        },
        ban2: PhaseWeights {
            info: 0.4,
            comp: 0.6,
            coverage: 0.0,
        },
        pick2: PhaseWeights {
            info: 0.2,
            comp: 0.8,
            coverage: 0.0,
        },
    }
}

fn weights_red() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights {
            info: 0.7,
            comp: 0.3,
            coverage: 0.0,
        },
        pick1: PhaseWeights {
            info: 0.6,
            comp: 0.4,
            coverage: 0.0,
        },
        ban2: PhaseWeights {
            info: 0.5,
            comp: 0.5,
            coverage: 0.0,
        },
        pick2: PhaseWeights {
            info: 0.2,
            comp: 0.8,
            coverage: 0.0,
        },
    }
}

fn synthetic_fixture() -> (DraftState, SearchParams, EvalContext) {
    let champs: Vec<String> = (0..171).map(|i| format!("c{i:03}")).collect();
    let roles = [
        Role::Top,
        Role::Jungle,
        Role::Middle,
        Role::Adc,
        Role::Support,
    ];
    let champion_meta: HashMap<String, ChampionMeta> = champs
        .iter()
        .enumerate()
        .map(|(i, champ)| {
            (
                champ.clone(),
                ChampionMeta {
                    id: champ.clone(),
                    positions: vec![roles[i % roles.len()]],
                    ..Default::default()
                },
            )
        })
        .collect();

    let pool = pool_with(&champs);
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 7);
    assert!(TURN_SEQUENCE[state.turn_index()].pair_start);

    let params = SearchParams {
        branch_width: 8,
        max_depth: 4,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick1,
        our_pool: pool.clone(),
        opp_pool: pool,
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties {
            out_of_role: 0.25,
            out_of_pool: 0.75,
        },
        champion_meta,
        meta: MetaData::default(),
        phase_weights_blue: weights_blue(),
        phase_weights_red: weights_red(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
    };

    (state, params, ctx)
}

fn fast_forward_to_slot(state: &mut DraftState, slot: usize) {
    for i in 0..slot {
        let id = format!("filler{i}");
        match (TURN_SEQUENCE[i].action_type, TURN_SEQUENCE[i].side) {
            (ActionType::Ban, Side::Blue) => state.blue_bans.push(id),
            (ActionType::Ban, Side::Red) => state.red_bans.push(id),
            (ActionType::Pick, Side::Blue) => state.blue_picks.push(id),
            (ActionType::Pick, Side::Red) => state.red_picks.push(id),
        }
    }
}

fn bench_pair_turn(c: &mut Criterion) {
    ensure_rayon_pool();
    let (state, params, ctx) = synthetic_fixture();

    c.bench_function("pair_turn_pair_node_depth_4", |b| {
        b.iter(|| {
            let cancel = CancelHandle::new();
            black_box(
                search_with_stats(&state, &params, &ctx, &cancel)
                    .expect("bench search should complete"),
            )
        })
    });
}

criterion_group!(benches, bench_pair_turn);
criterion_main!(benches);
