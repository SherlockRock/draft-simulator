use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::forced_branches::{
    resolve_path, ForcedBranch, ForcedMode, PathMatch, PathStep,
};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search, SearchParams};
use std::collections::HashMap;

fn step(slot: usize, ids: &[&str]) -> PathStep {
    PathStep {
        slot,
        champion_ids: ids.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn empty_path_matches_root() {
    let r = resolve_path(&[], &[]);
    assert!(matches!(r, PathMatch::Resolved { depth: 0 }));
}

#[test]
fn unresolved_path_returns_unresolved() {
    let path = vec![step(7, &["Yone"])];
    let actual_lineage: Vec<(usize, Vec<String>)> = Vec::new();
    let r = resolve_path(&path, &actual_lineage);
    assert!(matches!(r, PathMatch::Unresolved));
}

#[test]
fn content_addressed_path_resolves() {
    let path = vec![step(6, &["B1"]), step(7, &["R1", "R2"])];
    let lineage = vec![
        (6, vec!["B1".to_string()]),
        (7, vec!["R1".to_string(), "R2".to_string()]),
    ];
    let r = resolve_path(&path, &lineage);
    assert!(matches!(r, PathMatch::Resolved { depth: 2 }));
}

#[test]
fn pair_path_order_independent() {
    // Pair championIds should match irrespective of the order they're listed.
    let path = vec![step(7, &["R2", "R1"])];
    let lineage = vec![(7, vec!["R1".to_string(), "R2".to_string()])];
    let r = resolve_path(&path, &lineage);
    assert!(matches!(r, PathMatch::Resolved { depth: 1 }));
}

#[test]
fn slot_mismatch_unresolved() {
    let path = vec![step(7, &["B1"])];
    let lineage = vec![(6, vec!["B1".to_string()])]; // slot 6 vs 7
    let r = resolve_path(&path, &lineage);
    assert!(matches!(r, PathMatch::Unresolved));
}

// --- Search-integration tests ---------------------------------------------
//
// These exercise `search()` with `forced_branches` populated, validating the
// sole / include / pair-pick semantics from spec
// `2026-04-24-navigator-rust-engine-design.md` § "Swap and Branch Semantics".

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

fn weights_blue() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.65, comp: 0.35 },
        pick1: PhaseWeights { info: 0.5, comp: 0.5 },
        ban2: PhaseWeights { info: 0.4, comp: 0.6 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8 },
    }
}

fn weights_red() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.7, comp: 0.3 },
        pick1: PhaseWeights { info: 0.6, comp: 0.4 },
        ban2: PhaseWeights { info: 0.5, comp: 0.5 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8 },
    }
}

fn ctx_with_pool(champs: &[&str]) -> EvalContext {
    let pool = pool_with(champs);
    let mut champion_meta = HashMap::new();
    for c in champs {
        champion_meta.insert(
            (*c).into(),
            ChampionMeta {
                id: (*c).into(),
                positions: vec![Role::Top],
            },
        );
    }
    EvalContext {
        side: Side::Blue,
        phase: Phase::Ban1,
        our_pool: pool.clone(),
        opp_pool: pool,
        our_picks: Vec::new(),
        opp_picks: Vec::new(),
        penalties: Penalties { out_of_role: 0.25, out_of_pool: 0.75 },
        champion_meta,
        meta: MetaData::default(),
        phase_weights_blue: weights_blue(),
        phase_weights_red: weights_red(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
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
fn sole_mode_replaces_children() {
    // Slot 6 is B1 (single pick). Without a force, search produces multiple
    // ranked children. With a sole-mode forced branch at slot 6, the engine
    // overrides the candidate set with [championId] — exactly one child,
    // user_injected = true.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let ctx = ctx_with_pool(&["A", "B", "C", "D"]);
    let cancel = CancelHandle::new();

    // Baseline: no force.
    let baseline_params = SearchParams {
        branch_width: 4,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
    let baseline = search(&state, &baseline_params, &ctx, &cancel).unwrap();
    assert!(
        baseline.children.len() > 1,
        "baseline must have multiple children to make the sole-replacement assertion meaningful"
    );

    // Forced.
    let forced_params = SearchParams {
        branch_width: 4,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![ForcedBranch {
            path: vec![],
            target_slot: 6,
            champion_id: "C".into(),
            mode: ForcedMode::Sole,
        }],
    };
    let forced = search(&state, &forced_params, &ctx, &cancel).unwrap();

    assert_eq!(
        forced.children.len(),
        1,
        "sole mode must replace candidate set with [championId]"
    );
    assert_eq!(forced.children[0].champion_ids, vec!["C".to_string()]);
    assert!(
        forced.children[0].user_injected,
        "forced child must carry user_injected = true"
    );
}

#[test]
fn include_mode_augments_children() {
    // Slot 6, pool of 4 champs with distinct win_rates. branch_width=2 keeps
    // top-2 (A, B). Include-mode force on D (worst-scoring) augments — final
    // children list is [A, B, D], with D user_injected = true.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut ctx = ctx_with_pool(&["A", "B", "C", "D"]);
    ctx.meta.win_rates.insert("A".into(), 0.95);
    ctx.meta.win_rates.insert("B".into(), 0.70);
    ctx.meta.win_rates.insert("C".into(), 0.50);
    ctx.meta.win_rates.insert("D".into(), 0.30);

    let cancel = CancelHandle::new();

    // Baseline: branch_width=2 → top 2 = [A, B], no D.
    let baseline_params = SearchParams {
        branch_width: 2,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
    let baseline = search(&state, &baseline_params, &ctx, &cancel).unwrap();
    let baseline_ids: Vec<&str> = baseline
        .children
        .iter()
        .map(|c| c.champion_ids[0].as_str())
        .collect();
    assert_eq!(baseline.children.len(), 2);
    assert!(!baseline_ids.contains(&"D"));

    // Include D — should add a 3rd child for D with user_injected=true.
    let forced_params = SearchParams {
        branch_width: 2,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![ForcedBranch {
            path: vec![],
            target_slot: 6,
            champion_id: "D".into(),
            mode: ForcedMode::Include,
        }],
    };
    let forced = search(&state, &forced_params, &ctx, &cancel).unwrap();

    assert_eq!(
        forced.children.len(),
        3,
        "include mode must augment top-N with the forced champion"
    );
    let d_child = forced
        .children
        .iter()
        .find(|c| c.champion_ids == vec!["D".to_string()])
        .expect("D must be present after include force");
    assert!(
        d_child.user_injected,
        "forced-included child must carry user_injected = true"
    );
    // The two non-D children should NOT be user_injected.
    let injected_count = forced.children.iter().filter(|c| c.user_injected).count();
    assert_eq!(
        injected_count, 1,
        "only the explicitly-forced champion is user_injected"
    );
}
