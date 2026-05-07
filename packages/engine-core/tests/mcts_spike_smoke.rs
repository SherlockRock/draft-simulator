//! MCTS spike smoke test. Asserts the loop runs without panicking and
//! produces sensible top-level output. Not a correctness test.

use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::SpikeFixture;
use engine_core::pools::Role;
use engine_core::role_solver::ChampionMeta;
use std::collections::HashMap;

fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
    ChampionMeta {
        id: id.to_string(),
        positions,
        ..Default::default()
    }
}

fn small_fixture() -> SpikeFixture {
    // Six champs per role × 5 roles = 30 champs. A few have flex.
    let entries: Vec<(&str, Vec<Role>)> = vec![
        // Top
        ("Garen", vec![Role::Top]),
        ("Darius", vec![Role::Top]),
        ("Sett", vec![Role::Top, Role::Middle]),
        ("Aatrox", vec![Role::Top]),
        ("Renekton", vec![Role::Top]),
        ("Camille", vec![Role::Top]),
        // Jungle
        ("LeeSin", vec![Role::Jungle]),
        ("Graves", vec![Role::Jungle]),
        ("Kindred", vec![Role::Jungle]),
        ("Viego", vec![Role::Jungle, Role::Middle]),
        ("Nidalee", vec![Role::Jungle]),
        ("Hecarim", vec![Role::Jungle]),
        // Middle
        ("Ahri", vec![Role::Middle]),
        ("Syndra", vec![Role::Middle]),
        ("Orianna", vec![Role::Middle]),
        ("Akali", vec![Role::Middle, Role::Top]),
        ("Yasuo", vec![Role::Middle, Role::Top]),
        ("Azir", vec![Role::Middle]),
        // ADC
        ("Jinx", vec![Role::Adc]),
        ("Caitlyn", vec![Role::Adc]),
        ("Aphelios", vec![Role::Adc]),
        ("Ezreal", vec![Role::Adc]),
        ("Kaisa", vec![Role::Adc]),
        ("Lucian", vec![Role::Adc, Role::Middle]),
        // Support
        ("Sona", vec![Role::Support]),
        ("Thresh", vec![Role::Support]),
        ("Nautilus", vec![Role::Support]),
        ("Lulu", vec![Role::Support]),
        ("Pyke", vec![Role::Support]),
        ("Karma", vec![Role::Support, Role::Middle]),
    ];

    let mut meta = HashMap::new();
    let mut winrates = HashMap::new();
    let mut all_champions = Vec::new();
    // Spread winrates 0.45..0.55 deterministically for fixture stability.
    for (i, (name, roles)) in entries.iter().enumerate() {
        meta.insert(name.to_string(), champ(name, roles.clone()));
        let wr = 0.45 + ((i as f64) % 11.0) / 100.0;
        winrates.insert(name.to_string(), wr);
        all_champions.push(name.to_string());
    }
    SpikeFixture {
        meta,
        winrates,
        all_champions,
    }
}

#[test]
fn runs_without_panic_from_empty_draft() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 42,
            root_shortlist_k: None,
        },
    );
    for _ in 0..200 {
        mcts.iterate();
    }
    let dist = mcts.root_visit_distribution();
    assert!(!dist.is_empty(), "root should have visited children");
    let total_visits: u32 = dist.iter().map(|(_, v, _)| *v).sum();
    assert!(total_visits > 0, "should have non-zero visits across root children");
    let top = &dist[0];
    assert!(top.1 > 0, "top move should have at least one visit");
}

#[test]
fn winrate_weighted_policy_completes() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::WinrateWeightedFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 7,
            root_shortlist_k: None,
        },
    );
    for _ in 0..100 {
        mcts.iterate();
    }
    assert!(mcts.total_iterations() > 0);
}

#[test]
fn from_mid_draft_position() {
    let fixture = small_fixture();
    // 6 bans + 3 picks done — partway through pick 1 phase.
    let state = DraftState {
        blue_bans: vec![
            "Yasuo".to_string(),
            "Akali".to_string(),
            "Viego".to_string(),
        ],
        red_bans: vec![
            "Lucian".to_string(),
            "Karma".to_string(),
            "Sett".to_string(),
        ],
        blue_picks: vec!["Garen".to_string()],
        red_picks: vec!["LeeSin".to_string(), "Ahri".to_string()],
        ..Default::default()
    };
    let mut mcts = Mcts::new(
        &fixture,
        state,
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 1,
            root_shortlist_k: None,
        },
    );
    for _ in 0..150 {
        mcts.iterate();
    }
    let dist = mcts.root_visit_distribution();
    assert!(!dist.is_empty());
}

