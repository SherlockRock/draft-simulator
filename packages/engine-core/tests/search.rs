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
    // Cycle through all 5 roles so a pool of ≥5 champs can satisfy feasibility
    // even with strict single-role positions.
    let role_cycle = [
        Role::Top, Role::Jungle, Role::Middle, Role::Adc, Role::Support,
    ];
    let mut champion_meta = HashMap::new();
    for (i, c) in champs.iter().enumerate() {
        let role = role_cycle[i % role_cycle.len()];
        champion_meta.insert(
            (*c).into(),
            ChampionMeta {
                id: (*c).into(),
                positions: vec![role],
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
        pair_branch_width: 5,
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
    // Pool needs ≥5 diverse-role champs so feasibility passes at Pick1 (5 picks
    // remaining). D and E are filler champs with low win_rates to ensure A,B,C
    // remain the top-3 by composite.
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, 6);

    let mut ctx = ctx_with_pool(&["A", "B", "C", "D", "E"]);
    ctx.meta.win_rates.insert("A".into(), 0.95);
    ctx.meta.win_rates.insert("B".into(), 0.50);
    ctx.meta.win_rates.insert("C".into(), 0.05);
    // D and E score lower than C to stay out of top-3.
    ctx.meta.win_rates.insert("D".into(), 0.03);
    ctx.meta.win_rates.insert("E".into(), 0.01);

    let params = SearchParams {
        branch_width: 3,
        pair_branch_width: 3,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    assert_eq!(tree.children.len(), 3);
    // First-ranked child is A (highest static score).
    assert_eq!(tree.children[0].champion_ids, vec!["A".to_string()]);
    // Last-ranked is C (D and E score lower but are cut by branch_width=3).
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
        pair_branch_width: 3,
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
        pair_branch_width: 2,
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
        pair_branch_width: 3,
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
            pair_branch_width: 5,
            max_depth,
            disable_alpha_beta: false,
            forced_branches: vec![],
        };
        let params_no_ab = SearchParams {
            branch_width: 5,
            pair_branch_width: 5,
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
    // At opponent's pick turn, the search assumes they pick the choice that
    // hurts us most. With a single-depth lookahead and 2 candidates, the
    // back-propagated value should equal the score of the LOWEST-scoring move.
    //
    // Use slot 16 (Red Pick2 single) where red is the mover and blue (ctx.side)
    // is the perspective. Build state with 3 picks per side so feasibility holds:
    // red has 2 picks remaining (slots 16, 19) and a 2-champ pool (ADC+SUP).
    // Two locked red picks (TOP, JG) + 2 remaining → total=4... wait, red needs
    // 5 total. Use 3 locked picks + pool of 2 → remaining=2, pool=2 → feasible.
    use engine_core::role_solver::{CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile};
    use engine_core::evaluator::PhaseWeights;

    fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta { id: id.into(), positions, damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(), cc_profile: CcProfile::default(),
            tags: ChampionTags::default() }
    }

    // Slot 16: 5 blue bans + 5 red bans + 3 blue picks + 3 red picks = 16.
    let mut state = DraftState::default();
    state.blue_bans = vec!["Bb1".into(),"Bb2".into(),"Bb3".into(),"Bb4".into(),"Bb5".into()];
    state.red_bans  = vec!["Rb1".into(),"Rb2".into(),"Rb3".into(),"Rb4".into(),"Rb5".into()];
    state.blue_picks = vec!["Bp1".into(),"Bp2".into(),"Bp3".into()];
    state.red_picks  = vec!["Rp1".into(),"Rp2".into(),"Rp3".into()];
    assert_eq!(state.turn_index(), 16);
    assert_eq!(TURN_SEQUENCE[16].side, Side::Red);

    // Champion meta: locked picks have distinct roles; A=ADC and B=SUP in pool.
    // With 3 red picks locked at TOP/JG/MID + pool {A(ADC), B(SUP)}, red
    // can pick any of A or B and still complete a 5-role comp at slot 19.
    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    for (id, pos) in [("Rp1", Role::Top),("Rp2", Role::Jungle),("Rp3", Role::Middle),
                      ("Bp1", Role::Top),("Bp2", Role::Jungle),("Bp3", Role::Middle)] {
        meta_map.insert(id.into(), champ(id, vec![pos]));
    }
    for id in ["Bb1","Bb2","Bb3","Bb4","Bb5","Rb1","Rb2","Rb3","Rb4","Rb5"] {
        meta_map.insert(id.into(), champ(id, vec![]));
    }
    meta_map.insert("A".into(), champ("A", vec![Role::Adc]));
    meta_map.insert("B".into(), champ("B", vec![Role::Support]));

    let pw = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    let pw_table = PhaseWeightTable { ban1: pw, pick1: pw, ban2: pw, pick2: pw };

    let red_pool = TeamPool {
        display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec!["A".into()], support: vec!["B".into()] },
        search: vec!["A".into(), "B".into()],
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        opp_pool: red_pool,
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData {
            win_rates: HashMap::from([("A".to_string(), 0.9), ("B".to_string(), 0.1)]),
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
        branch_width: 2,
        pair_branch_width: 2,
        max_depth: 1,
        disable_alpha_beta: false,
        forced_branches: vec![],
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();
    // Root is opponent's (red's) pick turn. Best-for-them = worst-for-us.
    // Tree rendering still sorts children DESC by composite, but the back-propagated
    // `tree.scores.composite` should reflect their min of the two options.
    let composites: Vec<f64> = tree.children.iter().map(|c| c.scores.composite).collect();
    assert_eq!(composites.len(), 2, "both red pick candidates must appear");
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

// === Regression tests: bucket-2 protection at small caps ====================
//
// Two coupled invariants the engine must preserve at Pick2 pair turns:
//
//   1. `seed_pair_candidates` must always emit bucket-2 (per-role specialist)
//      pairs in full, even when `max_pairs` is small enough that bucket-1
//      alone would crowd them out via the lexical sort. Pre-fix, all 64
//      bucket-2 pairs were dropped at max_pairs=20 because lexically-early
//      bucket-1 pairs (e.g. all (Aatrox, *)) consumed the entire cap.
//
//   2. End-to-end search at production-equivalent settings (branch_width=5,
//      pair_branch_width=500 from SearchParams::default()) must surface at
//      least one ADC+SUP specialist pair when the only role coverage gap
//      can be closed by them.
//
// Pre-fix symptoms (preserved for documentation): role-mismatched comps with
// off-role champions in the ADC/SUP slots that role_solver later mislabels.

#[test]
fn seed_pair_candidates_protects_bucket_2_against_small_max_pairs() {
    use engine_core::pair_filter::{seed_pair_candidates, PairFilterConfig};

    // Mimic the production bucket-1 top-32 by score: filler champions whose
    // names span A–G. The alphabetically-earliest champion will dominate
    // bucket-1's lexical fill — pre-fix this consumed the whole cap.
    let mut top_singles: Vec<(&str, f64)> = Vec::new();
    let names = [
        "Aatrox", "Ahri", "Akali", "Akshan", "Alistar", "Amumu", "Anivia",
        "Annie", "Ashe", "Aurelion", "Bard", "Blitzcrank", "Brand", "Braum",
        "Caitlyn", "Camille", "Cassiopeia", "Chogath", "Corki", "Darius",
        "Diana", "Draven", "Ekko", "Elise", "Evelynn", "Ezreal", "Fiddlesticks",
        "Fiora", "Fizz", "Galio", "Gangplank", "Garen",
    ];
    for n in &names {
        top_singles.push((n, 0.50));
    }
    assert_eq!(top_singles.len(), 32, "this test wants single_top_k=32");

    let role_a_top: Vec<&str> = vec!["Aphelios", "Caitlyn", "Ezreal", "Jhin", "Kaisa", "Lucian", "Sivir", "Vayne"];
    let role_b_top: Vec<&str> = vec!["Lulu", "Nami", "Thresh", "Janna", "Karma", "Pyke", "Rakan", "Soraka"];

    let cfg = PairFilterConfig {
        single_top_k: 32,
        per_role_top: 8,
        // Tight cap: 8x8 - dedup gives ~64 bucket-2 pairs alone. The fix
        // must protect them anyway.
        max_pairs: 20,
    };

    let buckets = vec![(role_a_top.clone(), role_b_top.clone())];
    let pairs = seed_pair_candidates(&top_singles, &buckets, None, &cfg);

    let bucket2_survivors: Vec<&engine_core::pair_filter::PairCandidate> = pairs
        .iter()
        .filter(|p| {
            let in_adc = role_a_top.contains(&p.first.as_str()) || role_a_top.contains(&p.second.as_str());
            let in_sup = role_b_top.contains(&p.first.as_str()) || role_b_top.contains(&p.second.as_str());
            in_adc && in_sup
        })
        .collect();

    assert!(
        !bucket2_survivors.is_empty(),
        "bucket-2 pairs must survive max_pairs={} regardless of bucket-1 lexical fill. \
         Got {} pairs, of which {} are bucket-2.",
        cfg.max_pairs, pairs.len(), bucket2_survivors.len(),
    );
}

#[test]
fn pick2_pair_seeding_surfaces_specialists_at_production_branch_width() {
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

    // Twin of pick2_pair_seeding_includes_missing_role_specialists_via_bucket_2,
    // but at production-equivalent settings (branch_width=5, pair_branch_width
    // inherited from SearchParams::default()=500). The earlier test uses
    // branch_width=600 to bypass per-pair-search caps; this test verifies the
    // fix holds at the smaller widths the engine actually runs at.
    let mut state = DraftState::default();
    state.blue_bans = vec!["B1".into(), "B2".into(), "B3".into(), "B4".into(), "B5".into()];
    state.red_bans = vec!["R1".into(), "R2".into(), "R3".into(), "R4".into(), "R5".into()];
    state.blue_picks = vec!["Garen".into(), "Amumu".into(), "Aurelion".into()];
    state.red_picks = vec!["Re1".into(), "Re2".into(), "Re3".into(), "Re4".into()];

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
            top: filler_pool.iter().filter(|n| n.starts_with("FillTop")).cloned().collect(),
            jungle: filler_pool.iter().filter(|n| n.starts_with("FillJg")).cloned().collect(),
            middle: filler_pool.iter().filter(|n| n.starts_with("FillMid")).cloned().collect(),
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
        ban1: pw_other, pick1: pw_other, ban2: pw_other, pick2: pw_pick2,
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool,
        opp_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData { win_rates, synergies: vec![], counters: HashMap::new() },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    };

    let params = SearchParams {
        // navigatorEngine.js production values.
        branch_width: 5,
        pair_branch_width: 500,
        max_depth: 1,
        ..Default::default()
    };
    let cancel = CancelHandle::new();

    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    let pair_children: Vec<&TreeNode> = tree
        .children
        .iter()
        .filter(|c| c.champion_ids.len() == 2)
        .collect();

    let has_adc_sup = pair_children.iter().any(|c| {
        let in_adc = c.champion_ids.iter().any(|id| adc_specialists.contains(id));
        let in_sup = c.champion_ids.iter().any(|id| sup_specialists.contains(id));
        in_adc && in_sup
    });

    assert!(
        has_adc_sup,
        "ADC+SUP specialist pair must surface at production widths. Pairs: {:?}",
        pair_children.iter().map(|c| &c.champion_ids).collect::<Vec<_>>(),
    );
}

#[test]
fn leaf_eval_rewards_whole_comp_role_coverage() {
    // Two terminal states with identical win_rates (so the per-pick composite
    // sum is the same), differing only in role distribution:
    //   balanced   = TOP, JG, MID, ADC, SUP — coverage_score = 1.0
    //   mismatched = TOP, MID, MID, ADC, ADC — coverage_score ≈ 0.158
    //
    // Pre-fix, eval_state ignored coverage at the leaf (the per-pick
    // role_coverage component is 0 by construction because
    // coverage_marginal_gain receives picks that already contain the candidate).
    // Post-fix, eval_state adds weights.coverage * coverage_score(picks) once,
    // so the balanced comp scores strictly higher.
    use engine_core::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };

    fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta {
            id: id.into(),
            positions,
            damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(),
            cc_profile: CcProfile::default(),
            tags: ChampionTags::default(),
        }
    }

    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    let mut win_rates: HashMap<String, f64> = HashMap::new();

    let balanced = [
        ("BTop", Role::Top),
        ("BJng", Role::Jungle),
        ("BMid", Role::Middle),
        ("BAdc", Role::Adc),
        ("BSup", Role::Support),
    ];
    for (id, role) in &balanced {
        meta_map.insert((*id).into(), champ(id, vec![*role]));
        win_rates.insert((*id).into(), 0.5);
    }

    let mismatched = [
        ("MTop", Role::Top),
        ("MMid1", Role::Middle),
        ("MMid2", Role::Middle),
        ("MAdc1", Role::Adc),
        ("MAdc2", Role::Adc),
    ];
    for (id, role) in &mismatched {
        meta_map.insert((*id).into(), champ(id, vec![*role]));
        win_rates.insert((*id).into(), 0.5);
    }

    // Filler bans + red picks (terminal state needs 5 each).
    for id in ["bb1","bb2","bb3","bb4","bb5","rb1","rb2","rb3","rb4","rb5","rp1","rp2","rp3","rp4","rp5"] {
        meta_map.insert(id.into(), champ(id, vec![]));
    }

    fn build_state(blue_picks: &[&str]) -> DraftState {
        let mut state = DraftState::default();
        state.blue_bans = ["bb1","bb2","bb3","bb4","bb5"].iter().map(|s| s.to_string()).collect();
        state.red_bans = ["rb1","rb2","rb3","rb4","rb5"].iter().map(|s| s.to_string()).collect();
        state.blue_picks = blue_picks.iter().map(|s| s.to_string()).collect();
        state.red_picks = ["rp1","rp2","rp3","rp4","rp5"].iter().map(|s| s.to_string()).collect();
        state
    }

    let pw = PhaseWeights { info: 0.0, comp: 0.8, coverage: 0.6 };
    let pw_table = PhaseWeightTable { ban1: pw, pick1: pw, ban2: pw, pick2: pw };

    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        opp_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        our_picks: vec![],
        opp_picks: vec![],
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData { win_rates, synergies: vec![], counters: HashMap::new() },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    };

    let params = SearchParams::default();
    let cancel = CancelHandle::new();

    let balanced_state = build_state(&["BTop", "BJng", "BMid", "BAdc", "BSup"]);
    let mismatched_state = build_state(&["MTop", "MMid1", "MMid2", "MAdc1", "MAdc2"]);

    let tree_balanced = search(&balanced_state, &params, &ctx, &cancel).unwrap();
    let tree_mismatched = search(&mismatched_state, &params, &ctx, &cancel).unwrap();

    // Per-pick composite sum is identical (same win_rates, no other signals).
    // Difference must come from the whole-comp coverage signal we add once
    // in eval_state.
    assert!(
        tree_balanced.scores.composite > tree_mismatched.scores.composite,
        "balanced comp must outvalue mismatched comp at terminal leaf. \
         balanced composite={}, mismatched composite={} (delta={})",
        tree_balanced.scores.composite,
        tree_mismatched.scores.composite,
        tree_balanced.scores.composite - tree_mismatched.scores.composite,
    );
}

