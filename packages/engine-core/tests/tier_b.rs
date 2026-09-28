//! Tier B (slice-5 design § 6, § 9; target note D7): the loader is proven on the sample files under
//! `tests/data/tier-b/`; the report runner over `fixtures/tier-b/` is ignored by design — a report,
//! never a gate, and an empty corpus directory must never be green.

mod common;

use common::{load_production_data, repo_root};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::Side;
use engine_core::fm::FmWeights;
use engine_core::reference::feasibility::FeasibilityRule;
use engine_core::reference::live::LiveUniverse;
use engine_core::reference::oracle::{Mode, OracleInput};
use engine_core::reference::search::{search, SearchParams};
use engine_core::reference::state::{Action, Entry};
use engine_core::reference::tier_b::{Category, TierBError, TierBFixture};
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

fn live() -> LiveUniverse {
    let root = repo_root();
    let fm = FmWeights::from_json_str(
        &std::fs::read_to_string(root.join("data/compiled/fm-weights.json"))
            .expect("fm-weights.json"),
    )
    .expect("fm-weights parses");
    #[derive(Deserialize)]
    struct MetaVersion {
        version: String,
    }
    let version: MetaVersion = serde_json::from_str(
        &std::fs::read_to_string(root.join("data/compiled/champion-meta.json"))
            .expect("champion-meta.json"),
    )
    .expect("champion-meta version");
    let (_, meta) = load_production_data();
    LiveUniverse::build(&fm, &version.version, &meta).unwrap_or_else(|e| panic!("{e}"))
}

fn dir(sub: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(sub)
}

fn sample_json(name: &str) -> String {
    std::fs::read_to_string(dir("tests/data/tier-b").join(format!("{name}.json")))
        .unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn the_sample_position_loads_with_no_warnings() {
    let live = live();
    let loaded = TierBFixture::load_file(
        &dir("tests/data/tier-b/sample-fce65eb1-slot-11.json"),
        &live,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    let fx = loaded.fixture;
    assert_eq!(fx.id, "sample-fce65eb1-slot-11");
    assert_eq!(fx.category, Category::CounterPick);
    assert_eq!(
        fx.source.session.as_deref(),
        Some("fce65eb1-c615-4382-afd5-7190d5c3cfe2")
    );
    assert_eq!(fx.root.entries.len(), 11);
    let u = &live.universe;
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    assert_eq!(fx.root.entries[10], Entry::Pick(idx("Veigar")));
    assert_eq!(fx.actual_next, Some(Action::Pick(idx("Jinx"))));
    let position = fx.root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.mover(), Some(Side::Red));
    assert!(fx.path.is_some());
}

#[test]
fn a_skip_loads_on_a_ban_slot_and_removes_nothing() {
    let live = live();
    let loaded = TierBFixture::from_json(&sample_json("sample-skip-at-slot-1"), "skip", &live)
        .unwrap_or_else(|e| panic!("{e}"));
    let fx = loaded.fixture;
    assert_eq!(fx.category, Category::ProReplay);
    assert_eq!(fx.root.entries[1], Entry::Skip);
    assert_eq!(fx.actual_next, None);
    assert_eq!(fx.our_side, Some(Side::Blue));
    let u = &live.universe;
    // A pro replay carries no pools (D7): absent pools = the whole roster on both sides.
    assert_eq!(fx.root.pools.blue, u.all());
    assert_eq!(fx.root.pools.red, u.all());
    let position = fx.root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.slot_index(), 2);
    assert_eq!(position.mover(), Some(Side::Blue));
    assert_eq!(position.taken().len(), 1, "a skip removes nothing");
    assert_eq!(position.legal_actions(u, &fx.root.pools).len(), 172);
}