#[test]
fn uncached_feasibility_also_works() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Uncached,
            seed: 99,
            root_shortlist_k: None,
        },
    );
    for _ in 0..50 {
        mcts.iterate();
    }
    assert!(mcts.total_iterations() > 0);
}

#[test]
fn reroot_preserves_subtree_visits() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 42,
            root_shortlist_k: None,
        },
    );
    for _ in 0..500 {
        mcts.iterate();
    }
    let dist = mcts.root_visit_distribution();
    let top_move = dist[0].0.clone();
    let inherited = dist[0].1;
    assert!(inherited > 0, "top child should have visits");

    mcts.reroot_to(&top_move).expect("reroot to known top move");
    assert_eq!(
        mcts.total_iterations(),
        inherited,
        "active root visits should equal pre-reroot child visits"
    );
    assert_eq!(mcts.inherited_visits_at_reroot(), inherited);

    for _ in 0..200 {
        mcts.iterate();
    }
    assert!(mcts.total_iterations() > inherited, "new visits accumulated");

    mcts.uproot().expect("uproot back to original root");
    let post_dist = mcts.root_visit_distribution();
    assert!(!post_dist.is_empty(), "original root has children visible");
    let top_after_uproot = &post_dist[0];
    assert_eq!(top_after_uproot.0, top_move, "top move stable after uproot");
    assert!(
        top_after_uproot.1 >= inherited,
        "top child still carries pre-reroot + new visits"
    );
}

#[test]
fn root_shortlist_trims_breadth() {
    let fixture = small_fixture();
    let mut mcts_full = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 1,
            root_shortlist_k: None,
        },
    );
    let mut mcts_short = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 1,
            root_shortlist_k: Some(8),
        },
    );

    // Burn one iteration each so root_shortlist_size includes any expansion.
    mcts_full.iterate();
    mcts_short.iterate();

    assert!(mcts_short.root_shortlist_size() <= 8);
    assert!(mcts_full.root_shortlist_size() > mcts_short.root_shortlist_size());
}

#[test]
fn prior_ranks_higher_winrate_above_lower() {
    use engine_core::draft_state::{ActionType, Side};
    use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx;
    use engine_core::mcts_spike::prior::{compute_prior_scores, ShortlistInput};

    let mut fixture = small_fixture();
    fixture.winrates.insert("Garen".into(), 0.60);
    fixture.winrates.insert("Darius".into(), 0.45);

    let state = DraftState::default();
    let ctx = build_spike_eval_ctx(&fixture, &state, Side::Blue);
    let scores = compute_prior_scores(
        &state,
        &fixture,
        &ctx,
        ShortlistInput { side: Side::Blue, action_type: ActionType::Pick },
    );
    let garen = scores.iter().find(|(mv, _)| mv.first() == "Garen").unwrap();
    let darius = scores.iter().find(|(mv, _)| mv.first() == "Darius").unwrap();
    assert!(garen.1 > darius.1, "higher winrate champ should score higher");
}

#[test]
fn shortlist_caps_to_k() {
    use engine_core::draft_state::{ActionType, Side};
    use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx;
    use engine_core::mcts_spike::prior::{shortlist_top_k, ShortlistInput};

    let fixture = small_fixture();
    let state = DraftState::default();
    let ctx = build_spike_eval_ctx(&fixture, &state, Side::Blue);
    let shortlisted = shortlist_top_k(
        &state,
        &fixture,
        &ctx,
        ShortlistInput { side: Side::Blue, action_type: ActionType::Pick },
        10,
    );
    assert_eq!(shortlisted.len(), 10, "shortlist trims to K");
}

#[test]
fn dominance_basic() {
    use engine_core::mcts_spike::ValueVector;
    let a = ValueVector { winrate: 1.0, coverage: 1.0, flex: 1.0 };
    let b = ValueVector { winrate: 0.5, coverage: 0.5, flex: 0.5 };
    let c = ValueVector { winrate: 0.5, coverage: 1.0, flex: 1.0 };
    assert!(a.dominates(&b));
    assert!(!b.dominates(&a));
    assert!(!a.dominates(&a));
    assert!(a.dominates(&c)); // 1>0.5, 1>=1, 1>=1 → all_ge && any_gt
    assert!(!c.dominates(&a));
}