// === Issue 1 reproducers (per handoff 2026-04-30) ===========================
//
// At Pick2 pair_start (B4+B5 = slot 17), production reports role-mismatched
// pairs winning the displayed top-N over role-completing pairs. Two coupled
// suspects:
//
//   1a. `expand_pair`'s bucket-2 logic only takes the first two missing roles
//       when constructing per-role bucket pairs. With 3+ missing, only one of
//       the three unordered pair-shapes is seeded; the other two never enter
//       the candidate set.
//
//   1b. Even when bucket-2 pairs ARE seeded, the leaf-eval coverage signal
//       (`weights.coverage * coverage_score(picks)`) may be too weak versus
//       the per-pick win-rate sum to swing the back-prop ordering.
//
// Tests below pin down which of these actually fires under current code.

#[test]
fn pick2_pair_three_missing_roles_seeds_all_unordered_pair_shapes() {
    // Reproduces 1a: blue's 3 picks all sit in TOP/MID — so JG, ADC, SUP are
    // all missing at threshold 0.9. A complete fix should seed bucket-2 pairs
    // for ALL three unordered missing-role combinations: (JG×ADC), (JG×SUP),
    // (ADC×SUP). Pre-fix, only the first combination is built.
    //
    // Construction note: specialists score lower than fillers via the
    // win-rate gradient (specialists 0.30, fillers 0.50). At Pick2 the
    // single-score for a specialist gets a coverage_marginal_gain bonus, but
    // we deliberately keep that small here by giving filler fixed-role pools
    // (TOP/MID only). Specialists must therefore enter pair-seeding via
    // bucket-2 — bucket-1's top_k will be filler-dominated.
    use engine_core::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };
    use engine_core::search::TreeNode;

    fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta {
            id: id.into(),
            positions,
            damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(),
            cc_profile: CcProfile::default(),
            tags: ChampionTags::default(),
        }
    }

    // Slot 17: blue_picks=3 (all TOP/MID), red_picks=4. Missing for blue:
    // JG, ADC, SUP — 3 missing roles.
    let mut state = DraftState::default();
    state.blue_bans = vec!["B1".into(), "B2".into(), "B3".into(), "B4".into(), "B5".into()];
    state.red_bans = vec!["R1".into(), "R2".into(), "R3".into(), "R4".into(), "R5".into()];
    state.blue_picks = vec!["GarenTop".into(), "AurelionMid".into(), "AmbessaTop".into()];
    state.red_picks = vec!["Re1".into(), "Re2".into(), "Re3".into(), "Re4".into()];

    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    let mut win_rates: HashMap<String, f64> = HashMap::new();

    for (id, pos) in [
        ("GarenTop", vec![Role::Top]),
        ("AurelionMid", vec![Role::Middle]),
        ("AmbessaTop", vec![Role::Top]),
        ("Re1", vec![Role::Top]),
        ("Re2", vec![Role::Jungle]),
        ("Re3", vec![Role::Middle]),
        ("Re4", vec![Role::Adc]),
    ] {
        meta_map.insert(id.into(), champ(id, pos));
        win_rates.insert(id.into(), 0.5);
    }
    for id in ["B1","B2","B3","B4","B5","R1","R2","R3","R4","R5"] {
        meta_map.insert(id.into(), champ(id, vec![]));
    }

    // Filler TOP / MID candidates dominate bucket-1's single_top_k by sheer
    // count at high win-rate. Specialists (JG, ADC, SUP) live at low win-rate
    // and must enter via bucket-2 only.
    let mut filler_pool: Vec<String> = Vec::new();
    for i in 0..40 {
        let id = format!("FillTop{}", i);
        meta_map.insert(id.clone(), champ(&id, vec![Role::Top]));
        win_rates.insert(id.clone(), 0.5);
        filler_pool.push(id);
    }
    for i in 0..40 {
        let id = format!("FillMid{}", i);
        meta_map.insert(id.clone(), champ(&id, vec![Role::Middle]));
        win_rates.insert(id.clone(), 0.5);
        filler_pool.push(id);
    }

    let jg_specialists = vec!["JgA".to_string(), "JgB".to_string()];
    let adc_specialists = vec!["AdcA".to_string(), "AdcB".to_string()];
    let sup_specialists = vec!["SupA".to_string(), "SupB".to_string()];
    for id in jg_specialists.iter().chain(adc_specialists.iter()).chain(sup_specialists.iter()) {
        let role = if jg_specialists.contains(id) { Role::Jungle }
            else if adc_specialists.contains(id) { Role::Adc }
            else { Role::Support };
        meta_map.insert(id.clone(), champ(id, vec![role]));
        win_rates.insert(id.clone(), 0.30);
    }

    let our_pool = TeamPool {
        display: RolePoolMap {
            top: filler_pool.iter().filter(|n| n.starts_with("FillTop")).cloned().collect(),
            jungle: jg_specialists.clone(),
            middle: filler_pool.iter().filter(|n| n.starts_with("FillMid")).cloned().collect(),
            adc: adc_specialists.clone(),
            support: sup_specialists.clone(),
        },
        search: {
            let mut s = filler_pool.clone();
            s.extend(jg_specialists.clone());
            s.extend(adc_specialists.clone());
            s.extend(sup_specialists.clone());
            s
        },
    };

    let pw_pick2 = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.6 };
    let pw_other = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    let pw_table = PhaseWeightTable {
        ban1: pw_other, pick1: pw_other, ban2: pw_other, pick2: pw_pick2,
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool,
        opp_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData { win_rates, synergies: vec![], counters: HashMap::new() },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    };

    // High branch_width to bypass per-pair value-sort truncation. The point
    // of this test is "did bucket-2 SEED these pairs", not "do they survive
    // the truncation". A separate end-to-end test covers production widths.
    let params = SearchParams {
        branch_width: 800,
        pair_branch_width: 800,
        max_depth: 1,
        ..Default::default()
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    let pair_children: Vec<&TreeNode> = tree.children.iter()
        .filter(|c| c.champion_ids.len() == 2)
        .collect();

    let pair_has_roles = |c: &&TreeNode, set_a: &[String], set_b: &[String]| -> bool {
        let in_a = c.champion_ids.iter().any(|id| set_a.contains(id));
        let in_b = c.champion_ids.iter().any(|id| set_b.contains(id));
        in_a && in_b
    };

    let has_jg_adc = pair_children.iter().any(|c| pair_has_roles(c, &jg_specialists, &adc_specialists));
    let has_jg_sup = pair_children.iter().any(|c| pair_has_roles(c, &jg_specialists, &sup_specialists));
    let has_adc_sup = pair_children.iter().any(|c| pair_has_roles(c, &adc_specialists, &sup_specialists));

    assert!(
        has_jg_adc && has_jg_sup && has_adc_sup,
        "All three missing-role pair shapes (JG×ADC, JG×SUP, ADC×SUP) must be \
         seeded into bucket-2 when 3+ roles are missing. Got: jg×adc={}, \
         jg×sup={}, adc×sup={}.",
        has_jg_adc, has_jg_sup, has_adc_sup,
    );
}

