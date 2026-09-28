//! The reference search against the oracle (design docs/designs/engine-reference-search-design.md § 3, § 6).
//! Per-fixture wiring lives in tier_a.rs; this file holds the search's own properties on a few fixtures and probes.

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::Side;
use engine_core::engine::EngineError;
use engine_core::reference::feasibility::FeasibilityRule;
use engine_core::reference::fixture::{Fixture, Mode};
use engine_core::reference::node::LeafKind;
use engine_core::reference::objective::{Leaf, Objective};
use engine_core::reference::oracle::{evaluate, Evaluation, OracleError, OracleInput};
use engine_core::reference::search::{
    max_depth_for, search, SearchOutcome, SearchParams, Shortlist,
};
use engine_core::reference::state::{Action, Entry, Position};
use std::path::PathBuf;
use std::time::Duration;

fn dir(sub: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(sub)
}

fn fixture(name: &str) -> Fixture {
    Fixture::load_file(&dir("fixtures/tier-a").join(format!("{name}.json")))
        .unwrap_or_else(|e| panic!("{e}"))
}

fn probe(name: &str) -> Fixture {
    Fixture::load_file(&dir("tests/data/reference-probes").join(format!("{name}.json")))
        .unwrap_or_else(|e| panic!("{e}"))
}

fn input<'a>(fx: &'a Fixture, position: &'a Position<'a>, mode: Mode) -> OracleInput<'a> {
    OracleInput {
        position,
        universe: &fx.universe,
        pools: &fx.pools,
        objective: &fx.universe,
        feasibility: fx.feasibility,
        mode,
        epsilon: fx.epsilon,
        off_pool_cost: None,
    }
}

fn candidate(fx: &Fixture, mode: Mode, params: &SearchParams) -> SearchOutcome {
    let position = fx.position();
    search(
        &input(fx, &position, mode),
        params,
        &CancelHandle::new(),
        |_| {},
    )
    .unwrap_or_else(|e| panic!("{}: {e}", fx.id))
}

fn oracle(fx: &Fixture, mode: Mode) -> Evaluation {
    let position = fx.position();
    evaluate(&input(fx, &position, mode)).unwrap_or_else(|e| panic!("{}: {e}", fx.id))
}

fn pairs(o: &SearchOutcome) -> Vec<(Action, f64)> {
    o.ranked.iter().map(|r| (r.action, r.value)).collect()
}

fn oracle_pairs(e: &Evaluation) -> Vec<(Action, f64)> {
    e.ranked.iter().map(|av| (av.action, av.value)).collect()
}

fn unbudgeted(prune: bool, transposition: bool) -> SearchParams {
    SearchParams {
        node_budget: None,
        prune,
        transposition,
        wall_budget: Duration::from_secs(86_400),
        min_completed_depth: 1,
        shortlist: None,
    }
}

#[test]
fn ranked_list_equals_the_oracle_exactly_on_every_switch_setting() {
    for name in [
        "01-pair-completion",
        "02-profitable-denial",
        "05-comp-breaking-pair",
        "07-slot6-bound",
    ] {
        let fx = fixture(name);
        let oracle = oracle(&fx, fx.mode);
        let mut outcomes = Vec::new();
        for (prune, table) in [(true, true), (true, false), (false, true), (false, false)] {
            let c = candidate(&fx, fx.mode, &unbudgeted(prune, table));
            assert_eq!(
                pairs(&c),
                oracle_pairs(&oracle),
                "{name}: prune={prune} table={table}"
            );
            assert_eq!(c.top_set, oracle.top_set, "{name}");
            assert_eq!(c.value, oracle.value, "{name}");
            assert_eq!(c.mover, oracle.mover);
            assert!(!c.partial, "{name}: unbudgeted is complete");
            assert_eq!(
                c.depth,
                max_depth_for(&input(&fx, &fx.position(), fx.mode)),
                "{name}"
            );
            outcomes.push((prune, table, c));
        }
        let plain = &outcomes.iter().find(|(p, t, _)| !p && !t).unwrap().2;
        assert_eq!(
            plain.nodes, oracle.nodes,
            "{name}: no pruning, no table → the oracle's tree"
        );
        assert_eq!(plain.leaves, oracle.leaves, "{name}");
        assert_eq!(plain.cutoffs, 0);
        assert_eq!(plain.table_hits, 0);
    }
}