/// Exclusions and the opaque capture are carried; an excluded champion is not a legal action.
#[test]
fn exclusions_and_the_raw_capture_load() {
    let live = live();
    let raw = sample_json("sample-fce65eb1-slot-11").replace(
        "\"review\": \"\"",
        "\"review\": \"\", \"exclusions\": [\"Hwei\"], \"our_side\": \"Blue\", \"capture\": {\"protocolVersion\": \"1.2.0\", \"anything\": [1, 2]}",
    );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    let fx = loaded.fixture;
    let u = &live.universe;
    let hwei = u.index("Hwei").expect("Hwei");
    assert!(fx.root.excluded.contains(hwei));
    assert_eq!(fx.our_side, Some(Side::Blue));
    assert_eq!(
        fx.capture
            .as_ref()
            .and_then(|c| c.get("protocolVersion"))
            .and_then(|v| v.as_str()),
        Some("1.2.0")
    );
    let position = fx.root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert!(!position
        .legal_actions(u, &fx.root.pools)
        .contains(&Action::Pick(hwei)));
}

/// `actual_next` is what was played, so it always loads — but one the reference could not generate
/// is flagged, so the printed rank is read correctly.
#[test]
fn an_illegal_actual_next_is_a_warning() {
    let live = live();
    let raw = sample_json("sample-fce65eb1-slot-11")
        .replace("\"actual_next\": \"Jinx\"", "\"actual_next\": \"Gwen\"");
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
    assert!(loaded.warnings[0].contains("Gwen is not a legal action here (already on the board)"));
    let raw = sample_json("sample-fce65eb1-slot-11")
        .replace("\"actual_next\": \"Jinx\"", "\"actual_next\": \"Zac\"");
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        loaded.warnings[0].contains(
            "Zac is not a legal action here (outside the mover's pool, which can still finish)"
        ),
        "{:?}",
        loaded.warnings
    );
    // Excluded — not "already on the board", although exclusions live in `taken` (review round 2).
    let raw = sample_json("sample-fce65eb1-slot-11").replace(
        "\"review\": \"\"",
        "\"review\": \"\", \"exclusions\": [\"Jinx\"]",
    );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
    assert!(
        loaded.warnings[0].contains("Jinx is not a legal action here (excluded)"),
        "{:?}",
        loaded.warnings
    );
}

/// `capture` is provenance: it must look like a wire request, and the top-level fields win.
#[test]
fn a_capture_must_be_a_request_and_a_divergent_one_is_warned() {
    let live = live();
    let base = sample_json("sample-fce65eb1-slot-11");
    match TierBFixture::from_json(
        &base.replace("\"review\": \"\"", "\"review\": \"\", \"capture\": [1, 2]"),
        "edited",
        &live,
    ) {
        Err(TierBError::Invalid { field, .. }) => assert_eq!(field, "capture"),
        other => panic!("expected Invalid(capture), got {other:?}"),
    }
    let raw = base.replace(
        "\"review\": \"\"",
        "\"review\": \"\", \"capture\": {\"protocolVersion\": \"1.2.0\", \"pools\": {\"blue\": {\"search\": [\"Zed\"]}, \"red\": {\"search\": []}, \"crossGameExclusions\": []}}",
    );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(loaded.warnings.len(), 2, "{:?}", loaded.warnings);
    assert!(loaded.warnings[0].contains("pools.blue differs from the captured request"));
    assert!(loaded.warnings[1].contains("pools.red differs from the captured request"));
    assert_eq!(
        loaded.fixture.root.pools.blue.len(),
        85,
        "the top-level field is used"
    );
}

/// Exclusions that name a champion already on the board are accepted (the union is idempotent) but
/// flagged: it is a data error in the capture.
#[test]
fn an_exclusion_already_on_the_board_is_a_warning() {
    let live = live();
    let raw = sample_json("sample-fce65eb1-slot-11").replace(
        "\"review\": \"\"",
        "\"review\": \"\", \"exclusions\": [\"Gwen\", \"Hwei\"]",
    );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
    assert!(loaded.warnings[0].contains("exclusions name champions already on the board: Gwen"));
}

/// U5 through the Tier B loader: a past pick the recorded pool omits is a fact, not an error.
#[test]
fn a_past_pick_outside_the_recorded_pool_loads_as_a_fact() {
    let live = live();
    let raw = sample_json("sample-fce65eb1-slot-11").replace("      \"Veigar\",\n", "");
    assert!(
        !raw.contains("\"Veigar\",\n      \"Velkoz\""),
        "the edit must remove Veigar from the Blue pool"
    );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    let u = &live.universe;
    let veigar = u.index("Veigar").expect("Veigar");
    assert!(loaded.fixture.root.pools.blue.contains(veigar));
    assert_eq!(loaded.fixture.root.pools.blue.len(), 85);
}