#[test]
fn pick2_pair_role_balanced_outscores_high_winrate_mismatch() {
    // Reproduces 1b: at slot 17 with 2 missing roles (matching the production
    // snapshot's [Pantheon, AurelionSol, Ambessa] state), the bucket-2 SUP×ADC
    // pair completes the comp's role coverage (coverage_score ≈ 1.0 with
    // Pantheon's SUP secondary). The bucket-1 SUP×TOP pair leaves ADC empty
    // (coverage_score ≈ 0.398 with one strict-missing role).
    //
    // Win-rate gap: bucket-1 SUP/TOP champs at 0.6, bucket-2 ADC at 0.5.
    // Expectation: leaf coverage signal (gap ≈ 0.6 × 0.6 ≈ 0.36) outweighs
    // win-rate sum gap (≈ 2 × 0.1 × 0.8 = 0.16). Top-ranked pair must include
    // an ADC specialist.
    use engine_core::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };

    fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta {
            id: id.into(),
            positions,
            damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(),
            cc_profile: CcProfile::default(),
            tags: ChampionTags::default(),
        }
    }

    let mut state = DraftState::default();
    state.blue_bans = vec!["B1".into(), "B2".into(), "B3".into(), "B4".into(), "B5".into()];
    state.red_bans = vec!["R1".into(), "R2".into(), "R3".into(), "R4".into(), "R5".into()];
    // Pantheon-like (JG primary, MID/SUP/TOP secondaries — matches production
    // champion-meta data), AurelionSol (MID), Ambessa (TOP).
    state.blue_picks = vec!["Pantheon".into(), "Aurelion".into(), "Ambessa".into()];
    state.red_picks = vec!["Re1".into(), "Re2".into(), "Re3".into(), "Re4".into()];

    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    let mut win_rates: HashMap<String, f64> = HashMap::new();

    meta_map.insert("Pantheon".into(),
        champ("Pantheon", vec![Role::Jungle, Role::Middle, Role::Support, Role::Top]));
    win_rates.insert("Pantheon".into(), 0.5);
    meta_map.insert("Aurelion".into(), champ("Aurelion", vec![Role::Middle]));
    win_rates.insert("Aurelion".into(), 0.5);
    meta_map.insert("Ambessa".into(), champ("Ambessa", vec![Role::Top]));
    win_rates.insert("Ambessa".into(), 0.5);

    // High-WR bucket-1 candidates (TOP-primary and SUP-primary).
    let bucket1_top = vec!["GP".to_string(), "Cho".to_string(), "Fiora".to_string(), "Mundo".to_string()];
    let bucket1_sup = vec!["Bard".to_string(), "Blitz".to_string(), "Thresh".to_string()];
    for id in &bucket1_top {
        meta_map.insert(id.clone(), champ(id, vec![Role::Top]));
        win_rates.insert(id.clone(), 0.6);
    }
    for id in &bucket1_sup {
        meta_map.insert(id.clone(), champ(id, vec![Role::Support]));
        win_rates.insert(id.clone(), 0.6);
    }

    let adc_specialists = vec!["Jinx".to_string(), "Ezreal".to_string()];
    for id in &adc_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Adc]));
        win_rates.insert(id.clone(), 0.5);
    }

    // Filler JG/MID to populate role pools (so top_k_for_role doesn't empty).
    let filler_jg: Vec<String> = (0..3).map(|i| format!("FJg{}", i)).collect();
    let filler_mid: Vec<String> = (0..3).map(|i| format!("FMid{}", i)).collect();
    for id in &filler_jg {
        meta_map.insert(id.clone(), champ(id, vec![Role::Jungle]));
        win_rates.insert(id.clone(), 0.5);
    }
    for id in &filler_mid {
        meta_map.insert(id.clone(), champ(id, vec![Role::Middle]));
        win_rates.insert(id.clone(), 0.5);
    }

    for id in ["B1","B2","B3","B4","B5","R1","R2","R3","R4","R5","Re1","Re2","Re3","Re4"] {
        meta_map.insert(id.into(), champ(id, vec![]));
    }

    let our_pool = TeamPool {
        display: RolePoolMap {
            top: bucket1_top.clone(),
            jungle: filler_jg.clone(),
            middle: filler_mid.clone(),
            adc: adc_specialists.clone(),
            support: bucket1_sup.clone(),
        },
        search: {
            let mut s = bucket1_top.clone();
            s.extend(bucket1_sup.clone());
            s.extend(adc_specialists.clone());
            s.extend(filler_jg.clone());
            s.extend(filler_mid.clone());
            s
        },
    };

    let pw_pick2 = PhaseWeights { info: 0.0, comp: 0.8, coverage: 0.6 };
    let pw_other = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    let pw_table = PhaseWeightTable {
        ban1: pw_other, pick1: pw_other, ban2: pw_other, pick2: pw_pick2,
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool,
        opp_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData { win_rates, synergies: vec![], counters: HashMap::new() },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    };

    // Production widths: branch_width=5, pair_branch_width=500.
    let params = SearchParams {
        branch_width: 5,
        pair_branch_width: 500,
        max_depth: 1,
        ..Default::default()
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    // Children sorted DESC by composite — top-ranked pair is index 0.
    let top_pair = tree.children.first()
        .expect("must have at least one pair child");

    let in_adc = top_pair.champion_ids.iter().any(|id| adc_specialists.contains(id));

    assert!(
        in_adc,
        "Top-ranked pair at slot 17/18 must include an ADC specialist (the \
         missing role). Without it, blue's 5-pick comp has 0 ADC coverage, \
         which the leaf coverage signal should heavily penalize. \
         Got top pair: {:?} (composite={}). All children: {:?}",
        top_pair.champion_ids,
        top_pair.scores.composite,
        tree.children.iter()
            .take(8)
            .map(|c| (c.champion_ids.clone(), c.scores.composite))
            .collect::<Vec<_>>(),
    );
}