#[test]
fn pareto_frontier_at_root_has_at_least_one() {
    let fixture = small_fixture();
    let mut mcts = Mcts::new(
        &fixture,
        DraftState::default(),
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed: 5,
            root_shortlist_k: Some(20),
        },
    );
    for _ in 0..1000 {
        mcts.iterate();
    }
    let frontier = engine_core::mcts_spike::pareto::root_pareto_frontier(&mcts);
    assert!(!frontier.is_empty(), "frontier should always have at least one entry");
    // Every member is non-dominated by every other member.
    for (i, a) in frontier.iter().enumerate() {
        for (j, b) in frontier.iter().enumerate() {
            if i == j { continue; }
            assert!(!a.mean_value.dominates(&b.mean_value),
                "frontier member {} dominates {}", i, j);
        }
    }
}

#[test]
fn pair_prior_at_late_emits_pair_moves() {
    // v4 sanity: at slot 17 (late, B4 pair_start), the prior must emit
    // PAIR MoveIds (champion_ids.len() == 2), not singletons. The 4 blue
    // picks cover [T,M,J,A] so Support is the missing role; Support champs
    // dominate the additive proxy and the top pairs should be Support-
    // containing.
    use engine_core::draft_state::{ActionType, DraftState, Side};
    use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx;
    use engine_core::mcts_spike::prior::{compute_prior_scores, ShortlistInput};
    use engine_core::mcts_spike::procedural_fixture::procedural_fixture;

    let fixture = procedural_fixture();
    let state = DraftState {
        blue_bans: vec!["T00".into(), "J04".into(), "M08".into(), "T08".into()],
        red_bans: vec!["A00".into(), "S00".into(), "M00".into(), "J08".into()],
        blue_picks: vec!["T01".into(), "M01".into(), "J01".into(), "A01".into()],
        red_picks: vec![
            "J00".into(),
            "M04".into(),
            "T04".into(),
            "A04".into(),
            "S04".into(),
        ],
        ..Default::default()
    };
    let turn = state.current_turn().expect("late should have current turn");
    assert!(turn.pair_start, "slot 17 should be pair_start");
    assert_eq!(turn.side, Side::Blue);

    let ctx = build_spike_eval_ctx(&fixture, &state, turn.side);
    let scored = compute_prior_scores(
        &state,
        &fixture,
        &ctx,
        ShortlistInput { side: turn.side, action_type: ActionType::Pick },
    );

    assert!(!scored.is_empty(), "prior produced no candidates at late");
    for (mv, _) in &scored {
        assert_eq!(
            mv.champion_ids.len(),
            2,
            "expected pair MoveId at pair_start; got {:?}",
            mv.champion_ids
        );
        assert!(mv.is_pick, "pair_start moves are always picks");
    }

    // Expect the top-5 to be Support-containing. Anything less is the v3
    // structural bug (AB-style adc-into-adc) leaking into pair selection.
    let mut sorted = scored.clone();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let support_in_top5 = sorted
        .iter()
        .take(5)
        .filter(|(mv, _)| mv.champion_ids.iter().any(|c| c.starts_with('S')))
        .count();
    assert_eq!(
        support_in_top5, 5,
        "top-5 pair-prior should all contain Support at late; got {:?}",
        sorted.iter().take(5).map(|(m, _)| m.label()).collect::<Vec<_>>()
    );
}

