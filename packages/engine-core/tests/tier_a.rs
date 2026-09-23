//! Tier A: the definition of "working" for the § 1 objective (design docs/designs/engine-tier-a-fixtures-design.md § 6;
//! spec Obsidian `draft-simulator-engine-target` § 3, D6, D9).
//!
//! Per fixture: load → bounds → oracle → check 1 (top set == intended) → dry-run parity (value,
//! leaves, nodes exactly as the independent prototype measured) → pair-order swap → the reference
//! search against the oracle (slice 4, inside `run`: check 2 — the candidate's top action is in the
//! oracle's top set — then ranked equality, every horizon, the pruning/table switches, PV replay, the
//! budget property and the S11 guard). Check 2 has no test of its own: it is live on every fixture.
//!
//!   cargo test -p engine-core --test tier_a -- --nocapture

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::Side;
use engine_core::reference::fixture::Fixture;
use engine_core::reference::node::LeafKind;
use engine_core::reference::objective::{Leaf, Objective};
use engine_core::reference::oracle::{evaluate, Evaluation, Mode, OracleInput};
use engine_core::reference::search::{max_depth_for, search, SearchOutcome, SearchParams};
use engine_core::reference::state::{Action, Position};
use engine_core::reference::universe::Universe;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

/// One entry per file in fixtures/tier-a/. `every_fixture_file_has_a_test` keeps this honest.
const FIXTURES: [&str; 9] = [
    "01-pair-completion",
    "02-profitable-denial",
    "03-declining-denial",
    "04-partner-protection",
    "05-comp-breaking-pair",
    "06a-ban-truncated",
    "06b-ban-horizon",
    "07-slot6-bound",
    "07b-slot6-full-fan",
];

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/tier-a")
}

fn label(u: &Universe, action: Action) -> String {
    match action {
        Action::Ban(c) => format!("ban {}", u.id(c)),
        Action::Pick(c) => u.id(c).to_string(),
        Action::Pair(a, b) => format!("({}, {})", u.id(a), u.id(b)),
    }
}

fn labels(u: &Universe, actions: &[Action]) -> Vec<String> {
    actions.iter().map(|a| label(u, *a)).collect()
}