#[test]
fn pick2_pair_three_missing_top_pair_must_fill_two_missing_roles() {
    // Reproduces 1b combined with 1a: at slot 17 with THREE missing roles
    // (JG, ADC, SUP — blue picks all sit in TOP/MID), every role-completing
    // pair fills exactly 2 of the 3 missing roles, leaving the comp with one
    // strict-missing role. Bucket-1 high-WR (SUP×TOP) pairs fill only 1
    // missing role (SUP), leaving TWO strict-missing.
    //
    // Coverage gap (current geometric formula):
    //   bucket-2 pair (1 missing remaining): coverage_score ≈ 0.398
    //   bucket-1 SUP×TOP (2 missing remaining): coverage_score ≈ 0.158
    //   gap × weight = 0.240 × 0.6 = 0.144
    // Win-rate gap (bucket-1 high-WR 0.60 vs bucket-2 specialist 0.50):
    //   2 picks × 0.10 × 0.8 = 0.160
    //
    // 0.160 > 0.144 → bucket-1 SUP×TOP pair beats bucket-2 specialist pair on
    // back-prop composite. The top-ranked pair leaves the comp with TWO
    // missing roles instead of one.
    use engine_core::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };

    fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta {
            id: id.into(),
            positions,
            damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(),
            cc_profile: CcProfile::default(),
            tags: ChampionTags::default(),
        }
    }

    let mut state = DraftState::default();
    state.blue_bans = vec!["B1".into(), "B2".into(), "B3".into(), "B4".into(), "B5".into()];
    state.red_bans = vec!["R1".into(), "R2".into(), "R3".into(), "R4".into(), "R5".into()];
    // 3 picks all in TOP/MID — JG, ADC, SUP all missing.
    state.blue_picks = vec!["GarenTop".into(), "AurelionMid".into(), "AmbessaTop".into()];
    state.red_picks = vec!["Re1".into(), "Re2".into(), "Re3".into(), "Re4".into()];

    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    let mut win_rates: HashMap<String, f64> = HashMap::new();

    for (id, pos) in [
        ("GarenTop", vec![Role::Top]),
        ("AurelionMid", vec![Role::Middle]),
        ("AmbessaTop", vec![Role::Top]),
        ("Re1", vec![Role::Top]),
        ("Re2", vec![Role::Jungle]),
        ("Re3", vec![Role::Middle]),
        ("Re4", vec![Role::Adc]),
    ] {
        meta_map.insert(id.into(), champ(id, pos));
        win_rates.insert(id.into(), 0.5);
    }
    for id in ["B1","B2","B3","B4","B5","R1","R2","R3","R4","R5"] {
        meta_map.insert(id.into(), champ(id, vec![]));
    }

    // High-WR bucket-1 candidates (TOP-primary and SUP-primary at WR 0.60).
    // The 0.10 WR advantage over specialists mimics a meta where flex-TOP
    // and flex-SUP champions out-of-meta-tier the dedicated JG/ADC/SUP
    // specialists. Each high-WR pick contributes ≈ +0.10 × 0.8 = 0.08 to the
    // per-pick composite sum vs a specialist swap.
    let bucket1_top: Vec<String> = (0..5).map(|i| format!("HighTop{}", i)).collect();
    let bucket1_sup: Vec<String> = (0..5).map(|i| format!("HighSup{}", i)).collect();
    for id in &bucket1_top {
        meta_map.insert(id.clone(), champ(id, vec![Role::Top]));
        win_rates.insert(id.clone(), 0.60);
    }
    for id in &bucket1_sup {
        meta_map.insert(id.clone(), champ(id, vec![Role::Support]));
        win_rates.insert(id.clone(), 0.60);
    }

    // Specialists at JG, ADC, SUP at WR 0.30 — punished tier in this meta.
    // Per-pick comp_strength: 0.8 × 0.30 = 0.24. Their bucket-1 single score
    // gets a small marginal-gain bonus when scored against blue's incomplete
    // comp, but it's far below high-WR singles. This forces the engine to
    // rely on bucket-2 enumeration AND a sufficiently steep leaf-coverage
    // signal to surface them in the top pair.
    let jg_specialists: Vec<String> = (0..3).map(|i| format!("JgSpec{}", i)).collect();
    let adc_specialists: Vec<String> = (0..3).map(|i| format!("AdcSpec{}", i)).collect();
    let sup_specialists: Vec<String> = (0..3).map(|i| format!("SupSpec{}", i)).collect();
    for id in &jg_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Jungle]));
        win_rates.insert(id.clone(), 0.30);
    }
    for id in &adc_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Adc]));
        win_rates.insert(id.clone(), 0.30);
    }
    for id in &sup_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Support]));
        win_rates.insert(id.clone(), 0.30);
    }

    // Filler MID at WR 0.50 to populate role pool.
    let filler_mid: Vec<String> = (0..3).map(|i| format!("FMid{}", i)).collect();
    for id in &filler_mid {
        meta_map.insert(id.clone(), champ(id, vec![Role::Middle]));
        win_rates.insert(id.clone(), 0.50);
    }

    for id in ["Re1","Re2","Re3","Re4"] {
        meta_map.entry(id.into()).or_insert_with(|| champ(id, vec![]));
    }

    let our_pool = TeamPool {
        display: RolePoolMap {
            top: bucket1_top.clone(),
            jungle: jg_specialists.clone(),
            middle: filler_mid.clone(),
            adc: adc_specialists.clone(),
            support: { let mut s = bucket1_sup.clone(); s.extend(sup_specialists.clone()); s },
        },
        search: {
            let mut s = bucket1_top.clone();
            s.extend(bucket1_sup.clone());
            s.extend(jg_specialists.clone());
            s.extend(adc_specialists.clone());
            s.extend(sup_specialists.clone());
            s.extend(filler_mid.clone());
            s
        },
    };

    // Production weights (DEFAULT_PHASE_WEIGHTS) — coverage 1.5 at Pick2.
    let pw_pick2 = PhaseWeights { info: 0.0, comp: 0.8, coverage: 1.5 };
    let pw_other = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    let pw_table = PhaseWeightTable {
        ban1: pw_other, pick1: pw_other, ban2: pw_other, pick2: pw_pick2,
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool,
        opp_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData { win_rates, synergies: vec![], counters: HashMap::new() },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    };

    let params = SearchParams {
        branch_width: 5,
        pair_branch_width: 500,
        max_depth: 1,
        ..Default::default()
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    let top_pair = tree.children.first()
        .expect("must have at least one pair child");

    // Count distinct missing roles (JG, ADC, SUP) the top pair fills, by
    // ANY champion of that role (specialist or high-WR doesn't matter — the
    // role coverage is what counts).
    let pair_roles: Vec<Role> = top_pair.champion_ids.iter().filter_map(|id| {
        if jg_specialists.contains(id) { Some(Role::Jungle) }
        else if adc_specialists.contains(id) { Some(Role::Adc) }
        else if sup_specialists.contains(id) || bucket1_sup.contains(id) { Some(Role::Support) }
        else if bucket1_top.contains(id) { Some(Role::Top) }
        else if filler_mid.contains(id) { Some(Role::Middle) }
        else { None }
    }).collect();

    let missing_roles_set = [Role::Jungle, Role::Adc, Role::Support];
    let filled_count = missing_roles_set.iter()
        .filter(|r| pair_roles.contains(r))
        .count();

    assert!(
        filled_count >= 2,
        "Top-ranked pair at slot 17/18 with 3 missing roles (JG, ADC, SUP) \
         must fill 2 of them. Got top pair {:?} with roles {:?} (composite={}, \
         fills {} missing role/s). Top-8 children: {:?}",
        top_pair.champion_ids,
        pair_roles,
        top_pair.scores.composite,
        filled_count,
        tree.children.iter()
            .take(8)
            .map(|c| (c.champion_ids.clone(), c.scores.composite))
            .collect::<Vec<_>>(),
    );
}