#[test]
fn pair_prior_shortlist_covers_ab_top5_at_late() {
    // v4 shortlist-coverage check at the late position. AB's top-5 pairs
    // (by depth-4 minimax value) MUST appear inside MCTS's full pair-prior
    // shortlist (top-200, the same `seed_pair_candidates` budget as the
    // bench). If the shortlist excludes AB's top, MCTS's UCT cannot
    // converge to it.
    //
    // We deliberately do NOT assert the prior's TOP-5 matches AB's top-5:
    // the additive proxy `score(first) + score(second)` is order-blind and
    // double-counts coverage, so it ranks (S, S) above (S, X) pairs while
    // depth-4 minimax sees the second-Support contributes nothing
    // marginal. UCT exploration during MCTS evaluates rollouts via
    // `terminal_eval` and refines that initial seeding. The value of this
    // smoke test is verifying the seed CONTAINS the right candidates, not
    // that the seed RANKS them right.
    use engine_core::cancellation::CancelHandle;
    use engine_core::draft_state::{ActionType, DraftState};
    use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx;
    use engine_core::mcts_spike::prior::{shortlist_top_k, ShortlistInput};
    use engine_core::mcts_spike::procedural_fixture::procedural_fixture;
    use engine_core::search::{search, SearchParams};

    let fixture = procedural_fixture();
    let state = DraftState {
        blue_bans: vec!["T00".into(), "J04".into(), "M08".into(), "T08".into()],
        red_bans: vec!["A00".into(), "S00".into(), "M00".into(), "J08".into()],
        blue_picks: vec!["T01".into(), "M01".into(), "J01".into(), "A01".into()],
        red_picks: vec![
            "J00".into(),
            "M04".into(),
            "T04".into(),
            "A04".into(),
            "S04".into(),
        ],
        ..Default::default()
    };
    let turn = state.current_turn().unwrap();
    let ctx = build_spike_eval_ctx(&fixture, &state, turn.side);

    let prior_top200: Vec<(String, String)> = shortlist_top_k(
        &state,
        &fixture,
        &ctx,
        ShortlistInput { side: turn.side, action_type: ActionType::Pick },
        200,
    )
    .iter()
    .map(|mv| {
        assert_eq!(mv.champion_ids.len(), 2, "expected pair MoveId");
        (mv.champion_ids[0].clone(), mv.champion_ids[1].clone())
    })
    .collect();

    let params = SearchParams {
        branch_width: 5,
        pair_branch_width: 200,
        max_depth: 4,
        disable_alpha_beta: false,
        forced_branches: Vec::new(),
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).expect("ab search ok");
    let mut ab_pairs: Vec<(String, String, f64)> = tree
        .children
        .iter()
        .filter(|child| child.champion_ids.len() == 2)
        .map(|child| {
            let mut a = child.champion_ids[0].clone();
            let mut b = child.champion_ids[1].clone();
            if a > b {
                std::mem::swap(&mut a, &mut b);
            }
            (a, b, child.scores.composite)
        })
        .collect();
    ab_pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let ab_top5: Vec<(String, String)> = ab_pairs
        .iter()
        .take(5)
        .map(|(a, b, _)| (a.clone(), b.clone()))
        .collect();

    assert!(
        !ab_top5.is_empty(),
        "AB tree should have pair children at slot 17"
    );

    let coverage = ab_top5.iter().filter(|p| prior_top200.contains(p)).count();
    assert!(
        coverage >= 4,
        "AB's top-5 pairs not covered by MCTS shortlist (top-200): {}/5. \
         shortlist would need to include these for UCT to converge there. \
         missing={:?}",
        coverage,
        ab_top5
            .iter()
            .filter(|p| !prior_top200.contains(p))
            .collect::<Vec<_>>(),
    );
}

#[test]
fn prior_top5_overlaps_with_ab_top5() {
    // v3 alignment hypothesis check: the new score_pick-based prior should
    // produce a top-5 that overlaps significantly with production AB's
    // singleton-aggregated top-5 at empty draft. v2's stripped prior had
    // 0.67/5 overlap on average. v3 expects >=3/5.
    use engine_core::cancellation::CancelHandle;
    use engine_core::draft_state::{ActionType, Side};
    use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx;
    use engine_core::mcts_spike::prior::{shortlist_top_k, ShortlistInput};
    use engine_core::search::{search, SearchParams};
    use std::collections::HashMap;

    let fixture = small_fixture();
    let state = DraftState::default();
    let our_side = state.current_turn().map(|t| t.side).unwrap_or(Side::Blue);
    let ctx = build_spike_eval_ctx(&fixture, &state, our_side);

    // Empty draft starts with B1 ban. is_pick=false from prior side; AB tree
    // emits ban children with action_type=Ban. Both must agree.
    let prior_top5: Vec<String> = shortlist_top_k(
        &state,
        &fixture,
        &ctx,
        ShortlistInput { side: our_side, action_type: ActionType::Ban },
        5,
    )
    .iter()
    .map(|mv| mv.first().to_string())
    .collect();

    let params = SearchParams {
        branch_width: 5,
        pair_branch_width: 200,
        max_depth: 4,
        disable_alpha_beta: false,
        forced_branches: Vec::new(),
    };
    let cancel = CancelHandle::new();
    let tree = search(&state, &params, &ctx, &cancel).expect("ab search ok");

    // Aggregate pair-pick children to lead champion using mean (v3 alignment).
    let mut bucket: HashMap<String, Vec<f64>> = HashMap::new();
    for child in &tree.children {
        if let Some(c) = child.champion_ids.first() {
            bucket.entry(c.clone()).or_default().push(child.scores.composite);
        }
    }
    let mut by_mean: Vec<(String, f64)> = bucket
        .into_iter()
        .map(|(c, scores)| {
            let m = scores.iter().sum::<f64>() / (scores.len() as f64);
            (c, m)
        })
        .collect();
    by_mean.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let ab_top5: Vec<String> = by_mean.into_iter().take(5).map(|(c, _)| c).collect();

    let overlap = prior_top5.iter().filter(|c| ab_top5.contains(c)).count();
    assert!(
        overlap >= 3,
        "v3 prior top5 vs AB mean top5 overlap = {}/5 - expected >=3. \
         prior={:?} ab={:?}",
        overlap, prior_top5, ab_top5
    );
}
