use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::forced_branches::{
    resolve_path, ForcedBranch, ForcedMode, PathMatch, PathStep,
};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search, search_with_stats, SearchParams};
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

#[test]
fn parent_lineage_resolves_after_swap() {
    // Two stacked sole-mode forces — the second's `path` points at the first's
    // forced node. From DraftState::default() (slots 0/1 are blue/red Ban1,
    // both single picks), force slot 0 → "X" and slot 1 → "Y" with path
    // anchored at (0, ["X"]). Depth-2 search must produce a single chain
    // X → Y, both user_injected.
    let state = DraftState::default();

    let ctx = ctx_with_pool(&["A", "B", "C", "X", "Y"]);
    let cancel = CancelHandle::new();

    let params = SearchParams {
        branch_width: 5,
        max_depth: 2,
        disable_alpha_beta: false,
        forced_branches: vec![
            ForcedBranch {
                path: vec![],
                target_slot: 0,
                champion_id: "X".into(),
                mode: ForcedMode::Sole,
            },
            ForcedBranch {
                path: vec![step(0, &["X"])],
                target_slot: 1,
                champion_id: "Y".into(),
                mode: ForcedMode::Sole,
            },
        ],
    };
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    assert_eq!(
        tree.children.len(),
        1,
        "outer sole force collapses to a single child"
    );
    let outer = &tree.children[0];
    assert_eq!(outer.champion_ids, vec!["X".to_string()]);
    assert!(outer.user_injected);

    assert_eq!(
        outer.children.len(),
        1,
        "inner sole force (path-anchored to the swap) collapses to single child"
    );
    let inner = &outer.children[0];
    assert_eq!(inner.champion_ids, vec!["Y".to_string()]);
    assert!(inner.user_injected);
}

#[test]
fn unresolved_path_drops_silently() {
    // A force whose `path` references a champion that's never picked anywhere
    // in the tree must (a) not error, (b) not appear in the tree, and (c)
    // bump SearchStats.forced_branches_dropped.
    let state = DraftState::default();
    let ctx = ctx_with_pool(&["A", "B", "C"]);
    let cancel = CancelHandle::new();

    let params = SearchParams {
        branch_width: 3,
        max_depth: 2,
        disable_alpha_beta: false,
        forced_branches: vec![ForcedBranch {
            // Path references "GHOST" at slot 0 — pool doesn't contain it, so
            // no actual lineage will ever match.
            path: vec![step(0, &["GHOST"])],
            target_slot: 1,
            champion_id: "Z".into(),
            mode: ForcedMode::Sole,
        }],
    };
    let (tree, stats) = search_with_stats(&state, &params, &ctx, &cancel).unwrap();

    // Tree should be the natural search — no Z anywhere because the force was
    // dropped.
    fn contains_champ(node: &engine_core::search::TreeNode, target: &str) -> bool {
        if node.champion_ids.iter().any(|c| c == target) {
            return true;
        }
        node.children.iter().any(|c| contains_champ(c, target))
    }
    assert!(
        !contains_champ(&tree, "Z"),
        "dropped force must not inject its champion into the tree"
    );

    assert_eq!(
        stats.forced_branches_dropped, 1,
        "unresolved path increments forced_branches_dropped"
    );
}

#[test]
fn resolves_after_sibling_rerank() {
    // The force's path is content-addressed: it matches by (slot, championIds),
    // not by sibling position. Two computes with different win_rates re-order
    // children at slot 0 (A first vs A last among siblings) — the force at
    // slot 1 anchored to (0, ["A"]) must resolve in both.
    let state = DraftState::default();
    let cancel = CancelHandle::new();

    fn run_with_winrates(
        state: &DraftState,
        winrates: &[(&str, f64)],
        cancel: &CancelHandle,
    ) -> engine_core::search::TreeNode {
        let mut ctx = ctx_with_pool(&["A", "B", "C"]);
        for (id, w) in winrates {
            ctx.meta.win_rates.insert((*id).into(), *w);
        }
        let params = SearchParams {
            branch_width: 3,
            max_depth: 2,
            disable_alpha_beta: false,
            forced_branches: vec![ForcedBranch {
                path: vec![step(0, &["A"])],
                target_slot: 1,
                champion_id: "Y".into(),
                mode: ForcedMode::Sole,
            }],
        };
        search(state, &params, &ctx, cancel).unwrap()
    }

    fn find_a_child(
        tree: &engine_core::search::TreeNode,
    ) -> &engine_core::search::TreeNode {
        tree.children
            .iter()
            .find(|c| c.champion_ids == vec!["A".to_string()])
            .expect("A must be among children for branch_width=3")
    }

    // Compute 1: A ranked first.
    let tree_a_first = run_with_winrates(
        &state,
        &[("A", 0.9), ("B", 0.6), ("C", 0.3)],
        &cancel,
    );
    let a_first = find_a_child(&tree_a_first);
    assert_eq!(a_first.children.len(), 1, "force collapses slot 1 to one child");
    assert_eq!(a_first.children[0].champion_ids, vec!["Y".to_string()]);
    assert!(a_first.children[0].user_injected);

    // Compute 2: same pool but A ranked last (B and C now score higher).
    let tree_a_last = run_with_winrates(
        &state,
        &[("A", 0.3), ("B", 0.9), ("C", 0.6)],
        &cancel,
    );
    let a_last = find_a_child(&tree_a_last);
    assert_eq!(a_last.children.len(), 1, "force still resolves after sibling rerank");
    assert_eq!(a_last.children[0].champion_ids, vec!["Y".to_string()]);
    assert!(a_last.children[0].user_injected);
}

#[test]
fn pair_start_force_optimizes_pair_end() {
    // Slot 7 is R1 (pair_start). With a sole-mode force at slot 7 → "A",
    // every pair child must carry "A" as first half. Pair_end (R2) varies
    // across the remaining candidates.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 7);
    assert!(TURN_SEQUENCE[state.turn_index()].pair_start);

    let ctx = ctx_with_pool(&["A", "B", "C", "D", "E"]);
    let cancel = CancelHandle::new();

    let params = SearchParams {
        branch_width: 10,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![ForcedBranch {
            path: vec![],
            target_slot: 7,
            champion_id: "A".into(),
            mode: ForcedMode::Sole,
        }],
    };
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    assert!(!tree.children.is_empty(), "must produce at least one pair child");
    assert_eq!(
        tree.children.len(),
        4,
        "pool size 5 minus the forced champion = 4 pair partners"
    );
    for child in &tree.children {
        assert_eq!(child.champion_ids.len(), 2);
        assert_eq!(
            child.champion_ids[0], "A",
            "pair_start half must be the forced champion"
        );
        assert_ne!(child.champion_ids[1], "A", "pair_end half must differ from forced");
        assert_eq!(child.slots, vec![7, 8]);
        assert!(child.user_injected, "forced-pair children carry user_injected = true");
    }
}
