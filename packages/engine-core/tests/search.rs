use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search, search_with_stats, SearchParams};
use std::collections::HashMap;

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
            ChampionMeta { id: (*c).into(), positions: vec![Role::Top] },
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
fn terminal_node_evaluated() {
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 20);
    let cancel = CancelHandle::new();
    let ctx = ctx_with_pool(&[]);
    let params = SearchParams::default();
    let tree = search(&state, &params, &ctx, &cancel).expect("terminal must produce a tree");
    assert_eq!(tree.children.len(), 0, "terminal node has no children");
}

#[test]
fn pick_turn_yields_branch_width_children() {
    // Skip past the 6 ban slots so we land on slot 6 (B1 — blue's first pick).
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let ctx = ctx_with_pool(&["A", "B", "C", "D", "E", "F"]);
    let params = SearchParams { branch_width: 5, max_depth: 1 };
    let cancel = CancelHandle::new();

    let tree = search(&state, &params, &ctx, &cancel).unwrap();
    assert_eq!(
        tree.children.len(),
        5,
        "search must respect branch_width=5 from a 6-champ pool"
    );
}

#[test]
fn ranks_candidates_by_static_score() {
    // Different win_rates produce different compStrengths → different composites.
    // The top-scoring candidate should appear first in the children list.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut ctx = ctx_with_pool(&["A", "B", "C"]);
    ctx.meta.win_rates.insert("A".into(), 0.95);
    ctx.meta.win_rates.insert("B".into(), 0.50);
    ctx.meta.win_rates.insert("C".into(), 0.05);

    let params = SearchParams { branch_width: 3, max_depth: 1 };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    assert_eq!(tree.children.len(), 3);
    // First-ranked child is A (highest static score).
    assert_eq!(tree.children[0].champion_ids, vec!["A".to_string()]);
    // Last-ranked is C.
    assert_eq!(
        tree.children.last().unwrap().champion_ids,
        vec!["C".to_string()]
    );
}

#[test]
fn pair_start_yields_pair_children() {
    // Slot 7 is the R1 pair_start. Fast-forward to it.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 7);
    assert!(TURN_SEQUENCE[state.turn_index()].pair_start);

    let ctx = ctx_with_pool(&["A", "B", "C", "D"]);
    let params = SearchParams { branch_width: 3, max_depth: 1 };
    let cancel = CancelHandle::new();

    let tree = search(&state, &params, &ctx, &cancel).unwrap();
    assert!(!tree.children.is_empty());
    for child in &tree.children {
        assert_eq!(
            child.champion_ids.len(),
            2,
            "pair child must carry 2 championIds"
        );
        assert_eq!(
            child.slots.len(),
            2,
            "pair child must occupy 2 slots"
        );
        assert_eq!(child.slots, vec![7, 8]);
    }
}

#[test]
fn pair_consumes_two_slots_in_recursion() {
    // After R1-R2 pair, the next turn should be slot 9 (B2 pair_start) — depth-2 search
    // should produce a child whose champion_ids has length 2 AND its sub-children also
    // have championIds.len() == 2 (since slot 9 is also a pair_start).
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 7);

    let ctx = ctx_with_pool(&["A", "B", "C", "D", "E", "F"]);
    let params = SearchParams { branch_width: 2, max_depth: 2 };
    let cancel = CancelHandle::new();

    let tree = search(&state, &params, &ctx, &cancel).unwrap();
    assert!(!tree.children.is_empty());
    let first = &tree.children[0];
    assert_eq!(first.champion_ids.len(), 2);
    // Sub-tree below should be at slot 9 (B2-B3 pair).
    if let Some(grandchild) = first.children.first() {
        assert_eq!(
            grandchild.champion_ids.len(),
            2,
            "grandchild at next pair (slot 9) must also be a pair node"
        );
        assert_eq!(grandchild.slots, vec![9, 10]);
    }
}

#[test]
fn transposition_cache_populates_during_search() {
    // A multi-depth search should populate the cache with at least one entry.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let ctx = ctx_with_pool(&["A", "B", "C"]);
    let params = SearchParams { branch_width: 3, max_depth: 3 };
    let cancel = CancelHandle::new();

    let (_tree, stats) = search_with_stats(&state, &params, &ctx, &cancel).unwrap();
    assert!(
        stats.cache_entries > 0,
        "transposition cache must be populated during recursion"
    );
}

#[test]
fn opp_turn_minimizes_our_value() {
    // At opponent's turn, we expect the search to assume they pick the choice
    // that hurts us most. With a single-depth lookahead and opp's pool = ours,
    // the back-propagated value at the root after their choice should equal
    // the score of the LOWEST-scoring move (worst for us).
    let mut state = DraftState::default();
    // Slot 1 is red ban1 (opponent for blue side). Push one blue ban first.
    state.blue_bans.push("filler0".into());
    assert_eq!(state.turn_index(), 1);
    assert_eq!(TURN_SEQUENCE[1].side, Side::Red);

    let mut ctx = ctx_with_pool(&["A", "B"]);
    ctx.meta.win_rates.insert("A".into(), 0.9);
    ctx.meta.win_rates.insert("B".into(), 0.1);

    let params = SearchParams { branch_width: 2, max_depth: 1 };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();
    // Root is opponent's turn. Best-for-them = worst-for-us.
    // Tree rendering still sorts children DESC by composite, but the back-propagated
    // `tree.scores.composite` should reflect their min of the two options.
    let composites: Vec<f64> = tree.children.iter().map(|c| c.scores.composite).collect();
    let min_observed = composites
        .iter()
        .cloned()
        .fold(f64::INFINITY, |a, b| a.min(b));
    assert!(
        (tree.scores.composite - min_observed).abs() < 1e-9,
        "opponent's minimax pick must equal the min child value: tree={} children={:?}",
        tree.scores.composite,
        composites
    );
}
