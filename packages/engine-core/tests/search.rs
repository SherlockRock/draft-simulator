use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search, search_with_stats, SearchParams};
use proptest::prelude::*;
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
        ban1: PhaseWeights { info: 0.65, comp: 0.35, coverage: 0.0 },
        pick1: PhaseWeights { info: 0.5, comp: 0.5, coverage: 0.0 },
        ban2: PhaseWeights { info: 0.4, comp: 0.6, coverage: 0.0 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8, coverage: 0.0 },
    }
}

fn weights_red() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.7, comp: 0.3, coverage: 0.0 },
        pick1: PhaseWeights { info: 0.6, comp: 0.4, coverage: 0.0 },
        ban2: PhaseWeights { info: 0.5, comp: 0.5, coverage: 0.0 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8, coverage: 0.0 },
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
                ..Default::default()
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
    let params = SearchParams {
        branch_width: 5,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
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

    let params = SearchParams {
        branch_width: 3,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
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
    let params = SearchParams {
        branch_width: 3,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
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
    let params = SearchParams {
        branch_width: 2,
        max_depth: 2,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
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
    let params = SearchParams {
        branch_width: 3,
        max_depth: 3,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
    let cancel = CancelHandle::new();

    let (_tree, stats) = search_with_stats(&state, &params, &ctx, &cancel).unwrap();
    assert!(
        stats.cache_entries > 0,
        "transposition cache must be populated during recursion"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]

    #[test]
    fn alpha_beta_preserves_root_score(
        slot in 6usize..14,
        pattern_idx in 0usize..4,
        max_depth in 1usize..4,
    ) {
        let mut state = DraftState::default();
        fast_forward_to_slot(&mut state, slot);

        let mut ctx = ctx_with_pool(&["A", "B", "C", "D", "E"]);
        let patterns = [
            [0.9_f64, 0.6, 0.5, 0.3, 0.1],
            [0.5,     0.5, 0.5, 0.5, 0.5],
            [0.1,     0.8, 0.4, 0.7, 0.2],
            [0.95,    0.05, 0.6, 0.55, 0.5],
        ];
        let pat = patterns[pattern_idx];
        for (id, w) in ["A", "B", "C", "D", "E"].iter().zip(pat.iter()) {
            ctx.meta.win_rates.insert((*id).into(), *w);
        }

        let cancel = CancelHandle::new();
        let params_ab = SearchParams {
            branch_width: 5,
            max_depth,
            disable_alpha_beta: false,
            forced_branches: vec![],
        };
        let params_no_ab = SearchParams {
            branch_width: 5,
            max_depth,
            disable_alpha_beta: true,
            forced_branches: vec![],
        };

        let tree_ab = search(&state, &params_ab, &ctx, &cancel).unwrap();
        let tree_no_ab = search(&state, &params_no_ab, &ctx, &cancel).unwrap();

        prop_assert!(
            (tree_ab.scores.composite - tree_no_ab.scores.composite).abs() < 1e-6,
            "αβ root score must equal full-search at slot={} pat={} depth={}: ab={}, full={}",
            slot, pattern_idx, max_depth,
            tree_ab.scores.composite, tree_no_ab.scores.composite
        );
    }
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

    let params = SearchParams {
        branch_width: 2,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
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

#[test]
fn pick2_pair_seeding_includes_missing_role_specialists_via_bucket_2() {
    use engine_core::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };
    use engine_core::search::TreeNode;

    fn champ_with_winrate(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta {
            id: id.into(),
            positions,
            damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(),
            cc_profile: CcProfile::default(),
            tags: ChampionTags::default(),
        }
    }

    // Build state at Blue's pair_start at Pick2 (slot 17).
    // Counts at slot 17: blue_bans=5, red_bans=5, blue_picks=3, red_picks=4.
    let mut state = DraftState::default();
    state.blue_bans = vec!["B1".into(), "B2".into(), "B3".into(), "B4".into(), "B5".into()];
    state.red_bans = vec!["R1".into(), "R2".into(), "R3".into(), "R4".into(), "R5".into()];
    state.blue_picks = vec!["Garen".into(), "Amumu".into(), "Aurelion".into()];
    state.red_picks = vec!["Re1".into(), "Re2".into(), "Re3".into(), "Re4".into()];

    // Meta: confirmed picks, top filler with high win_rate, ADC/SUP specialists low win_rate.
    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    let mut win_rates: HashMap<String, f64> = HashMap::new();

    for (id, pos) in [
        ("Garen", vec![Role::Top]),
        ("Amumu", vec![Role::Jungle]),
        ("Aurelion", vec![Role::Middle]),
        ("Re1", vec![Role::Top]),
        ("Re2", vec![Role::Jungle]),
        ("Re3", vec![Role::Middle]),
        ("Re4", vec![Role::Adc]),
    ] {
        meta_map.insert(id.into(), champ_with_winrate(id, pos));
        win_rates.insert(id.into(), 0.5);
    }
    for id in ["B1", "B2", "B3", "B4", "B5", "R1", "R2", "R3", "R4", "R5"] {
        meta_map.insert(id.into(), champ_with_winrate(id, vec![]));
    }

    // Filler TOP/JG/MID candidates. Their composite at Pick2:
    //   weights.comp * 0.5 + weights.coverage * 0  (no coverage gain — role covered)
    // = 0.5
    // ADC/SUP specialists composite = 1.0 * 0.30 + 0.6 * 0.24 ≈ 0.444.
    // Specialists score LOWER than fillers, so they don't enter bucket-1's top-32.
    // Only bucket-2 (per_role_top) can surface them into pair seeding.
    let mut filler_pool: Vec<String> = Vec::new();
    for i in 0..40 {
        let id = format!("FillTop{}", i);
        meta_map.insert(id.clone(), champ_with_winrate(&id, vec![Role::Top]));
        win_rates.insert(id.clone(), 0.5);
        filler_pool.push(id);
    }
    for i in 0..40 {
        let id = format!("FillJg{}", i);
        meta_map.insert(id.clone(), champ_with_winrate(&id, vec![Role::Jungle]));
        win_rates.insert(id.clone(), 0.5);
        filler_pool.push(id);
    }
    for i in 0..40 {
        let id = format!("FillMid{}", i);
        meta_map.insert(id.clone(), champ_with_winrate(&id, vec![Role::Middle]));
        win_rates.insert(id.clone(), 0.5);
        filler_pool.push(id);
    }

    // ADC / SUP specialists with LOW win_rate. Their composite (~0.444) sits
    // below fillers (0.5), so they're not in bucket-1's single_top_k. The only
    // path into the pair-seed list is bucket-2's per_role_top (Pick2 wiring).
    let adc_specialists = vec!["AdcA".to_string(), "AdcB".to_string()];
    let sup_specialists = vec!["SupA".to_string(), "SupB".to_string()];
    for id in &adc_specialists {
        meta_map.insert(id.clone(), champ_with_winrate(id, vec![Role::Adc]));
        win_rates.insert(id.clone(), 0.30);
    }
    for id in &sup_specialists {
        meta_map.insert(id.clone(), champ_with_winrate(id, vec![Role::Support]));
        win_rates.insert(id.clone(), 0.30);
    }

    let our_pool = TeamPool {
        display: RolePoolMap {
            top: filler_pool
                .iter()
                .filter(|n| n.starts_with("FillTop"))
                .cloned()
                .collect(),
            jungle: filler_pool
                .iter()
                .filter(|n| n.starts_with("FillJg"))
                .cloned()
                .collect(),
            middle: filler_pool
                .iter()
                .filter(|n| n.starts_with("FillMid"))
                .cloned()
                .collect(),
            adc: adc_specialists.clone(),
            support: sup_specialists.clone(),
        },
        search: {
            let mut s = filler_pool.clone();
            s.extend(adc_specialists.clone());
            s.extend(sup_specialists.clone());
            s
        },
    };

    let pw_pick2 = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.6 };
    let pw_other = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    let pw_table = PhaseWeightTable {
        ban1: pw_other,
        pick1: pw_other,
        ban2: pw_other,
        pick2: pw_pick2,
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool,
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
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData {
            win_rates,
            synergies: vec![],
            counters: HashMap::new(),
        },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    };

    let params = SearchParams {
        // Large branch_width so bucket-2 pairs survive the final value-sort
        // truncate. With ~500 candidate pairs (496 bucket-1 + 4 bucket-2), all
        // bucket-2 pairs are at the bottom of the value-sorted list — branch_width
        // needs to be >= total to keep them.
        branch_width: 600,
        max_depth: 1,
        ..Default::default()
    };
    let cancel = CancelHandle::new();

    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    // Inspect tree.children. Each is a pair candidate (champion_ids has 2 entries).
    let pair_children: Vec<&TreeNode> = tree
        .children
        .iter()
        .filter(|c| c.champion_ids.len() == 2)
        .collect();

    // Assert at least one pair has an ADC + a SUP specialist.
    let has_adc_sup = pair_children.iter().any(|c| {
        let in_adc = c.champion_ids.iter().any(|id| adc_specialists.contains(id));
        let in_sup = c.champion_ids.iter().any(|id| sup_specialists.contains(id));
        in_adc && in_sup
    });

    assert!(
        has_adc_sup,
        "Bucket-2 pair seeding should produce an ADC+SUP pair. Got pairs: {:?}",
        pair_children
            .iter()
            .map(|c| &c.champion_ids)
            .collect::<Vec<_>>(),
    );
}