#[test]
fn a_data_version_mismatch_is_a_warning_not_an_error() {
    let live = live();
    let raw = sample_json("sample-fce65eb1-slot-11")
        .replace(
            "\"fm_version\": \"fm-2026-09-01-6880daa\"",
            "\"fm_version\": \"fm-2099-01-01-abcdef0\"",
        )
        .replace(
            "\"meta_version\": \"16.13.1\"",
            "\"meta_version\": \"99.1.1\"",
        );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(loaded.warnings.len(), 2, "{:?}", loaded.warnings);
    assert!(loaded.warnings[0].contains("fm-2099-01-01-abcdef0"));
    assert!(loaded.warnings[1].contains("99.1.1"));
}

#[test]
fn the_loader_names_every_authoring_mistake() {
    let live = live();
    let base = sample_json("sample-fce65eb1-slot-11");
    let invalid = |raw: &str| -> (String, String) {
        match TierBFixture::from_json(raw, "edited", &live) {
            Err(TierBError::Invalid { field, reason, .. }) => (field, reason),
            other => panic!("expected Invalid, got {other:?}"),
        }
    };

    // A pair at a single-pick root.
    let (field, reason) = invalid(&base.replace(
        "\"actual_next\": \"Jinx\"",
        "\"actual_next\": [\"Jinx\", \"Lulu\"]",
    ));
    assert_eq!(field, "actual_next");
    assert_eq!(
        reason,
        "the root is not a pair turn; expected actions are single ids"
    );

    // An unknown champion in a pool.
    let (field, reason) = invalid(&base.replace("\"red\": [", "\"red\": [\"Nobody\", "));
    assert_eq!(field, "pools.red");
    assert_eq!(reason, "unknown champion \"Nobody\"");

    // A skip on a pick slot.
    let (field, reason) = invalid(&base.replace(
        "{\n      \"slot\": 10,\n      \"side\": \"Blue\",\n      \"kind\": \"pick\",\n      \"champion\": \"Veigar\"\n    }",
        "{\n      \"slot\": 10,\n      \"side\": \"Blue\",\n      \"kind\": \"skip\"\n    }",
    ));
    assert_eq!(field, "position[10].kind");
    assert_eq!(reason, "the format's slot 10 is a Pick");

    // An unsupported format.
    let (field, _) = invalid(&base.replace("\"format\": \"standard\"", "\"format\": \"fearless\""));
    assert_eq!(field, "format");

    // An unknown field anywhere.
    assert!(matches!(
        TierBFixture::from_json(
            &base.replace("\"review\": \"\"", "\"review\": \"\", \"expected_top\": []"),
            "edited",
            &live
        ),
        Err(TierBError::Json { .. })
    ));
}

#[test]
fn load_dir_walks_the_samples_in_name_order() {
    let live = live();
    let loaded =
        TierBFixture::load_dir(&dir("tests/data/tier-b"), &live).unwrap_or_else(|e| panic!("{e}"));
    let ids: Vec<&str> = loaded.iter().map(|l| l.fixture.id.as_str()).collect();
    assert_eq!(ids, ["sample-fce65eb1-slot-11", "sample-skip-at-slot-1"]);
}

