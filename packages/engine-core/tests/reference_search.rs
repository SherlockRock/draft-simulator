//! The reference search against the oracle (design docs/designs/engine-reference-search-design.md § 3, § 6).
//! Per-fixture wiring lives in tier_a.rs; this file holds the search's own properties on a few fixtures and probes.

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::Side;
use engine_core::engine::EngineError;
use engine_core::reference::fixture::{Fixture, Mode};
use engine_core::reference::node::LeafKind;
use engine_core::reference::objective::{Leaf, Objective};
use engine_core::reference::oracle::{evaluate, Evaluation, OracleInput};
use engine_core::reference::search::{max_depth_for, search, SearchOutcome, SearchParams};
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