#[test]
fn every_horizon_agrees_with_the_horizon_oracle() {
    // D2 ii on the two deepest fixtures: 04 (six turns) and 06a (six turns, ban-heavy).
    for name in ["04-partner-protection", "06a-ban-truncated"] {
        let fx = fixture(name);
        let d_max = max_depth_for(&input(&fx, &fx.position(), fx.mode));
        assert!(d_max >= 2);
        for d in 1..=d_max {
            let c = candidate(&fx, Mode::Horizon(d), &unbudgeted(true, true));
            let o = oracle(&fx, Mode::Horizon(d));
            assert_eq!(pairs(&c), oracle_pairs(&o), "{name} at horizon {d}");
            assert_eq!(c.depth, d);
        }
    }
}

#[test]
fn pruning_and_the_table_actually_fire() {
    // Memory technique_vacuous_gate: an alpha-beta that never prunes or a table that never hits would pass
    // every equality above. 04 and 06a prune; 06a and 06b transpose (Blue ban then Red ban commute).
    for name in ["04-partner-protection", "06a-ban-truncated"] {
        let fx = fixture(name);
        let c = candidate(&fx, fx.mode, &unbudgeted(true, false));
        let o = oracle(&fx, fx.mode);
        assert!(c.cutoffs > 0, "{name}: no cutoff");
        assert!(
            c.nodes < o.nodes,
            "{name}: pruning saved nothing ({} vs {})",
            c.nodes,
            o.nodes
        );
    }
    for name in ["06a-ban-truncated", "06b-ban-horizon"] {
        let fx = fixture(name);
        let c = candidate(&fx, fx.mode, &unbudgeted(true, true));
        let without = candidate(&fx, fx.mode, &unbudgeted(true, false));
        assert!(c.table_hits_total > 0, "{name}: the table never hit");
        assert!(c.table_entries > 0);
        assert!(
            c.nodes < without.nodes,
            "{name}: the table hit but saved nothing ({} vs {})",
            c.nodes,
            without.nodes
        );
    }
}

#[test]
fn principal_continuation_replays_to_its_own_value() {
    for name in [
        "02-profitable-denial",
        "04-partner-protection",
        "05-comp-breaking-pair",
        "07b-slot6-full-fan",
    ] {
        let fx = fixture(name);
        let position = fx.position();
        let d_max = max_depth_for(&input(&fx, &position, fx.mode));
        let c = candidate(&fx, fx.mode, &unbudgeted(true, true));
        for r in &c.ranked {
            // replay by hand: apply the root action then the continuation; evaluate the leaf with its flags
            let mut pos = position.apply(r.action);
            for a in &r.continuation {
                pos = pos.apply(*a);
            }
            let leaf = Leaf {
                blue: pos.picks(Side::Blue),
                red: pos.picks(Side::Red),
                blue_feasible: r.ends.blue_feasible,
                red_feasible: r.ends.red_feasible,
            };
            assert_eq!(fx.universe.value(&leaf), r.value, "{name}: {:?}", r.action);
            if r.ends.kind == LeafKind::DryPool {
                assert!(r.continuation.len() < d_max);
            } else {
                assert_eq!(
                    r.continuation.len(),
                    d_max - 1,
                    "{name}: {:?} ends {:?}",
                    r.action,
                    r.ends.kind
                );
            }
        }
    }
}

