//! Top-K pair recursion (`SearchParams::single_pair_top_k`).
//!
//! `expand_pair` sorts its feasible pairs by static score and recurses into
//! the first K only. At the search ROOT the remaining pairs stay in the fan as
//! `unsearched` leaf children (statically evaluated, never backed up, never a
//! scenario) so the ranked list the user browses is still complete; inner pair
//! nodes are truncated to K outright. K = 0 or K ≥ width is today's behaviour.
//!
//! Why: after Blue Pick 1 (slot 6) the next two turns are BOTH pairs, so depth
//! 2 was up to 500 root pairs × a full pair expansion each — 6+ minutes on a
//! real state (memory `project_engine_search_budget` § 5).

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use engine_core::scenarios::extract_scenarios;
use engine_core::search::{search, SearchParams, TreeNode};
use std::collections::HashMap;

const POOL: [&str; 8] = ["A", "B", "C", "D", "E", "F", "G", "H"];

fn weights() -> PhaseWeightTable {
    let w = PhaseWeights { info: 0.5, comp: 0.5, coverage: 0.0 };
    PhaseWeightTable { ban1: w, pick1: w, ban2: w, pick2: w }
}

/// Distinct win rates so the static pair order is strict, roles cycling so
/// every pair is feasible.
fn ctx() -> EvalContext {
    let role_cycle = [Role::Top, Role::Jungle, Role::Middle, Role::Adc, Role::Support];
    let mut champion_meta = HashMap::new();
    let mut win_rates = HashMap::new();
    for (i, c) in POOL.iter().enumerate() {
        champion_meta.insert(
            (*c).to_string(),
            ChampionMeta {
                id: (*c).to_string(),
                positions: vec![role_cycle[i % role_cycle.len()]],
                ..Default::default()
            },
        );
        win_rates.insert((*c).to_string(), 0.40 + 0.03 * i as f64);
    }
    // Blue's confirmed pick at slot 6 needs a role, or the feasibility
    // matching at the B2+B3 pair fails for every pair (a champion without
    // meta has an empty role mask) and the searched pairs have no children.
    champion_meta.insert(
        "filler6".to_string(),
        ChampionMeta {
            id: "filler6".to_string(),
            positions: vec![Role::Support],
            ..Default::default()
        },
    );
    let pool = TeamPool {
        display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
        search: POOL.iter().map(|c| (*c).to_string()).collect(),
    };
    EvalContext {
        side: Side::Blue,
        phase: Phase::Pick1,
        our_pool: pool.clone(),
        opp_pool: pool,
        our_picks: Vec::new(),
        opp_picks: Vec::new(),
        penalties: Penalties { out_of_role: 0.25, out_of_pool: 0.75 },
        champion_meta,
        meta: MetaData { win_rates, ..Default::default() },
        phase_weights_blue: weights(),
        phase_weights_red: weights(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
        fm: None,
    }
}

/// Slot 7: R1+R2 pair start, followed by the B2+B3 pair at slot 9.
fn pair_then_pair_state() -> DraftState {
    let mut state = DraftState::default();
    for i in 0..7 {
        let id = format!("filler{i}");
        match (TURN_SEQUENCE[i].action_type, TURN_SEQUENCE[i].side) {
            (ActionType::Ban, Side::Blue) => state.blue_bans.push(id),
            (ActionType::Ban, Side::Red) => state.red_bans.push(id),
            (ActionType::Pick, Side::Blue) => state.blue_picks.push(id),
            (ActionType::Pick, Side::Red) => state.red_picks.push(id),
        }
    }
    assert!(TURN_SEQUENCE[state.turn_index()].pair_start);
    state
}

fn params(top_k: usize) -> SearchParams {
    SearchParams {
        branch_width: 5,
        pair_branch_width: 500,
        max_depth: 2,
        disable_alpha_beta: true,
        single_pair_top_k: top_k,
        forced_branches: vec![],
    }
}

fn run(top_k: usize) -> TreeNode {
    search(&pair_then_pair_state(), &params(top_k), &ctx(), &CancelHandle::new()).unwrap()
}

fn searched(tree: &TreeNode) -> Vec<&TreeNode> {
    tree.children.iter().filter(|c| !c.unsearched).collect()
}

fn unsearched(tree: &TreeNode) -> Vec<&TreeNode> {
    tree.children.iter().filter(|c| c.unsearched).collect()
}

#[test]
fn only_the_first_k_pairs_are_recursed_and_the_rest_stay_in_the_root_fan_as_leaves() {
    let all = run(0);
    let width = all.children.len();
    assert!(width > 3, "fixture must have more feasible pairs than K; got {width}");

    let tree = run(3);
    assert_eq!(tree.children.len(), width, "the root fan still lists every feasible pair");
    assert_eq!(searched(&tree).len(), 3, "exactly K pairs are searched");
    assert_eq!(unsearched(&tree).len(), width - 3);
    for child in searched(&tree) {
        assert!(
            !child.children.is_empty(),
            "a searched pair at depth 2 has the next pair below it"
        );
        assert_eq!(child.children[0].slots, vec![9, 10]);
    }
    for child in unsearched(&tree) {
        assert!(child.children.is_empty(), "an unsearched pair is a leaf");
        assert_eq!(child.champion_ids.len(), 2, "same wire shape as any pair child");
        assert_eq!(child.slots, vec![7, 8]);
        assert!(child.scores.composite.is_finite(), "statically scored, not a placeholder");
    }
    let first_unsearched = tree.children.iter().position(|c| c.unsearched).unwrap();
    assert!(
        tree.children[first_unsearched..].iter().all(|c| c.unsearched),
        "searched pairs are listed before unsearched ones"
    );
}

#[test]
fn the_searched_pairs_are_the_top_k_by_static_score() {
    // With K = 0 every pair is searched and `children` is sorted by the
    // backed-up composite. The static order is what `expand_pair` recurses
    // by; at this fixture the K = 1 winner must be the pair of the two
    // highest win rates.
    let tree = run(1);
    let winner = &searched(&tree)[0];
    let mut ids = winner.champion_ids.clone();
    ids.sort();
    assert_eq!(ids, vec!["G".to_string(), "H".to_string()]);
}

#[test]
fn k_zero_and_k_at_or_above_width_search_every_pair() {
    let all = run(0);
    assert!(unsearched(&all).is_empty(), "K = 0 disables the cap");
    let width = all.children.len();
    let wide = run(width);
    assert!(unsearched(&wide).is_empty(), "K = width searches every pair");
    assert_eq!(wide.children.len(), width);
    let wider = run(width + 100);
    assert!(unsearched(&wider).is_empty(), "K > width searches every pair");
}

#[test]
fn unsearched_pairs_never_back_up_into_the_root_value() {
    let tree = run(3);
    let turn_side = Side::Red; // slot 7 is Red's pair
    let best_searched = searched(&tree)
        .into_iter()
        .max_by(|a, b| {
            a.scores
                .composite_per_side
                .for_side(turn_side)
                .total_cmp(&b.scores.composite_per_side.for_side(turn_side))
        })
        .unwrap();
    assert_eq!(
        tree.scores.composite_per_side.for_side(Side::Blue),
        best_searched.scores.composite_per_side.for_side(Side::Blue)
    );
    assert_eq!(
        tree.scores.composite_per_side.for_side(Side::Red),
        best_searched.scores.composite_per_side.for_side(Side::Red)
    );
}

#[test]
fn inner_pair_nodes_are_truncated_to_k_rather_than_listing_leaves() {
    // The fan the user browses is the root's; an inner pair node keeps only
    // the K pairs it searched (a leaf per non-recursed pair at every inner
    // node would cost a static evaluation each — the same bill top-K exists
    // to avoid).
    let tree = run(2);
    for child in searched(&tree) {
        assert_eq!(child.children.len(), 2, "inner pair node lists exactly K children");
        assert!(child.children.iter().all(|g| !g.unsearched));
    }
}

#[test]
fn scenarios_never_reference_an_unsearched_pair() {
    let state = pair_then_pair_state();
    let tree = run(2);
    let c = ctx();
    let scenarios = extract_scenarios(&tree, &c.champion_meta, 5, &state.blue_picks, &state.red_picks);
    assert!(!scenarios.is_empty());
    let searched_keys: Vec<Vec<String>> = searched(&tree)
        .iter()
        .map(|n| {
            let mut ids = n.champion_ids.clone();
            ids.sort();
            ids
        })
        .collect();
    for s in &scenarios {
        let mut head = s.tree_path[0].champion_ids.clone();
        head.sort();
        assert!(
            searched_keys.contains(&head),
            "scenario {} starts at an unsearched pair {:?}",
            s.name,
            head
        );
        assert!(
            s.tree_path.len() >= 2,
            "a scenario below a searched pair carries the next decision too"
        );
    }
}
