//! champion-role-shares slice B (design § 6, verifier items 5/6): the role the search hands
//! `score_pick` is the display bucket the mover's pool files the champion under — any bucket, since
//! the role reaches nothing but `pool_multiplier` — and its first listed position only when no
//! bucket holds it (a pick outside the pool, a side with an empty pool). Before: `positions[0]`,
//! so a champion filed under a bucket that is not its primary (Vayne under ADC, primary TOP on a
//! flipped patch) was scored `InPoolOutOfRole` at ×0.75 by the pool the user wrote.
//!
//! Each test runs the same search three times, with the champion filed under ADC, filed under
//! TOP (its first listed position) and filed nowhere (search list only): the first two must agree
//! on every root child and composite, the third must score the champion lower. The request side
//! is always the OTHER side, so a site that read the request's pool instead of the mover's would
//! file the champion nowhere and fail.
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{bucket_role, scored_role, Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search, SearchParams, TreeNode};
use std::collections::HashMap;

fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
    ChampionMeta {
        id: id.into(),
        positions,
        ..Default::default()
    }
}

/// Vayne: TOP listed first (a flipped primary), ADC second, and EQUAL shares at both — the factor
/// is 1.0 at either, so her coverage gain is a plain marksman's and only `pool_multiplier` can
/// tell the two buckets apart.
fn vayne() -> ChampionMeta {
    ChampionMeta {
        id: "Vayne".into(),
        positions: vec![Role::Top, Role::Adc],
        position_shares: vec![0.5, 0.0, 0.0, 0.5, 0.0],
        ..Default::default()
    }
}

/// `filed` = the bucket Vayne is filed under, if any; she is always in the search list.
fn pool(entries: &[(&str, Role)], filed: Option<Role>) -> TeamPool {
    let mut display = RolePoolMap {
        top: vec![],
        jungle: vec![],
        middle: vec![],
        adc: vec![],
        support: vec![],
    };
    let mut search = vec!["Vayne".to_string()];
    fn bucket(display: &mut RolePoolMap, role: Role) -> &mut Vec<String> {
        match role {
            Role::Top => &mut display.top,
            Role::Jungle => &mut display.jungle,
            Role::Middle => &mut display.middle,
            Role::Adc => &mut display.adc,
            Role::Support => &mut display.support,
        }
    }
    if let Some(role) = filed {
        bucket(&mut display, role).push("Vayne".into());
    }
    for (id, role) in entries {
        bucket(&mut display, *role).push((*id).into());
        search.push((*id).into());
    }
    TeamPool { display, search }
}

fn weights() -> PhaseWeightTable {
    let pick2 = PhaseWeights {
        comp: 0.8,
        info: 0.2,
        coverage: 1.5,
    };
    let other = PhaseWeights {
        comp: 0.5,
        info: 0.5,
        coverage: 0.3,
    };
    PhaseWeightTable {
        ban1: other,
        pick1: other,
        ban2: other,
        pick2,
    }
}