#[test]
fn s11_guard_marks_the_suicide_pairs_and_clears_the_honest_pair() {
    let fx = probe("probe-mutual-infeasibility");
    let c = candidate(&fx, fx.mode, &unbudgeted(true, true));
    let idx = |n: &str| fx.universe.index(n).unwrap();
    assert_eq!(c.top_set, vec![Action::pair(idx("J1"), idx("S1"))]);
    let find = |a: Action| c.ranked.iter().find(|r| r.action == a).expect("ranked");
    let honest = find(Action::pair(idx("J1"), idx("S1")));
    assert!(honest.ends.blue_feasible && honest.ends.red_feasible);
    assert_eq!(honest.value, 0.0);
    for suicide in [
        Action::pair(idx("M2"), idx("M3")),
        Action::pair(idx("A2"), idx("A3")),
    ] {
        let r = find(suicide);
        assert!(
            !r.ends.blue_feasible && !r.ends.red_feasible,
            "{suicide:?} ends mutual"
        );
        assert_eq!(r.value, 5.0, "Blue answers with J1+S1 itself: 12 vs 7");
    }
}

#[test]
fn root_errors_are_invalid_input() {
    // a complete draft: 01 is at slot 18 (Blue's completing pick), slot 19 is Red's last pick. Fill both with
    // whatever is legal — the test is about DraftComplete, not about which champions.
    let fx = fixture("01-pair-completion");
    let mut entries = fx.entries.clone();
    let s1 = fx.universe.index("S1").unwrap();
    entries.push(Entry::Pick(s1));
    let after_s1 = Position::new(&fx.format, &entries, &fx.pools, &fx.universe).unwrap();
    let red_pick = after_s1
        .available(&fx.universe)
        .intersect(fx.pools.red)
        .iter()
        .next()
        .expect("Red has a legal last pick in fixture 01");
    entries.push(Entry::Pick(red_pick));
    let done = Position::new(&fx.format, &entries, &fx.pools, &fx.universe).unwrap();
    assert!(done.is_complete());
    let err = search(
        &input(&fx, &done, fx.mode),
        &unbudgeted(true, true),
        &CancelHandle::new(),
        |_| {},
    )
    .err();
    assert!(
        matches!(err, Some(EngineError::InvalidInput { ref path }) if path[0].contains("complete")),
        "{err:?}"
    );
    // Horizon(0)
    let position = fx.position();
    let err = search(
        &input(&fx, &position, Mode::Horizon(0)),
        &unbudgeted(true, true),
        &CancelHandle::new(),
        |_| {},
    )
    .err();
    assert!(
        matches!(err, Some(EngineError::InvalidInput { ref path }) if path[0].contains("horizon of 0")),
        "{err:?}"
    );
}

/// B-proper design § 1: `off_pool_cost` is read under `roster` only. A value under any other rule is
/// refused by the search and the oracle alike — never silently ignored (the `value_under` default
/// trap of slice-5 review round 5, in a new place).
#[test]
fn an_off_pool_cost_under_a_rule_that_does_not_read_it_is_refused() {
    let fx = fixture("01-pair-completion");
    let position = fx.position();
    for rule in [
        FeasibilityRule::On,
        FeasibilityRule::Off,
        FeasibilityRule::PoolOrRoster,
    ] {
        let input = OracleInput {
            position: &position,
            universe: &fx.universe,
            pools: &fx.pools,
            objective: &fx.universe,
            feasibility: rule,
            mode: fx.mode,
            epsilon: fx.epsilon,
            off_pool_cost: Some(0.15),
        };
        let err = search(
            &input,
            &unbudgeted(true, true),
            &CancelHandle::new(),
            |_| {},
        )
        .err();
        assert!(
            matches!(err, Some(EngineError::InvalidInput { ref path }) if path[0].starts_with("off_pool_cost:")),
            "{rule:?}: {err:?}"
        );
        assert!(
            matches!(evaluate(&input), Err(OracleError::OffPoolCost { .. })),
            "{rule:?}: the oracle must refuse it too"
        );
    }
}