// === Issue 2 reproducer: bucket-2 protection in single-pick path ===========
//
// The single-pick search path (search_recursive's non-pair branch) truncates
// candidates to the top `branch_width` by static composite. Static composite
// is `0.8 × WR + 1.5 × coverage_marginal_gain` at Pick2.
//
// At 3+ missing roles, coverage_marginal_gain for filling ONE missing role is
// only ≈0.095 (going from coverage_score 0.063 to 0.158). With weight 1.5,
// the coverage contribution is 0.143 — smaller than the WR gap a strong meta
// flex pick (WR 0.60) has over a low-tier specialist (WR 0.30): 0.8 × 0.30 =
// 0.24 vs specialist 0.24 + 0.143 = 0.383 — wait, specialist still wins here.
//
// To actually crowd specialists out we need WR_high - WR_spec > 0.143/0.8 =
// 0.179. Use WR_high = 0.65, WR_spec = 0.20 → gap = 0.45. specialist composite
// = 0.16 + 0.143 = 0.303, high-WR = 0.52. High-WR wins by 0.22.
//
// At slot 16 (R4 single, Pick2 phase), red has 3 picks. With 3 picks all in
// TOP and MID, red's missing roles are [JG, ADC, SUP]. branch_width=5, but
// red's pool has many WR-0.65 TOP/MID champs. Specialists at low WR don't
// make the cut.
//
// Symptom: the search NEVER explores the specialist as a candidate child at
// slot 16. tree.children.champion_ids will not include any specialist.