/// The request side's context; `mover_pool` is the OTHER side's pool.
fn ctx(
    request: Side,
    state: &DraftState,
    request_pool: TeamPool,
    mover_pool: TeamPool,
    meta: HashMap<String, ChampionMeta>,
    win_rates: HashMap<String, f64>,
) -> EvalContext {
    let (our_picks, opp_picks) = match request {
        Side::Blue => (state.blue_picks.clone(), state.red_picks.clone()),
        Side::Red => (state.red_picks.clone(), state.blue_picks.clone()),
    };
    EvalContext {
        side: request,
        phase: Phase::Pick2,
        our_pool: request_pool,
        opp_pool: mover_pool,
        our_picks,
        opp_picks,
        penalties: Penalties {
            out_of_role: 0.25,
            out_of_pool: 0.75,
        },
        champion_meta: meta,
        meta: MetaData {
            win_rates,
            synergies: vec![],
            counters: HashMap::new(),
            fm: None,
        },
        phase_weights_blue: weights(),
        phase_weights_red: weights(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
        fm: None,
    }
}

fn ids(tree: &TreeNode) -> Vec<Vec<String>> {
    tree.children
        .iter()
        .map(|c| c.champion_ids.clone())
        .collect()
}

/// The MOVER's own value of the child that picks `champion` — the leaf total over its picks,
/// which scores the new pick at its bucket too (side_total). `scores.composite` is the request
/// side's value and cannot see the mover's multiplier.
fn mover_value(tree: &TreeNode, champion: &str, mover: Side) -> f64 {
    tree.children
        .iter()
        .find(|c| c.champion_ids.iter().any(|id| id == champion))
        .unwrap_or_else(|| panic!("{champion} is a root child; got {:?}", ids(tree)))
        .scores
        .composite_per_side
        .for_side(mover)
}

/// Five filler bans per side plus the named picks, with a meta row for everything on the board.
fn board(
    blue_picks: &[(&str, Role)],
    red_picks: &[(&str, Role)],
    meta: &mut HashMap<String, ChampionMeta>,
) -> DraftState {
    let mut state = DraftState::default();
    for i in 0..5 {
        let b = format!("BanB{i}");
        let r = format!("BanR{i}");
        meta.insert(b.clone(), champ(&b, vec![]));
        meta.insert(r.clone(), champ(&r, vec![]));
        state.blue_bans.push(b);
        state.red_bans.push(r);
    }
    for (id, role) in blue_picks {
        meta.insert((*id).into(), champ(id, vec![*role]));
        state.blue_picks.push((*id).into());
    }
    for (id, role) in red_picks {
        meta.insert((*id).into(), champ(id, vec![*role]));
        state.red_picks.push((*id).into());
    }
    state
}

#[test]
fn bucket_role_is_the_first_bucket_in_role_order_and_scored_role_falls_back_to_the_first_position()
{
    let p = pool(
        &[("Kaisa", Role::Adc), ("Sona", Role::Support)],
        Some(Role::Adc),
    );
    assert_eq!(bucket_role("Vayne", &p), Some(Role::Adc));
    assert_eq!(bucket_role("Sona", &p), Some(Role::Support));
    assert_eq!(bucket_role("Twitch", &p), None);
    // Filed under two buckets: the first in Role order (TOP before ADC), either is in-pool-in-role.
    let mut two = p.clone();
    two.display.top.push("Vayne".into());
    assert_eq!(bucket_role("Vayne", &two), Some(Role::Top));
    let mut meta = HashMap::new();
    meta.insert(
        "Vayne".to_string(),
        champ("Vayne", vec![Role::Top, Role::Adc]),
    );
    meta.insert("Twitch".to_string(), champ("Twitch", vec![Role::Adc]));
    meta.insert("Nobody".to_string(), champ("Nobody", vec![]));
    assert_eq!(scored_role("Vayne", &p, &meta), Some(Role::Adc));
    assert_eq!(scored_role("Twitch", &p, &meta), Some(Role::Adc)); // nowhere → positions[0]
    assert_eq!(scored_role("Nobody", &p, &meta), None); // no positions either → the caller's default
    assert_eq!(scored_role("Unknown", &p, &meta), None);
}

/// Slot 11 (Red's R3, a Pick1 single — no bucket-2 seeding): the ranked candidates
/// (score_and_rank) and the leaf's own picks (side_total) read the bucket. Request side Blue.
#[test]
fn a_single_pick_filed_under_any_bucket_is_scored_in_pool_at_that_role() {
    let mut meta = HashMap::new();
    let mut state = board(
        &[
            ("BlueTop", Role::Top),
            ("BlueJg", Role::Jungle),
            ("BlueMid", Role::Middle),
        ],
        &[("RedTop", Role::Top), ("RedJg", Role::Jungle)],
        &mut meta,
    );
    // Slot 11 has three bans per side on the board, not five.
    state.blue_bans.truncate(3);
    state.red_bans.truncate(3);
    assert_eq!(state.turn_index(), 11);
    assert_eq!(TURN_SEQUENCE[11].side, Side::Red);
    assert_eq!(TURN_SEQUENCE[11].phase, Phase::Pick1);
    assert!(!TURN_SEQUENCE[11].pair_start);
    meta.insert("Vayne".into(), vayne());
    meta.insert("Kaisa".into(), champ("Kaisa", vec![Role::Adc]));
    // The pool must still be able to complete Red's draft after this pick or the prune drops
    // every candidate: a mid and a support nobody would pick first.
    meta.insert("PoolMid".into(), champ("PoolMid", vec![Role::Middle]));
    meta.insert("PoolSup".into(), champ("PoolSup", vec![Role::Support]));
    let mut win_rates = HashMap::new();
    win_rates.insert("Vayne".to_string(), 0.60);
    win_rates.insert("Kaisa".to_string(), 0.56);
    win_rates.insert("PoolMid".to_string(), 0.30);
    win_rates.insert("PoolSup".to_string(), 0.30);
    let params = SearchParams {
        branch_width: 1,
        max_depth: 1,
        disable_alpha_beta: true,
        ..SearchParams::default()
    };
    let run_pool = |red: TeamPool| {
        let blue = pool(&[], None); // Blue's pool never files Vayne — the request side's pool
        let mut c = ctx(
            Side::Blue,
            &state,
            blue,
            red,
            meta.clone(),
            win_rates.clone(),
        );
        c.phase = Phase::Pick1;
        search(&state, &params, &c, &CancelHandle::new()).expect("search")
    };
    let entries = [
        ("Kaisa", Role::Adc),
        ("PoolMid", Role::Middle),
        ("PoolSup", Role::Support),
    ];
    let run = |filed: Option<Role>| run_pool(pool(&entries, filed));
    let adc = run(Some(Role::Adc));
    let top = run(Some(Role::Top));
    let nowhere = run(None);
    // "Load defaults for both" files a champion under EVERY listed role: Vayne under TOP and ADC.
    // The rule is a no-op there — her first listed position already sits in a bucket — which is
    // why the default-pool measurements of this slice do not move with this task.
    let mut defaults = pool(&entries, Some(Role::Top));
    defaults.display.adc.push("Vayne".into());
    let both = run_pool(defaults);
    for (label, tree) in [("adc", &adc), ("top", &top), ("nowhere", &nowhere)] {
        eprintln!(
            "{label}: {:?}",
            tree.children
                .iter()
                .map(|c| (c.champion_ids.join("+"), c.scores.composite_per_side))
                .collect::<Vec<_>>()
        );
    }
    // At branch_width 1 only the better static candidate survives: Vayne at ×1.0 beats Kai'Sa,
    // Vayne at ×0.75 does not. Filed under ADC she is scored at ADC — in pool, in role — and the
    // leaf values Red's three picks the same way whichever bucket she sits in.
    assert_eq!(
        ids(&adc),
        vec![vec!["Vayne".to_string()]],
        "filed under ADC"
    );
    assert_eq!(
        ids(&top),
        vec![vec!["Vayne".to_string()]],
        "filed under TOP"
    );
    assert_eq!(
        ids(&nowhere),
        vec![vec!["Kaisa".to_string()]],
        "filed nowhere"
    );
    assert_eq!(
        mover_value(&adc, "Vayne", Side::Red),
        mover_value(&top, "Vayne", Side::Red)
    );
    assert_eq!(
        ids(&both),
        vec![vec!["Vayne".to_string()]],
        "filed under TOP and ADC"
    );
    assert_eq!(
        mover_value(&both, "Vayne", Side::Red),
        mover_value(&top, "Vayne", Side::Red)
    );
    // Blue's value of a child cannot see Red's multiplier: the request side's composite is Blue's.
    assert_eq!(
        adc.children[0].scores.composite,
        nowhere.children[0].scores.composite
    );
}

/// Slot 17 (Blue's B4 + B5 pair): the scored singles that seed and order the pairs read the bucket.
/// Request side Red.
#[test]
fn a_pair_pick_filed_under_any_bucket_is_scored_in_pool_at_that_role() {
    let mut meta = HashMap::new();
    let state = board(
        &[
            ("BlueTop", Role::Top),
            ("BlueJg", Role::Jungle),
            ("BlueMid", Role::Middle),
        ],
        &[
            ("RedTop", Role::Top),
            ("RedJg", Role::Jungle),
            ("RedMid", Role::Middle),
            ("RedAdc", Role::Adc),
        ],
        &mut meta,
    );
    assert_eq!(state.turn_index(), 17);
    assert!(TURN_SEQUENCE[17].pair_start);
    assert_eq!(TURN_SEQUENCE[17].side, Side::Blue);
    meta.insert("Vayne".into(), vayne());
    meta.insert("Kaisa".into(), champ("Kaisa", vec![Role::Adc]));
    meta.insert("Sona".into(), champ("Sona", vec![Role::Support]));
    let mut win_rates = HashMap::new();
    win_rates.insert("Vayne".to_string(), 0.60);
    win_rates.insert("Kaisa".to_string(), 0.56);
    win_rates.insert("Sona".to_string(), 0.50);
    // Every pair is searched; the static singles decide the ORDER the pairs come out in.
    let params = SearchParams {
        branch_width: 5,
        pair_branch_width: 10,
        single_pair_top_k: 0,
        max_depth: 1,
        disable_alpha_beta: true,
        ..SearchParams::default()
    };
    let run = |filed: Option<Role>| {
        let blue = pool(&[("Kaisa", Role::Adc), ("Sona", Role::Support)], filed);
        let red = pool(&[], None);
        let c = ctx(
            Side::Red,
            &state,
            red,
            blue,
            meta.clone(),
            win_rates.clone(),
        );
        search(&state, &params, &c, &CancelHandle::new()).expect("search")
    };
    let adc = run(Some(Role::Adc));
    let top = run(Some(Role::Top));
    let nowhere = run(None);
    for (label, tree) in [("adc", &adc), ("top", &top), ("nowhere", &nowhere)] {
        eprintln!(
            "{label}: {:?}",
            tree.children
                .iter()
                .map(|c| (c.champion_ids.join("+"), c.scores.composite_per_side))
                .collect::<Vec<_>>()
        );
    }
    // A pair is an unordered 2-subset; the engine lists its ids in sorted order.
    let pair = |a: &str, b: &str| vec![a.to_string(), b.to_string()];
    // Vayne at ×1.0 outranks Kai'Sa statically, so her pair with Sona comes first; at ×0.75 it
    // comes second.
    assert_eq!(
        ids(&adc)[..2],
        [pair("Sona", "Vayne"), pair("Kaisa", "Sona")],
        "filed under ADC"
    );
    assert_eq!(
        ids(&top)[..2],
        [pair("Sona", "Vayne"), pair("Kaisa", "Sona")],
        "filed under TOP"
    );
    assert_eq!(
        ids(&nowhere)[..2],
        [pair("Kaisa", "Sona"), pair("Sona", "Vayne")],
        "filed nowhere"
    );
    // The leaf values Blue's five picks ×0.75 lower when she is filed nowhere.
    assert!(mover_value(&nowhere, "Vayne", Side::Blue) < mover_value(&adc, "Vayne", Side::Blue));
    assert_eq!(
        mover_value(&adc, "Vayne", Side::Blue),
        mover_value(&top, "Vayne", Side::Blue)
    );
}

/// Slot 16 (Red's R4, a Pick2 single with roles missing): the specialists bucket-2 protection
/// appends beyond the branch width are scored at their bucket. Request side Blue.
#[test]
fn a_seeded_specialist_filed_under_any_bucket_is_scored_in_pool_at_that_role() {
    let mut meta = HashMap::new();
    let state = board(
        &[
            ("BlueTop", Role::Top),
            ("BlueJg", Role::Jungle),
            ("BlueMid", Role::Middle),
        ],
        &[
            ("RedTop", Role::Top),
            ("RedJg", Role::Jungle),
            ("RedMid", Role::Middle),
        ],
        &mut meta,
    );
    assert_eq!(state.turn_index(), 16);
    assert_eq!(TURN_SEQUENCE[16].side, Side::Red);
    assert_eq!(TURN_SEQUENCE[16].phase, Phase::Pick2);
    // Three high-WR supports fill the branch width (feasible: Red still needs ADC + SUP and the
    // pool can supply an ADC). ADC is then a missing role, so bucket 2 appends the ADC bucket's
    // top four — Vayne alone, when she is filed there — and the SUPPORT bucket's top four, whose
    // fourth, Sona, is new. Vayne and Sona have the same WR and the same coverage gain.
    let supports: Vec<String> = (0..3).map(|i| format!("Sup{i}")).collect();
    let mut win_rates = HashMap::new();
    for id in &supports {
        meta.insert(id.clone(), champ(id, vec![Role::Support]));
        win_rates.insert(id.clone(), 0.70);
    }
    meta.insert("Vayne".into(), vayne());
    meta.insert("Sona".into(), champ("Sona", vec![Role::Support]));
    win_rates.insert("Vayne".to_string(), 0.30);
    win_rates.insert("Sona".to_string(), 0.30);
    let params = SearchParams {
        branch_width: 3,
        max_depth: 1,
        disable_alpha_beta: true,
        ..SearchParams::default()
    };
    let run = |filed: Option<Role>| {
        let mut entries: Vec<(&str, Role)> = supports
            .iter()
            .map(|m| (m.as_str(), Role::Support))
            .collect();
        entries.push(("Sona", Role::Support));
        let red = pool(&entries, filed);
        let blue = pool(&[], None);
        let c = ctx(
            Side::Blue,
            &state,
            blue,
            red,
            meta.clone(),
            win_rates.clone(),
        );
        search(&state, &params, &c, &CancelHandle::new()).expect("search")
    };
    let adc = run(Some(Role::Adc));
    let nowhere = run(None);
    for (label, tree) in [("adc", &adc), ("nowhere", &nowhere)] {
        eprintln!(
            "{label}: {:?}",
            tree.children
                .iter()
                .map(|c| (c.champion_ids.join("+"), c.scores.composite_per_side))
                .collect::<Vec<_>>()
        );
    }
    // Vayne reaches the fan only through bucket 2 — the ADC bucket, which is why "filed under TOP"
    // is not a variant here (she would not be seeded at all). The seeded specialists are appended
    // in missing-role order (ADC, then SUPPORT) and the fan is sorted by static score, stable:
    // scored at her bucket Vayne ties Sona exactly (same WR, same info, same coverage gain, both
    // ×1.0) and keeps her place BEFORE Sona; scored at TOP (×0.75) she would sort after her.
    // Filed nowhere she is not seeded.
    let names =
        |tree: &TreeNode| -> Vec<String> { ids(tree).into_iter().map(|c| c[0].clone()).collect() };
    assert_eq!(names(&adc), ["Sup0", "Sup1", "Sup2", "Vayne", "Sona"]);
    assert_eq!(names(&nowhere), ["Sup0", "Sup1", "Sup2", "Sona"]);
    // And the leaf values her pick the same way as Sona's: in pool, in role.
    assert_eq!(
        mover_value(&adc, "Vayne", Side::Red),
        mover_value(&adc, "Sona", Side::Red)
    );
}