/// B-proper design § 1: under `roster` P is required, finite and in `[0, L]`; the search and the oracle
/// refuse anything else with the reason named.
#[test]
fn off_pool_cost_under_roster_is_required_finite_and_at_most_l() {
    let fx = fixture("01-pair-completion");
    let position = fx.position();
    let l = fx.universe.loss();
    let input = |p: Option<f64>| OracleInput {
        position: &position,
        universe: &fx.universe,
        pools: &fx.pools,
        objective: &fx.universe,
        feasibility: FeasibilityRule::Roster,
        mode: fx.mode,
        epsilon: fx.epsilon,
        off_pool_cost: p,
    };
    for (p, word) in [
        (None, "required"),
        (Some(-0.1), "negative"),
        (Some(f64::NAN), "not finite"),
        (Some(f64::INFINITY), "not finite"),
        (Some(l + 1.0), "exceeds L"),
    ] {
        let err = search(
            &input(p),
            &unbudgeted(true, true),
            &CancelHandle::new(),
            |_| {},
        )
        .err();
        assert!(
            matches!(err, Some(EngineError::InvalidInput { ref path }) if path[0].starts_with("off_pool_cost:") && path[0].contains(word)),
            "{p:?}: {err:?}"
        );
        assert!(
            matches!(evaluate(&input(p)), Err(OracleError::OffPoolCost { ref reason }) if reason.contains(word)),
            "{p:?}: the oracle must refuse it too"
        );
    }
    // The bounds are inclusive: 0 (the pool prices nothing) and L (pool_or_roster's own P) both run.
    for p in [0.0, l] {
        search(
            &input(Some(p)),
            &unbudgeted(true, true),
            &CancelHandle::new(),
            |_| {},
        )
        .unwrap_or_else(|e| panic!("P = {p}: {e}"));
    }
}

/// B-proper § 7 test 2: widths at or above every fan change nothing — values, continuations and every
/// count bit-equal to the untruncated search, on every Tier A fixture and probe at its own mode, and
/// the root fan is the ranked list. (An off-by-one in the truncation fails this on 07b's 171-wide fan.)
#[test]
fn a_shortlist_at_or_above_every_fan_is_the_untruncated_search() {
    let names: Vec<(&str, &str)> = [
        "01-pair-completion",
        "02-profitable-denial",
        "03-declining-denial",
        "04-partner-protection",
        "05-comp-breaking-pair",
        "06a-ban-truncated",
        "06b-ban-horizon",
        "07-slot6-bound",
        "07b-slot6-full-fan",
    ]
    .iter()
    .map(|n| ("fixtures/tier-a", *n))
    .chain(
        [
            "probe-ban-breaks-role",
            "probe-ban-only-tie-h3",
            "probe-dry-pool",
            "probe-immediate-vs-delayed-h2",
            "probe-mutual-infeasibility",
            "probe-red-double-turn-standard",
        ]
        .iter()
        .map(|n| ("tests/data/reference-probes", *n)),
    )
    .collect();
    let wide = SearchParams {
        shortlist: Some(Shortlist {
            singles: 200,
            pairs: 20_000,
            root_off_pool: 20_000,
        }),
        ..unbudgeted(true, true)
    };
    for (sub, name) in names {
        let fx = Fixture::load_file(&dir(sub).join(format!("{name}.json")))
            .unwrap_or_else(|e| panic!("{e}"));
        let exact = candidate(&fx, fx.mode, &unbudgeted(true, true));
        let shortlisted = candidate(&fx, fx.mode, &wide);
        let bits = |o: &SearchOutcome| -> Vec<(Action, u64, Vec<Action>)> {
            o.ranked
                .iter()
                .map(|r| (r.action, r.value.to_bits(), r.continuation.clone()))
                .collect()
        };
        assert_eq!(bits(&exact), bits(&shortlisted), "{name}");
        assert_eq!(
            (
                exact.nodes,
                exact.leaves,
                exact.cutoffs,
                exact.table_hits_total
            ),
            (
                shortlisted.nodes,
                shortlisted.leaves,
                shortlisted.cutoffs,
                shortlisted.table_hits_total
            ),
            "{name}"
        );
        assert_eq!(
            exact.root_fan,
            exact.ranked.len(),
            "{name}: nothing cut without a shortlist"
        );
        assert_eq!(
            shortlisted.root_fan,
            shortlisted.ranked.len(),
            "{name}: nothing cut at these widths"
        );
    }
}