/// D7: a report read by a human, never a gate. Prints the ranked top three, how each continuation
/// ends, the actual next action and the S11 band for every position in `fixtures/tier-b/`.
#[test]
#[ignore = "Tier B report, not a gate (D7): cargo test --release --test tier_b -- --ignored --nocapture"]
fn tier_b_report() {
    let live = live();
    let u = &live.universe;
    let corpus = dir("fixtures/tier-b");
    let loaded = TierBFixture::load_dir(&corpus, &live).unwrap_or_else(|e| panic!("{e}"));
    println!(
        "{} Tier B position(s) in {}",
        loaded.len(),
        corpus.display()
    );
    for l in loaded {
        for w in &l.warnings {
            println!("  warning: {w}");
        }
        let fx = l.fixture;
        let position = fx
            .root
            .position(u)
            .unwrap_or_else(|e| panic!("{}: {e}", fx.id));
        let out = search(
            &OracleInput {
                position: &position,
                universe: u,
                pools: &fx.root.pools,
                objective: u,
                feasibility: FeasibilityRule::PoolOrRoster,
                mode: Mode::Horizon(2),
                epsilon: 1e-9,
                off_pool_cost: None,
            },
            &SearchParams {
                node_budget: Some(20_000_000),
                wall_budget: Duration::from_secs(60),
                ..SearchParams::default()
            },
            &CancelHandle::new(),
            |_| {},
        )
        .unwrap_or_else(|e| panic!("{}: {e}", fx.id));
        let names = |a: &Action| {
            a.champions()
                .map(|c| u.id(c).to_string())
                .collect::<Vec<_>>()
                .join("+")
        };
        println!(
            "\n{} [{:?}] mover {:?} depth {} (partial {}) — {}",
            fx.id, fx.category, out.mover, out.depth, out.partial, fx.notes
        );
        println!(
            "  top set: {} action(s) within epsilon of the best",
            out.top_set.len()
        );
        for r in out.ranked.iter().take(3) {
            let padded = r
                .action
                .champions()
                .any(|c| live.padded.iter().any(|p| p == u.id(c)));
            // U10: a pick outside the mover's pool is legal only because the pool could not finish
            // (bans are unrestricted, so the mark applies to pick roots only).
            let off_pool = position
                .next_slot()
                .is_some_and(|slot| slot.action == engine_core::draft_state::ActionType::Pick)
                && r.action
                    .champions()
                    .any(|c| !fx.root.pools.for_side(out.mover).contains(c));
            println!(
                "  {:<24} {:>9.4}{}{}  ends {:?} blue_feasible={} red_feasible={}  line {}",
                names(&r.action),
                r.value,
                if padded { " [padded: no FM row]" } else { "" },
                if off_pool {
                    " [off-pool: the pool could not finish]"
                } else {
                    ""
                },
                r.ends.kind,
                r.ends.blue_feasible,
                r.ends.red_feasible,
                r.continuation
                    .iter()
                    .map(names)
                    .collect::<Vec<_>>()
                    .join(" > ")
            );
        }
        if let Some(actual) = &fx.actual_next {
            // Rank = 1 + the number of STRICTLY better actions, so a tie reads as a tie.
            let rank = out
                .ranked
                .iter()
                .find(|r| &r.action == actual)
                .map(|found| {
                    1 + out
                        .ranked
                        .iter()
                        .filter(|r| match out.mover {
                            Side::Blue => r.value > found.value,
                            Side::Red => r.value < found.value,
                        })
                        .count()
                });
            println!(
                "  actual next {} ranked {} of {}",
                names(actual),
                rank.map_or("not a legal action".to_string(), |r| r.to_string()),
                out.ranked.len()
            );
        }
        // The band, read off the top line's ending — the facts the value was built from. Under the
        // live rule a magnitude test against L/2 would call a forced off-pool pick (P = L) a denial.
        let band = match out.ranked.first().map(|r| r.ends) {
            Some(e) if !e.blue_feasible && !e.red_feasible => {
                "both sides broken: R1 cancels the bands and the value is the board net of the off-pool term (the S11 residual)"
            }
            Some(e) if !e.blue_feasible || !e.red_feasible => {
                "the L' band: a side cannot finish even from the roster (a defect if it is the mover's, a denial if the opponent's)"
            }
            Some(e) if e.blue_off_pool != e.red_off_pool => {
                "the off-pool band: forced off-pool picks, P each (a forced opponent is the live form of denial)"
            }
            _ => "the feasible band",
        };
        println!(
            "  band: {band} (|value| = {:.4}; P = {:.1}, L'/2 = {:.1}; off-pool blue {} red {})",
            out.value.abs(),
            u.off_pool_cost(),
            u.live_loss() / 2.0,
            out.ranked.first().map_or(0, |r| r.ends.blue_off_pool),
            out.ranked.first().map_or(0, |r| r.ends.red_off_pool)
        );
        if !fx.review.is_empty() {
            println!("  review: {}", fx.review);
        }
    }
}