fn ranked_report(u: &Universe, eval: &Evaluation) -> String {
    eval.ranked
        .iter()
        .map(|av| format!("    {:>10}  {}", av.value, label(u, av.action)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn params(prune: bool, transposition: bool, node_budget: Option<u64>) -> SearchParams {
    SearchParams {
        node_budget,
        prune,
        transposition,
        wall_budget: Duration::from_secs(86_400),
        min_completed_depth: 1,
    }
}

fn candidate(fx: &Fixture, mode: Mode, p: &SearchParams) -> SearchOutcome {
    let position = fx.position();
    search(
        &OracleInput {
            position: &position,
            universe: &fx.universe,
            pools: &fx.pools,
            objective: &fx.universe,
            feasibility: fx.feasibility,
            mode,
            epsilon: fx.epsilon,
        },
        p,
        &CancelHandle::new(),
        |_| {},
    )
    .unwrap_or_else(|e| panic!("{}: candidate: {e}", fx.id))
}

fn oracle_at(fx: &Fixture, mode: Mode) -> Evaluation {
    fx.evaluate_with(&fx.universe, mode)
        .unwrap_or_else(|e| panic!("{}: oracle at {mode:?}: {e}", fx.id))
}

fn as_pairs(o: &SearchOutcome) -> Vec<(Action, f64)> {
    o.ranked.iter().map(|r| (r.action, r.value)).collect()
}

fn oracle_pairs(e: &Evaluation) -> Vec<(Action, f64)> {
    e.ranked.iter().map(|av| (av.action, av.value)).collect()
}

fn run(name: &str) {
    let path = fixtures_dir().join(format!("{name}.json"));
    let fx = Fixture::load_file(&path).unwrap_or_else(|e| panic!("{e}"));
    let position = fx.position();
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{name}: {e}"));
    let mode = match fx.mode {
        Mode::FullRemainder => "full".to_string(),
        Mode::Horizon(h) => format!("h={h}"),
    };
    eprintln!(
        "{name}: {:?} to move at slot {}, {mode}, {} turns left, {} available, {} leaves, {} nodes, {:.1} ms, value {}, top {:?}",
        eval.mover,
        position.slot_index(),
        fx.format.turns_remaining(position.slot_index()),
        fx.available().len(),
        eval.leaves,
        eval.nodes,
        eval.elapsed.as_secs_f64() * 1000.0,
        eval.value,
        labels(&fx.universe, &eval.top_set),
    );

    // check 1 — the numbers exhibit the tactic
    assert_eq!(
        eval.top_set,
        fx.expected_top,
        "\n{name}: check 1 FAILED — the fixture is mis-authored.\n  intended {:?}\n  oracle   {:?}\n  ranked:\n{}\n",
        labels(&fx.universe, &fx.expected_top),
        labels(&fx.universe, &eval.top_set),
        ranked_report(&fx.universe, &eval),
    );

    // dry-run parity — this oracle agrees with the independent prototype
    assert_eq!(
        eval.value, fx.dry_run.value,
        "{name}: root value differs from the dry run"
    );
    assert_eq!(
        eval.leaves, fx.dry_run.leaves,
        "{name}: leaf count differs from the dry run"
    );
    assert_eq!(
        eval.nodes, fx.dry_run.nodes,
        "{name}: node count differs from the dry run"
    );

    // pair-order swap (D8 3) — every completed pair on the board, order reversed
    for (slot, entries) in fx.swapped_pairs() {
        let swapped = Position::new(&fx.format, &entries, &fx.pools, &fx.universe)
            .unwrap_or_else(|e| panic!("{name}: swapped pair at slot {slot}: {e}"));
        let again = evaluate(&OracleInput {
            position: &swapped,
            universe: &fx.universe,
            pools: &fx.pools,
            objective: &fx.universe,
            feasibility: fx.feasibility,
            mode: fx.mode,
            epsilon: fx.epsilon,
        })
        .unwrap_or_else(|e| panic!("{name}: swapped pair at slot {slot}: {e}"));
        assert_eq!(
            again.value, eval.value,
            "{name}: value changed when the pair at slot {slot} was swapped"
        );
        assert_eq!(
            again.top_set, eval.top_set,
            "{name}: top set changed when the pair at slot {slot} was swapped"
        );
        assert_eq!(
            again.leaves, eval.leaves,
            "{name}: leaf count changed when the pair at slot {slot} was swapped"
        );
    }

    // ---- slice 4: the candidate engine against the oracle (design § 6)
    let position = fx.position();
    let d_max = max_depth_for(&OracleInput {
        position: &position,
        universe: &fx.universe,
        pools: &fx.pools,
        objective: &fx.universe,
        feasibility: fx.feasibility,
        mode: fx.mode,
        epsilon: fx.epsilon,
    });
    let cand = candidate(&fx, fx.mode, &params(true, true, None));

    // check 2 — the candidate's top action is in the oracle's top set (D6)
    assert!(
        eval.top_set.contains(&cand.ranked[0].action),
        "\n{name}: check 2 FAILED — the engine's top action {} is not in the oracle's top set {:?}\n",
        label(&fx.universe, cand.ranked[0].action),
        labels(&fx.universe, &eval.top_set),
    );

    // root-exactness — the whole ranked list, values and order, equals the oracle's (R3)
    assert_eq!(
        as_pairs(&cand),
        oracle_pairs(&eval),
        "{name}: ranked list differs from the oracle"
    );
    assert_eq!(cand.top_set, eval.top_set, "{name}");
    assert!(
        !cand.partial && cand.depth == d_max,
        "{name}: unbudgeted must complete depth {d_max}"
    );

    // every horizon — pruning soundness at equal h (D2 ii)
    for d in 1..=d_max {
        let at_d = candidate(&fx, Mode::Horizon(d), &params(true, true, None));
        let oracle_d = oracle_at(&fx, Mode::Horizon(d));
        assert_eq!(
            as_pairs(&at_d),
            oracle_pairs(&oracle_d),
            "{name}: horizon {d}"
        );
    }

    // switches — neither pruning nor the table changes an answer; both off walks the oracle's tree
    for (prune, table) in [(true, false), (false, true), (false, false)] {
        let c = candidate(&fx, fx.mode, &params(prune, table, None));
        assert_eq!(
            as_pairs(&c),
            as_pairs(&cand),
            "{name}: prune={prune} table={table}"
        );
        if !prune && !table {
            assert_eq!(
                c.nodes, eval.nodes,
                "{name}: plain search must visit the oracle's nodes"
            );
            assert_eq!(
                c.leaves, eval.leaves,
                "{name}: plain search must evaluate the oracle's leaves"
            );
        }
    }

    // principal continuation replays to its own value (R8)
    for r in &cand.ranked {
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
        assert_eq!(
            fx.universe.value(&leaf),
            r.value,
            "{name}: {}",
            label(&fx.universe, r.action)
        );
        if r.ends.kind == LeafKind::DryPool {
            assert!(r.continuation.len() < d_max, "{name}");
        } else {
            assert_eq!(
                r.continuation.len(),
                d_max - 1,
                "{name}: {}",
                label(&fx.universe, r.action)
            );
        }
    }

    // budget property (R6, R7) — every fixture, deterministic
    let cut = candidate(
        &fx,
        fx.mode,
        &params(true, true, Some(cand.nodes_total - 1)),
    );
    assert!(
        cut.partial && cut.depth == d_max - 1,
        "{name}: one node short returns depth {}",
        d_max - 1
    );
    assert_eq!(
        as_pairs(&cut),
        oracle_pairs(&oracle_at(&fx, Mode::Horizon(d_max - 1))),
        "{name}: cut depth is exact"
    );
    let whole = candidate(&fx, fx.mode, &params(true, true, Some(cand.nodes_total)));
    assert!(
        !whole.partial && as_pairs(&whole) == as_pairs(&cand),
        "{name}: a budget of the control's total completes"
    );

    // S11 guard — (1) no top-set continuation ends with the MOVER's own side broken; (2) whether a top line
    // breaks the opponent (a denial) must match what the fixture DECLARES (`top_line_denies`), so a pool edit
    // that silently turns a tactic into an L-sized denial goes red; (3) the oracle's root value sits in the
    // band the declaration names (|U| > L/2 iff a denial), independent of the search's `ends`.
    for r in cand
        .ranked
        .iter()
        .filter(|r| eval.top_set.contains(&r.action))
    {
        assert!(
            !r.breaks_mover(cand.mover),
            "{name}: top action {} ends with the mover's side broken (blue_feasible={} red_feasible={})",
            label(&fx.universe, r.action),
            r.ends.blue_feasible,
            r.ends.red_feasible
        );
        let denies = !(r.ends.blue_feasible && r.ends.red_feasible);
        assert_eq!(
            denies,
            fx.top_line_denies,
            "{name}: top action {} — the fixture declares top_line_denies={}, the search found {} ({:?})",
            label(&fx.universe, r.action),
            fx.top_line_denies,
            denies,
            r.ends
        );
    }
    // (3) the oracle's own root value must sit in the band the declaration names: the feasible band and a
    // both-broken leaf have |U| ≤ Σ = (L − 1)/2 < L/2; a one-side denial has |U| ≥ L − Σ = (L + 1)/2 > L/2.
    // Independent of the search's `ends`, so it is a second witness to (2), and it fails both ways.
    let half_l = fx.universe.loss() / 2.0;
    assert_eq!(
        eval.value.abs() > half_l,
        fx.top_line_denies,
        "{name}: root value {} is {} L/2 = {} but the fixture declares top_line_denies={} — the tactic and its declaration disagree",
        eval.value,
        if eval.value.abs() > half_l { "above" } else { "within" },
        half_l,
        fx.top_line_denies
    );

    eprintln!(
        "{name}: candidate depth {d_max}, {} leaves, {} nodes, {} cutoffs, {} table hits, {:.1} ms; plain {} nodes",
        cand.leaves,
        cand.nodes,
        cand.cutoffs,
        cand.table_hits,
        cand.elapsed.as_secs_f64() * 1000.0,
        eval.nodes,
    );
}

#[test]
fn fixture_01_pair_completion() {
    run("01-pair-completion");
}

#[test]
fn fixture_02_profitable_denial() {
    run("02-profitable-denial");
}

#[test]
fn fixture_03_declining_denial() {
    run("03-declining-denial");
}

#[test]
fn fixture_04_partner_protection() {
    run("04-partner-protection");
}

#[test]
fn fixture_05_comp_breaking_pair() {
    run("05-comp-breaking-pair");
}

#[test]
fn fixture_06a_ban_truncated() {
    run("06a-ban-truncated");
}

#[test]
fn fixture_06b_ban_horizon() {
    run("06b-ban-horizon");
}

#[test]
fn fixture_07_slot6_bound() {
    run("07-slot6-bound");
}

#[test]
fn fixture_07b_slot6_full_fan() {
    run("07b-slot6-full-fan");
}

/// Three-way: the files on disk == the `FIXTURES` list == the `fixture_*` test functions in this
/// source file (read back with `include_str!`, so deleting a test function fails this check too).
#[test]
fn every_fixture_file_has_a_test() {
    let on_disk: BTreeSet<String> = std::fs::read_dir(fixtures_dir())
        .expect("fixtures/tier-a exists")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    let listed: BTreeSet<String> = FIXTURES.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        on_disk, listed,
        "every fixture file needs an entry in FIXTURES, and every listed name needs a file"
    );

    let source = include_str!("tier_a.rs");
    let test_fns = source
        .lines()
        .filter(|l| l.starts_with("fn fixture_"))
        .count();
    assert_eq!(
        test_fns,
        FIXTURES.len(),
        "one `fn fixture_*` test per listed fixture"
    );
    let lines: Vec<&str> = source.lines().collect();
    let attributed = lines
        .windows(2)
        .filter(|w| w[1].starts_with("fn fixture_") && w[0] == "#[test]")
        .count();
    assert_eq!(
        attributed,
        FIXTURES.len(),
        "every `fn fixture_*` must be preceded by #[test]"
    );
    for name in FIXTURES {
        let call = format!("run(\"{name}\")");
        assert_eq!(
            source.matches(call.as_str()).count(),
            1,
            "{name}: exactly one test calls run() with it"
        );
    }
    // and every file loads (a fixture that fails to load must not hide behind a missing test)
    assert_eq!(
        Fixture::load_dir(&fixtures_dir())
            .unwrap_or_else(|e| panic!("{e}"))
            .len(),
        FIXTURES.len()
    );
}

/// technique_vacuous_gate: a search that never prunes, or a table that never hits, passes every equality above.
#[test]
fn pruning_is_not_vacuous() {
    for name in ["04-partner-protection", "06a-ban-truncated"] {
        let fx = Fixture::load_file(&fixtures_dir().join(format!("{name}.json")))
            .unwrap_or_else(|e| panic!("{e}"));
        let c = candidate(&fx, fx.mode, &params(true, false, None));
        let e = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
        assert!(c.cutoffs > 0, "{name}: no cutoff fired");
        assert!(
            c.nodes < e.nodes,
            "{name}: {} candidate nodes vs {} oracle nodes",
            c.nodes,
            e.nodes
        );
    }
}

#[test]
fn table_is_not_vacuous() {
    for name in ["06a-ban-truncated", "06b-ban-horizon"] {
        let fx = Fixture::load_file(&fixtures_dir().join(format!("{name}.json")))
            .unwrap_or_else(|e| panic!("{e}"));
        let c = candidate(&fx, fx.mode, &params(true, true, None));
        let without = candidate(&fx, fx.mode, &params(true, false, None));
        // cumulative over the search: the per-iteration count on 06b is 1 and sits in the last iteration by luck
        // (measured 2026-09-14: 06a 19 per-iteration / 06a+06b totals well above; 06b 1 per-iteration, 2 total)
        assert!(c.table_hits_total > 0, "{name}: the table never hit");
        assert!(
            c.nodes < without.nodes,
            "{name}: the table hit but saved nothing ({} vs {})",
            c.nodes,
            without.nodes
        );
    }
}