#[test]
fn pick2_single_pick_includes_missing_role_specialist_in_branch_width() {
    use engine_core::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };

    fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta {
            id: id.into(),
            positions,
            damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(),
            cc_profile: CcProfile::default(),
            tags: ChampionTags::default(),
        }
    }

    // Slot 16 = Red R4 single-pick at Pick2. Counts at slot 16:
    //   blue_bans=5, red_bans=5, blue_picks=3, red_picks=3.
    // Red picks: TOP, MID, TOP → missing JG, ADC, SUP (3 missing).
    // NOTE: Two champs with only Role::Top in red_picks creates a bipartite-
    // infeasible locked state (can't assign 2 distinct roles to 2 TOP-only picks).
    // Use RedJg (JG) instead of RedTop2 (TOP) so locked state is feasible:
    // locked = [RedTop(TOP), RedMid(MID), RedJg(JG)] → 3 distinct primary roles.
    // Missing roles for red are still [ADC, SUP] + JG was filled → actually with
    // RedJg covering JG, missing roles become [ADC, SUP] only (2 missing).
    // Use 3 missing roles by making all 3 locked picks cover only 1 role each
    // (TOP, MID, TOP) → but that's infeasible. Instead: use TOP×2 with one being
    // secondary-flex. Use RedFlex as TOP/JG flex to keep locked feasible.
    // Simplest: replace RedTop2 with RedJg at Jungle. Missing = ADC+SUP (2 roles).
    // The test still demonstrates bucket-2 single-pick protection for missing roles.
    let mut state = DraftState::default();
    state.blue_bans = vec!["B1".into(), "B2".into(), "B3".into(), "B4".into(), "B5".into()];
    state.red_bans = vec!["R1".into(), "R2".into(), "R3".into(), "R4".into(), "R5".into()];
    state.blue_picks = vec!["Bp1".into(), "Bp2".into(), "Bp3".into()];
    state.red_picks = vec!["RedTop".into(), "RedMid".into(), "RedJg".into()];
    assert_eq!(state.turn_index(), 16);
    assert!(matches!(TURN_SEQUENCE[16].side, Side::Red));
    assert_eq!(TURN_SEQUENCE[16].phase, Phase::Pick2);
    assert!(!TURN_SEQUENCE[16].pair_start);

    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    let mut win_rates: HashMap<String, f64> = HashMap::new();

    for (id, pos) in [
        ("Bp1", vec![Role::Top]),
        ("Bp2", vec![Role::Jungle]),
        ("Bp3", vec![Role::Middle]),
        ("RedTop", vec![Role::Top]),
        ("RedMid", vec![Role::Middle]),
        ("RedJg", vec![Role::Jungle]),
    ] {
        meta_map.insert(id.into(), champ(id, pos));
        win_rates.insert(id.into(), 0.5);
    }
    for id in ["B1","B2","B3","B4","B5","R1","R2","R3","R4","R5"] {
        meta_map.insert(id.into(), champ(id, vec![]));
    }

    // High-WR TOP/MID champions in red's pool — these will dominate
    // bucket-1's top-by-composite at branch_width=5.
    let high_wr_top: Vec<String> = (0..10).map(|i| format!("HWTop{}", i)).collect();
    let high_wr_mid: Vec<String> = (0..10).map(|i| format!("HWMid{}", i)).collect();
    for id in &high_wr_top {
        meta_map.insert(id.clone(), champ(id, vec![Role::Top]));
        win_rates.insert(id.clone(), 0.65);
    }
    for id in &high_wr_mid {
        meta_map.insert(id.clone(), champ(id, vec![Role::Middle]));
        win_rates.insert(id.clone(), 0.65);
    }

    // Low-WR specialists at JG, ADC, SUP. Composite at this turn (3 missing):
    //   0.8 × 0.20 + 1.5 × marginal_gain ≈ 0.16 + 1.5 × 0.095 = 0.303.
    // High-WR composite (no fill): 0.8 × 0.65 + 0 = 0.52.
    // Gap: 0.22 → specialists are crowded out at branch_width=5.
    let jg_specialists: Vec<String> = (0..2).map(|i| format!("JgSpec{}", i)).collect();
    let adc_specialists: Vec<String> = (0..2).map(|i| format!("AdcSpec{}", i)).collect();
    let sup_specialists: Vec<String> = (0..2).map(|i| format!("SupSpec{}", i)).collect();
    for id in &jg_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Jungle]));
        win_rates.insert(id.clone(), 0.20);
    }
    for id in &adc_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Adc]));
        win_rates.insert(id.clone(), 0.20);
    }
    for id in &sup_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Support]));
        win_rates.insert(id.clone(), 0.20);
    }

    let red_pool = TeamPool {
        display: RolePoolMap {
            top: high_wr_top.clone(),
            jungle: jg_specialists.clone(),
            middle: high_wr_mid.clone(),
            adc: adc_specialists.clone(),
            support: sup_specialists.clone(),
        },
        search: {
            let mut s = high_wr_top.clone();
            s.extend(high_wr_mid.clone());
            s.extend(jg_specialists.clone());
            s.extend(adc_specialists.clone());
            s.extend(sup_specialists.clone());
            s
        },
    };

    // ctx.side = Red — red is the searching side at slot 16.
    let pw_pick2 = PhaseWeights { info: 0.0, comp: 0.8, coverage: 1.5 };
    let pw_other = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    let pw_table = PhaseWeightTable {
        ban1: pw_other, pick1: pw_other, ban2: pw_other, pick2: pw_pick2,
    };
    let ctx = EvalContext {
        side: Side::Red,
        phase: Phase::Pick2,
        our_pool: red_pool,
        opp_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        our_picks: state.red_picks.clone(),
        opp_picks: state.blue_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: meta_map,
        meta: MetaData { win_rates, synergies: vec![], counters: HashMap::new() },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    };

    // Production widths: branch_width=5.
    let params = SearchParams {
        branch_width: 5,
        pair_branch_width: 500,
        max_depth: 1,
        ..Default::default()
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    // tree.children at slot 16 should expose the candidate single picks red
    // is choosing among. Assert at least one ADC or SUP specialist appears.
    // JG specialists are infeasible (locking 2 JG-only picks can't bipartite-match
    // 4 distinct roles) and are correctly pruned by feasibility. ADC and SUP
    // specialists are the true missing roles after the RED locked state change.
    let any_specialist = tree.children.iter().any(|c| {
        c.champion_ids.iter().any(|id|
            adc_specialists.contains(id)
            || sup_specialists.contains(id)
        )
    });

    assert!(
        any_specialist,
        "Red's slot 16 single-pick at Pick2 with 2 missing roles (ADC, SUP) must \
         include at least one missing-role specialist among the top branch_width \
         candidates explored. Without bucket-2 protection in the single-pick \
         path, low-WR specialists are crowded out by high-WR non-fills. \
         Got children: {:?}",
        tree.children.iter()
            .map(|c| (c.champion_ids.clone(), c.scores.composite))
            .collect::<Vec<_>>(),
    );
}