/// B-proper § 7 test 10: a width of 0 is refused before any search runs.
#[test]
fn a_zero_shortlist_width_is_refused() {
    let fx = fixture("01-pair-completion");
    for sl in [
        Shortlist {
            singles: 0,
            pairs: 5,
            root_off_pool: 5,
        },
        Shortlist {
            singles: 5,
            pairs: 0,
            root_off_pool: 5,
        },
        Shortlist {
            singles: 5,
            pairs: 5,
            root_off_pool: 0,
        },
    ] {
        let params = SearchParams {
            shortlist: Some(sl),
            ..unbudgeted(true, true)
        };
        let position = fx.position();
        let err = search(
            &input(&fx, &position, fx.mode),
            &params,
            &CancelHandle::new(),
            |_| {},
        )
        .err();
        assert!(
            matches!(err, Some(EngineError::InvalidInput { ref path }) if path[0].starts_with("shortlist:")),
            "{sl:?}: {err:?}"
        );
    }
}

/// Review focus (B-proper plan): a node budget cut inside a SHORTLISTED iteration returns the previous
/// depth as `partial`, exact at its own horizon under the same widths.
#[test]
fn a_budget_cut_inside_a_shortlisted_iteration_returns_the_previous_depth_as_partial() {
    let fx = fixture("07b-slot6-full-fan");
    let position = fx.position();
    let d_max = max_depth_for(&input(&fx, &position, fx.mode));
    let sl = Shortlist {
        singles: 3,
        pairs: 5,
        root_off_pool: 5,
    };
    let with = |node_budget: Option<u64>| SearchParams {
        shortlist: Some(sl),
        node_budget,
        ..unbudgeted(true, true)
    };
    let control = candidate(&fx, fx.mode, &with(None));
    assert!(!control.partial && control.depth == d_max);
    let cut = candidate(&fx, fx.mode, &with(Some(control.nodes_total - 1)));
    assert!(cut.partial);
    assert_eq!(cut.depth, d_max - 1);
    let shallower = candidate(&fx, Mode::Horizon(d_max - 1), &with(None));
    assert_eq!(pairs(&cut), pairs(&shallower));
    assert_eq!(cut.root_fan, control.root_fan);
}

