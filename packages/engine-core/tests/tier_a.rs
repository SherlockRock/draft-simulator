//! Tier A: the definition of "working" for the § 1 objective (design docs/designs/engine-tier-a-fixtures-design.md § 6;
//! spec Obsidian `draft-simulator-engine-target` § 3, D6, D9).
//!
//! Per fixture: load → bounds → oracle → check 1 (top set == intended) → dry-run parity (value,
//! leaves, nodes exactly as the independent prototype measured) → pair-order swap. Check 2 (a
//! candidate engine's top action ∈ the oracle's top set) has no candidate until slice 4 and is
//! an ignored stub that fails if run.
//!
//!   cargo test -p engine-core --test tier_a -- --nocapture

use engine_core::reference::fixture::Fixture;
use engine_core::reference::oracle::{evaluate, Evaluation, Mode, OracleInput};
use engine_core::reference::state::{Action, Position};
use engine_core::reference::universe::Universe;
use std::collections::BTreeSet;
use std::path::PathBuf;

/// One entry per file in fixtures/tier-a/. `every_fixture_file_has_a_test` keeps this honest.
const FIXTURES: [&str; 8] = [
    "01-pair-completion",
    "02-profitable-denial",
    "03-declining-denial",
    "04-partner-protection",
    "05-comp-breaking-pair",
    "06a-ban-truncated",
    "06b-ban-horizon",
    "07-slot6-bound",
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

/// D9: check 2 has no candidate engine until slice 4 lands the reference alpha-beta. This is a
/// stub that reports so and can never pass — `cargo test -- --ignored` fails it on purpose.
#[test]
#[ignore = "check 2: no candidate engine yet (slice 4)"]
fn check_2_candidate_top_action_in_oracle_top_set() {
    panic!("check 2: no candidate engine yet (slice 4 wires the reference alpha-beta here)");
}