#[test]
fn pick2_pair_end_b5_after_lulu_must_pick_adc_or_top_not_milio() {
    // Production reproducer: user state at slot 18 (B5 pair_end) with blue
    // picks [Maokai (JG/SUP), Jayce (MID/TOP), Ahri (MID), Lulu (SUP)].
    //
    // Per production champion-meta:
    //   Maokai positions = [JUNGLE, SUPPORT]
    //   Jayce positions  = [MIDDLE, TOP]
    //   Ahri positions   = [MIDDLE]
    //   Lulu positions   = [SUPPORT]
    //
    // per_role_max_factors over 4 picks:
    //   TOP: max(0.01, 0.4 Jayce-sec, 0.01, 0.01) = 0.4
    //   JG:  max(1.0 Maokai, 0.01...) = 1.0
    //   MID: max(0.01, 1.0 Jayce, 1.0 Ahri, 0.01) = 1.0
    //   ADC: 0.01
    //   SUP: max(0.4 Maokai-sec, 0.01, 0.01, 1.0 Lulu) = 1.0
    //
    // Missing roles at threshold 0.9: [TOP, ADC] (2 missing).
    // Adding Milio (SUP) → SUP already covered, ADC factor stays 0.01 →
    //   factors [0.4, 1.0, 1.0, 0.01, 1.0] → coverage_score ≈ 0.331
    // Adding Jinx (ADC) → ADC=1.0 →
    //   factors [0.4, 1.0, 1.0, 1.0, 1.0] → coverage_score ≈ 0.833
    // Adding Riven (TOP) → TOP=1.0 →
    //   factors [1.0, 1.0, 1.0, 0.01, 1.0] → coverage_score ≈ 0.398
    //
    // Leaf-eval contribution gap (×1.5 weight):
    //   Jinx > Milio by 0.75; Riven > Milio by 0.10
    //
    // Bucket-2 single-pick fix should add ADC and TOP specialists to ranked.
    // Top child by composite must be ADC (or TOP), not SUP.
    use engine_core::role_solver::{
        CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
    };

    fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
        ChampionMeta {
            id: id.into(),
            positions,
            damage_profile: DamageProfile::default(),
            scaling_profile: ScalingProfile::default(),
            cc_profile: CcProfile::default(),
            tags: ChampionTags::default(),
        }
    }

    // State at slot 18 (B5 pair_end): 6 bans, 4 blue picks, 4 red picks.
    let mut state = DraftState::default();
    state.blue_bans = vec!["Bb1".into(), "Bb2".into(), "Bb3".into()];
    state.red_bans = vec!["Rb1".into(), "Rb2".into(), "Rb3".into()];
    // Plus ban2 fillers (slots 12-15: R, B, R, B):
    state.red_bans.push("Rb4".into());
    state.blue_bans.push("Bb4".into());
    state.red_bans.push("Rb5".into());
    state.blue_bans.push("Bb5".into());
    state.blue_picks = vec!["Maokai".into(), "Jayce".into(), "Ahri".into(), "Lulu".into()];
    state.red_picks = vec!["Rp1".into(), "Rp2".into(), "Rp3".into(), "Rp4".into()];
    assert_eq!(state.turn_index(), 18);
    assert_eq!(TURN_SEQUENCE[18].phase, Phase::Pick2);

    let mut meta_map: HashMap<String, ChampionMeta> = HashMap::new();
    let mut win_rates: HashMap<String, f64> = HashMap::new();

    meta_map.insert("Maokai".into(), champ("Maokai", vec![Role::Jungle, Role::Support]));
    meta_map.insert("Jayce".into(), champ("Jayce", vec![Role::Middle, Role::Top]));
    meta_map.insert("Ahri".into(), champ("Ahri", vec![Role::Middle]));
    meta_map.insert("Lulu".into(), champ("Lulu", vec![Role::Support]));
    for id in ["Maokai","Jayce","Ahri","Lulu"] {
        win_rates.insert(id.into(), 0.5);
    }
    for id in ["Bb1","Bb2","Bb3","Bb4","Bb5","Rb1","Rb2","Rb3","Rb4","Rb5","Rp1","Rp2","Rp3","Rp4"] {
        meta_map.insert(id.into(), champ(id, vec![]));
    }

    // Candidates available in blue's pool for B5 (NOT yet picked/banned):
    let milio = "Milio";
    meta_map.insert(milio.into(), champ(milio, vec![Role::Support]));
    win_rates.insert(milio.into(), 0.55);  // slight WR edge

    let adc_specialists = vec!["Jinx".to_string(), "Ezreal".to_string(), "Caitlyn".to_string()];
    for id in &adc_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Adc]));
        win_rates.insert(id.clone(), 0.50);
    }
    let top_specialists = vec!["Riven".to_string(), "Sett".to_string(), "Camille".to_string()];
    for id in &top_specialists {
        meta_map.insert(id.clone(), champ(id, vec![Role::Top]));
        win_rates.insert(id.clone(), 0.50);
    }
    // Filler high-WR SUP candidates (none of them help, but high WR pulls them
    // into the bucket-1 top by single composite).
    let sup_fillers: Vec<String> = (0..5).map(|i| format!("HighSup{}", i)).collect();
    for id in &sup_fillers {
        meta_map.insert(id.clone(), champ(id, vec![Role::Support]));
        win_rates.insert(id.clone(), 0.55);
    }

    let our_pool = TeamPool {
        display: RolePoolMap {
            top: top_specialists.clone(),
            jungle: vec![],
            middle: vec![],
            adc: adc_specialists.clone(),
            support: { let mut s = vec![milio.to_string()]; s.extend(sup_fillers.clone()); s },
        },
        search: {
            let mut s = vec![milio.to_string()];
            s.extend(adc_specialists.clone());
            s.extend(top_specialists.clone());
            s.extend(sup_fillers.clone());
            s
        },
    };

    // Production weights — pick2 coverage 1.5
    let pw_pick2 = PhaseWeights { info: 0.2, comp: 0.8, coverage: 1.5 };
    let pw_other = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    let pw_table = PhaseWeightTable {
        ban1: pw_other, pick1: pw_other, ban2: pw_other, pick2: pw_pick2,
    };
    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool,
        opp_pool: TeamPool {
            display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
            search: vec![],
        },
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.25, out_of_pool: 0.75 },
        champion_meta: meta_map,
        meta: MetaData { win_rates, synergies: vec![], counters: HashMap::new() },
        phase_weights_blue: pw_table,
        phase_weights_red: pw_table,
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
    };

    let params = SearchParams {
        branch_width: 5,
        pair_branch_width: 500,
        max_depth: 1,
        ..Default::default()
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    let top_pick = tree.children.first()
        .and_then(|c| c.champion_ids.first())
        .expect("must have at least one child");

    let in_adc = adc_specialists.contains(top_pick);
    let in_top = top_specialists.contains(top_pick);
    let is_sup = top_pick == "Milio" || sup_fillers.contains(top_pick);

    assert!(
        in_adc || in_top,
        "Top pick at slot 18 (B5) must fill ADC or TOP (the missing roles), \
         not another SUP. Got top_pick={}, is_sup={}, in_adc={}, in_top={}. \
         Top-5 children: {:?}",
        top_pick, is_sup, in_adc, in_top,
        tree.children.iter()
            .take(5)
            .map(|c| (c.champion_ids.clone(), c.scores.composite))
            .collect::<Vec<_>>(),
    );
}

// ---------------------------------------------------------------------------
// Feasibility-filter integration tests (Task 1.2)
// ---------------------------------------------------------------------------