/// Review focus (B-proper plan): a mid-pair root (fixture 01: Blue's completing pick at slot 18) is a
/// single-pick root under the shortlist — every in-pool action is ranked plus the best off-pool one
/// (Red's S3 is the only off-pool champion), and `root_fan` is the whole available set.
#[test]
fn a_mid_pair_root_under_a_shortlist_keeps_every_in_pool_action() {
    let fx = fixture("01-pair-completion");
    let position = fx.position();
    assert!(position.is_mid_pair());
    let input = OracleInput {
        position: &position,
        universe: &fx.universe,
        pools: &fx.pools,
        objective: &fx.universe,
        feasibility: FeasibilityRule::Roster,
        mode: fx.mode,
        epsilon: fx.epsilon,
        off_pool_cost: Some(fx.universe.loss()),
    };
    let narrow = SearchParams {
        shortlist: Some(Shortlist {
            singles: 1,
            pairs: 1,
            root_off_pool: 1,
        }),
        ..unbudgeted(true, true)
    };
    let out =
        search(&input, &narrow, &CancelHandle::new(), |_| {}).unwrap_or_else(|e| panic!("{e}"));
    let in_pool = out
        .ranked
        .iter()
        .filter(|r| r.action.champions().all(|c| fx.pools.blue.contains(c)))
        .count();
    assert_eq!((out.root_fan, out.ranked.len(), in_pool), (4, 4, 3));
    let exact = search(
        &input,
        &unbudgeted(true, true),
        &CancelHandle::new(),
        |_| {},
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(out.ranked[0].action, exact.ranked[0].action);
}

fn budgeted(node_budget: u64) -> SearchParams {
    SearchParams {
        node_budget: Some(node_budget),
        ..unbudgeted(true, true)
    }
}

#[test]
fn a_node_budget_one_short_returns_the_previous_depth_as_partial() {
    for name in [
        "02-profitable-denial",
        "04-partner-protection",
        "07b-slot6-full-fan",
    ] {
        let fx = fixture(name);
        let position = fx.position();
        let d_max = max_depth_for(&input(&fx, &position, fx.mode));
        let control = candidate(&fx, fx.mode, &unbudgeted(true, true));
        assert!(!control.partial && control.depth == d_max);
        let cut = candidate(&fx, fx.mode, &budgeted(control.nodes_total - 1));
        assert!(cut.partial, "{name}");
        assert_eq!(cut.depth, d_max - 1, "{name}");
        let shallower = oracle(&fx, Mode::Horizon(d_max - 1));
        assert_eq!(
            pairs(&cut),
            oracle_pairs(&shallower),
            "{name}: the returned depth is exact at its own horizon"
        );
        assert!(cut.nodes_total < control.nodes_total, "{name}");
        let exact = candidate(&fx, fx.mode, &budgeted(control.nodes_total));
        assert!(
            !exact.partial,
            "{name}: a budget equal to the control's total completes"
        );
        assert_eq!(pairs(&exact), pairs(&control), "{name}");
        assert_eq!(exact.depth, control.depth);
    }
}

#[test]
fn on_depth_fires_once_per_completed_depth_that_is_followed_by_a_deeper_one() {
    let fx = fixture("04-partner-protection");
    let position = fx.position();
    let d_max = max_depth_for(&input(&fx, &position, fx.mode));
    let mut seen: Vec<(usize, bool, f64)> = Vec::new();
    let out = search(
        &input(&fx, &position, fx.mode),
        &unbudgeted(true, true),
        &CancelHandle::new(),
        |o| seen.push((o.depth, o.partial, o.value)),
    )
    .unwrap();
    assert_eq!(seen.len(), d_max - 1, "every depth but the last fires");
    assert_eq!(
        seen.iter().map(|s| s.0).collect::<Vec<_>>(),
        (1..d_max).collect::<Vec<_>>()
    );
    assert!(
        seen.iter().all(|s| !s.1),
        "a fired depth is complete, never partial"
    );
    for (d, _, v) in &seen {
        assert_eq!(
            *v,
            oracle(&fx, Mode::Horizon(*d)).value,
            "depth {d}'s partial value is exact"
        );
    }
    assert_eq!(out.depth, d_max);
}

#[test]
fn an_external_cancel_before_the_search_is_cancelled_not_partial() {
    let fx = fixture("02-profitable-denial");
    let position = fx.position();
    let cancel = CancelHandle::new();
    cancel.cancel();
    let err = search(
        &input(&fx, &position, fx.mode),
        &unbudgeted(true, true),
        &cancel,
        |_| {},
    )
    .err();
    assert!(matches!(err, Some(EngineError::Cancelled)), "{err:?}");
}

#[test]
fn a_budget_cut_inside_the_first_iteration_is_a_timeout_at_depth_one() {
    let fx = probe("probe-immediate-vs-delayed-h1");
    let position = fx.position();
    let control = search(
        &input(&fx, &position, fx.mode),
        &SearchParams::default(),
        &CancelHandle::new(),
        |_| {},
    )
    .unwrap();
    assert_eq!(control.depth, 1);
    assert_eq!(control.nodes_total, 4);
    let params = SearchParams {
        node_budget: Some(3),
        ..SearchParams::default()
    };
    let err = search(
        &input(&fx, &position, fx.mode),
        &params,
        &CancelHandle::new(),
        |_| {},
    )
    .err();
    assert!(matches!(err, Some(EngineError::Timeout(1))), "{err:?}");
}

#[test]
fn a_cancel_inside_an_iteration_returns_the_last_completed_depth_as_partial() {
    // Cancel from the per-depth hook: it fires after the driver has decided to run depth 2 (after its own
    // top-of-loop cancel check), so the flag is first seen at depth 2's first wake point and depth 1 comes back
    // partial. A cancel BETWEEN iterations is `Err(Cancelled)` — the driver's contract — covered by the
    // pre-search test above.
    let fx = fixture("04-partner-protection");
    let position = fx.position();
    let cancel = CancelHandle::new();
    let flag = cancel.clone();
    let out = search(
        &input(&fx, &position, fx.mode),
        &unbudgeted(true, true),
        &cancel,
        |_| flag.cancel(),
    )
    .unwrap();
    assert!(out.partial);
    assert_eq!(out.depth, 1);
    assert_eq!(pairs(&out), oracle_pairs(&oracle(&fx, Mode::Horizon(1))));
}

#[test]
fn the_heartbeat_counters_are_fed() {
    let fx = fixture("04-partner-protection");
    let position = fx.position();
    let cancel = CancelHandle::new();
    let out = search(
        &input(&fx, &position, fx.mode),
        &unbudgeted(true, true),
        &cancel,
        |_| {},
    )
    .unwrap();
    assert_eq!(
        u64::try_from(cancel.nodes_so_far()).unwrap(),
        out.nodes_total
    );
    assert_eq!(cancel.depth_in_progress(), out.depth);
}

#[test]
fn a_dry_pool_inside_the_horizon_ends_the_continuation_early() {
    // probe-dry-pool: Blue takes R1, Red pairs two of R2..R5, Blue's pair takes the last two, Red's pick at
    // slot 11 has no legal action → DryPool leaf at turns_used 3 (< horizon 4); Red count-infeasible, Blue fine.
    let fx = probe("probe-dry-pool");
    let c = candidate(&fx, fx.mode, &unbudgeted(true, true));
    let o = oracle(&fx, fx.mode);
    // the probe's own differential check: the Rust oracle reproduces the R1 prototype's dry run exactly
    assert_eq!(
        (o.value, o.leaves, o.nodes),
        (fx.dry_run.value, fx.dry_run.leaves, fx.dry_run.nodes)
    );
    assert_eq!(pairs(&c), oracle_pairs(&o));
    let idx = |n: &str| fx.universe.index(n).unwrap();
    assert_eq!(c.top_set, vec![Action::Pick(idx("R1"))]);
    let top = &c.ranked[0];
    assert_eq!(top.ends.kind, LeafKind::DryPool);
    assert!(top.ends.blue_feasible && !top.ends.red_feasible);
    // the S11 guard's ALLOW case, through the same predicate tier_a gates on
    assert!(!top.breaks_mover(c.mover), "a denial line is allowed");
    assert!(
        fx.top_line_denies,
        "the probe declares that its top line denies"
    );
    assert_eq!(
        top.continuation.len(),
        2,
        "R pair, B pair, then Red is dry — one turn short of the horizon"
    );
    assert_eq!(
        top.value,
        fx.universe.loss() + 4.0,
        "board (4 + 3 + 3) − (3 + 3) = 4, plus L for Red"
    );
    // every Blue line that takes an R ends dry; the B lines reach the horizon
    for r in &c.ranked {
        let takes_r = fx
            .universe
            .id(match r.action {
                Action::Pick(c) => c,
                _ => unreachable!(),
            })
            .starts_with('R');
        assert_eq!(r.ends.kind == LeafKind::DryPool, takes_r, "{:?}", r.action);
    }
}