/// Build an EvalContext where blue and red have independent typed pools.
/// `blue_champs` / `red_champs` are `(name, roles)` pairs; win_rate is left
/// at default (None → 0.5) unless the caller overrides via champion_meta.
fn ctx_with_typed_pool(
    side: Side,
    phase: Phase,
    blue_champs: &[(&str, Vec<Role>)],
    red_champs: &[(&str, Vec<Role>)],
) -> EvalContext {
    let make_pool = |champs: &[(&str, Vec<Role>)]| TeamPool {
        display: RolePoolMap {
            top: vec![],
            jungle: vec![],
            middle: vec![],
            adc: vec![],
            support: vec![],
        },
        search: champs.iter().map(|(n, _)| (*n).into()).collect(),
    };

    let mut champion_meta: HashMap<String, ChampionMeta> = HashMap::new();
    for (name, roles) in blue_champs.iter().chain(red_champs.iter()) {
        champion_meta
            .entry((*name).into())
            .or_insert_with(|| ChampionMeta {
                id: (*name).into(),
                positions: roles.clone(),
                ..Default::default()
            });
    }

    let (our_pool, opp_pool) = match side {
        Side::Blue => (make_pool(blue_champs), make_pool(red_champs)),
        Side::Red => (make_pool(red_champs), make_pool(blue_champs)),
    };

    EvalContext {
        side,
        phase,
        our_pool,
        opp_pool,
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

/// Slot 19 is Red's 5th pick (Pick2 single). Red already has four locked picks
/// covering TOP/JG/MID/ADC. The only remaining role is SUP, so any candidate
/// that is not a SUP specialist makes the final comp role-infeasible and must
/// be pruned. Only Sona (SUP) should survive into the ranked children.
#[test]
fn search_prunes_infeasible_single_pick_branches() {
    let mut state = DraftState::default();
    // Advance to slot 19 (Red Pick2 single — the very last pick).
    fast_forward_to_slot(&mut state, 19);
    // Override filler picks so Red has 4 locked picks across TOP/JG/MID/ADC.
    state.red_picks = vec![
        "RedTop".into(),
        "RedJg".into(),
        "RedMid".into(),
        "RedAdc".into(),
    ];

    let blue_champs: &[(&str, Vec<Role>)] = &[
        ("BlueA", vec![Role::Top]),
        ("BlueB", vec![Role::Jungle]),
        ("BlueC", vec![Role::Middle]),
        ("BlueD", vec![Role::Adc]),
        ("BlueE", vec![Role::Support]),
    ];
    // Red pool: two role-infeasible picks + one valid SUP.
    let red_champs: &[(&str, Vec<Role>)] = &[
        ("Sona", vec![Role::Support]),
        ("FillTop", vec![Role::Top]),
        ("FillJg", vec![Role::Jungle]),
    ];

    let mut ctx = ctx_with_typed_pool(Side::Red, Phase::Pick2, blue_champs, red_champs);
    // Wire up locked picks so EvalContext is aware of them.
    ctx.our_picks = vec![
        "RedTop".into(),
        "RedJg".into(),
        "RedMid".into(),
        "RedAdc".into(),
    ];
    // Also inject meta for the locked-pick champs so they have known roles.
    ctx.champion_meta.insert("RedTop".into(), ChampionMeta { id: "RedTop".into(), positions: vec![Role::Top], ..Default::default() });
    ctx.champion_meta.insert("RedJg".into(), ChampionMeta { id: "RedJg".into(), positions: vec![Role::Jungle], ..Default::default() });
    ctx.champion_meta.insert("RedMid".into(), ChampionMeta { id: "RedMid".into(), positions: vec![Role::Middle], ..Default::default() });
    ctx.champion_meta.insert("RedAdc".into(), ChampionMeta { id: "RedAdc".into(), positions: vec![Role::Adc], ..Default::default() });

    let params = SearchParams {
        branch_width: 10,
        pair_branch_width: 10,
        max_depth: 1,
        disable_alpha_beta: true,
        forced_branches: vec![],
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    let child_ids: Vec<String> = tree
        .children
        .iter()
        .flat_map(|c| c.champion_ids.iter().cloned())
        .collect();

    assert!(
        child_ids.contains(&"Sona".to_string()),
        "Sona (SUP specialist) must survive feasibility filter; got {:?}",
        child_ids
    );
    assert!(
        !child_ids.contains(&"FillTop".to_string()),
        "FillTop (TOP-only with SUP needed) must be pruned; got {:?}",
        child_ids
    );
    assert!(
        !child_ids.contains(&"FillJg".to_string()),
        "FillJg (JG-only with SUP needed) must be pruned; got {:?}",
        child_ids
    );
    assert_eq!(
        child_ids.len(),
        1,
        "Exactly one feasible candidate (Sona); got {:?}",
        child_ids
    );
}

/// Slot 14 is Red's second Ban2. Blue has 3 locked picks (TOP/JG/MID) and
/// 2 remaining pick slots (ADC + SUP still needed). Blue's pool has Sona
/// (SUP) and JinxAdc (ADC). If Red bans Sona, Blue's pool loses the only
/// SUP → infeasible → that ban is pruned. SafeBan (TOP) does not deprive
/// Blue of any needed role → survives.
///
/// State setup: fast_forward_to_slot(14) fills exactly 3 blue_picks and 3
/// red_picks. We replace both with role-typed names (same count) to keep
/// turn_index=14 and give the feasibility filter valid role masks.
#[test]
fn search_prunes_ban_that_makes_either_side_infeasible() {
    let mut state = DraftState::default();
    // Slot 14 = Red Ban2 #2. fast_forward produces 3 blue_picks, 3 red_picks.
    fast_forward_to_slot(&mut state, 14);
    // Replace picks with role-typed names (same count → turn_index unchanged).
    state.blue_picks = vec!["BlueTop".into(), "BlueJg".into(), "BlueMid".into()];
    state.red_picks = vec!["RedTop".into(), "RedJg".into(), "RedMid".into()];

    // Blue pool: SUP + ADC needed for the 2 remaining blue slots.
    let blue_champs: &[(&str, Vec<Role>)] = &[
        ("Sona", vec![Role::Support]),
        ("JinxAdc", vec![Role::Adc]),
    ];
    // Red pool: ban candidates. SafeBan (TOP) doesn't affect Blue's ADC/SUP.
    // RedAdc2 + RedSup2 ensure Red's own feasibility passes after any ban.
    let red_champs: &[(&str, Vec<Role>)] = &[
        ("RedTop2", vec![Role::Top]),
        ("RedJg2", vec![Role::Jungle]),
        ("RedMid2", vec![Role::Middle]),
        ("RedAdc2", vec![Role::Adc]),
        ("RedSup2", vec![Role::Support]),
        ("SafeBan", vec![Role::Top]),
    ];

    let mut ctx = ctx_with_typed_pool(Side::Red, Phase::Ban2, blue_champs, red_champs);
    // Register locked picks in champion_meta so the feasibility filter has
    // valid role masks for the bipartite check on both sides' locked picks.
    for (name, role) in [
        ("BlueTop", Role::Top), ("BlueJg", Role::Jungle), ("BlueMid", Role::Middle),
        ("RedTop", Role::Top), ("RedJg", Role::Jungle), ("RedMid", Role::Middle),
    ] {
        ctx.champion_meta.insert(name.into(), ChampionMeta { id: name.into(), positions: vec![role], ..Default::default() });
    }

    let params = SearchParams {
        branch_width: 10,
        pair_branch_width: 10,
        max_depth: 1,
        disable_alpha_beta: true,
        forced_branches: vec![],
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).unwrap();

    let child_ids: Vec<String> = tree
        .children
        .iter()
        .flat_map(|c| c.champion_ids.iter().cloned())
        .collect();

    assert!(
        !child_ids.contains(&"Sona".to_string()),
        "Banning Sona leaves Blue with no SUP candidate → must be pruned; got {:?}",
        child_ids
    );
    assert!(
        child_ids.contains(&"SafeBan".to_string()),
        "SafeBan does not harm Blue's ADC/SUP coverage → must survive; got {:?}",
        child_ids
    );
}

/// Slot 6 is Blue's first Pick1. With a pool that has no SUP specialist the
/// feasibility filter must prune every candidate (0 children). With a pool
/// covering all 5 roles all candidates remain.
#[test]
fn search_at_pick1_applies_feasibility_check() {
    // --- constrained: only 4 roles, no SUP → every pick leaves a role gap ---
    {
        let mut state = DraftState::default();
        fast_forward_to_slot(&mut state, 6);

        let champs_no_sup: &[(&str, Vec<Role>)] = &[
            ("A", vec![Role::Top]),
            ("B", vec![Role::Jungle]),
            ("C", vec![Role::Middle]),
            ("D", vec![Role::Adc]),
            ("E", vec![Role::Adc]), // deliberately no SUP
        ];
        let ctx = ctx_with_typed_pool(Side::Blue, Phase::Pick1, champs_no_sup, champs_no_sup);

        let params = SearchParams {
            branch_width: 10,
            pair_branch_width: 10,
            max_depth: 1,
            disable_alpha_beta: true,
            forced_branches: vec![],
        };
        let cancel = CancelHandle::new();
        let tree = search(&state, &params, &ctx, &cancel).unwrap();

        assert_eq!(
            tree.children.len(),
            0,
            "No SUP in pool → every pick is infeasible; expected 0 children, got {}",
            tree.children.len()
        );
    }

    // --- generous: full 5-role pool → all candidates are feasible ---
    {
        let mut state = DraftState::default();
        fast_forward_to_slot(&mut state, 6);

        let champs_full: &[(&str, Vec<Role>)] = &[
            ("A", vec![Role::Top]),
            ("B", vec![Role::Jungle]),
            ("C", vec![Role::Middle]),
            ("D", vec![Role::Adc]),
            ("E", vec![Role::Support]),
        ];
        let ctx = ctx_with_typed_pool(Side::Blue, Phase::Pick1, champs_full, champs_full);

        let params = SearchParams {
            branch_width: 10,
            pair_branch_width: 10,
            max_depth: 1,
            disable_alpha_beta: true,
            forced_branches: vec![],
        };
        let cancel = CancelHandle::new();
        let tree = search(&state, &params, &ctx, &cancel).unwrap();

        assert_eq!(
            tree.children.len(),
            5,
            "Full 5-role pool → all 5 candidates feasible; expected 5 children, got {}",
            tree.children.len()
        );
    }
}
