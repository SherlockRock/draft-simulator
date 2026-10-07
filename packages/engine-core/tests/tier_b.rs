//! Tier B (slice-5 design § 6, § 9; target note D7): the loader is proven on the sample files under
//! `tests/data/tier-b/`; the report runner over `fixtures/tier-b/` is ignored by design — a report,
//! never a gate, and an empty corpus directory must never be green.

mod common;

use common::{load_production_data, repo_root};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, Side};
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::feasibility::{
    action_charge, critical_pool, off_pool, pool_can_complete, side_feasible, FeasibilityMemo,
    FeasibilityRule, Price,
};
use engine_core::reference::live::LiveUniverse;
use engine_core::reference::node::legal_actions_under;
use engine_core::reference::oracle::{Mode, OracleInput};
use engine_core::reference::search::{search, SearchParams, Shortlist};
use engine_core::reference::state::{Action, Entry, Pools, Position, RoleSets};
use engine_core::reference::tier_b::{Category, TierBError, TierBFixture, Verdict};
use engine_core::reference::universe::{Universe, DEFAULT_OFF_POOL_COST};
use serde::Deserialize;
use serde_json::json;
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
    // Off-pool is legal under `roster` (B-proper), so an off-pool `actual_next` is no longer a
    // warning; the report prints its pool membership instead.
    let raw = sample_json("sample-fce65eb1-slot-11")
        .replace("\"actual_next\": \"Jinx\"", "\"actual_next\": \"Zac\"");
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
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
    let ids: Vec<String> = loaded
        .iter()
        .map(|l| match l {
            Ok(l) => l.fixture.id.clone(),
            Err(e) => panic!("{e}"),
        })
        .collect();
    assert_eq!(
        ids,
        [
            "2026-09-27-smoke-1-blue-first-pick",
            "2026-09-27-smoke-2-red-pair-no-adc",
            "2026-09-27-smoke-3-blue-ban-denial",
            "2026-09-27-smoke-4-red-last-pick",
            "sample-fce65eb1-slot-11",
            "sample-skip-at-slot-1"
        ]
    );
}

/// B-proper § 3: one malformed file is reported in its place; the rest of the directory still loads.
#[test]
fn load_dir_continues_past_a_malformed_file() {
    let live = live();
    let tmp = std::env::temp_dir().join(format!("tier-b-load-dir-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("temp dir");
    std::fs::write(
        tmp.join("a-good.json"),
        sample_json("sample-fce65eb1-slot-11"),
    )
    .expect("write");
    std::fs::write(tmp.join("b-bad.json"), "{ not json").expect("write");
    let loaded = TierBFixture::load_dir(&tmp, &live).unwrap_or_else(|e| panic!("{e}"));
    std::fs::remove_dir_all(&tmp).expect("cleanup");
    assert_eq!(loaded.len(), 2);
    assert!(loaded[0].is_ok(), "{:?}", loaded[0].as_ref().err());
    assert!(
        matches!(loaded[1], Err(TierBError::Json { ref label, .. }) if label.ends_with("b-bad.json")),
        "{:?}",
        loaded[1].as_ref().err()
    );
}

/// B-proper § 3: the `off-pool` category and the structured verdict round-trip; a verdict on a ban
/// root is a warning, not an error.
#[test]
fn a_verdict_and_the_off_pool_category_round_trip() {
    let live = live();
    let raw = sample_json("2026-09-27-smoke-1-blue-first-pick")
        .replace(
            "\"category\": \"counter-pick\"",
            "\"category\": \"off-pool\"",
        )
        // The smoke files carry the user's review text: splice the verdict in before `review`.
        .replace(
            "\"review\":",
            "\"verdict\": {\"off_pool\": true}, \"review\":",
        );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    assert_eq!(loaded.fixture.category, Category::OffPool);
    assert_eq!(loaded.fixture.verdict, Some(Verdict { off_pool: true }));
    // Absent by default.
    let plain = TierBFixture::from_json(
        &sample_json("2026-09-27-smoke-1-blue-first-pick"),
        "plain",
        &live,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(plain.fixture.verdict, None);
    // An unknown key inside the verdict is refused like any unknown field.
    assert!(matches!(
        TierBFixture::from_json(
            &sample_json("2026-09-27-smoke-1-blue-first-pick").replace(
                "\"review\":",
                "\"verdict\": {\"off_pool\": true, \"why\": \"x\"}, \"review\":"
            ),
            "edited",
            &live
        ),
        Err(TierBError::Json { .. })
    ));
    // A ban root has no off-pool question.
    let raw = sample_json("sample-skip-at-slot-1").replace(
        "\"review\": \"\"",
        "\"review\": \"\", \"verdict\": {\"off_pool\": false}",
    );
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
    assert!(loaded.warnings[0].contains("no off-pool question at a ban root"));
}

// ---------------------------------------------------------------- the report (B-proper § 3)

/// One rule-and-P the report runs every position under.
#[derive(Clone, Copy, Debug)]
enum Arm {
    PoolOrRoster,
    Roster(f64),
}

impl Arm {
    fn label(self, u: &Universe) -> String {
        match self {
            Arm::PoolOrRoster => format!("pool_or_roster (P = L = {:.1})", u.off_pool_cost()),
            Arm::Roster(p) => format!("roster P = {p}"),
        }
    }
}

fn env_list<T: std::str::FromStr>(name: &str, default: &str) -> Vec<T>
where
    T::Err: std::fmt::Debug,
{
    std::env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .split(',')
        .map(|s| {
            s.trim()
                .parse::<T>()
                .unwrap_or_else(|e| panic!("{name}: {s:?}: {e:?}"))
        })
        .collect()
}

/// What the roster sweep says about one pick root (B-proper § 3; the shapes review round 1 named).
/// `in_pool_at` / `off_pool_at` are the sweep P values (ascending) at which the top action was in-pool
/// / off-pool, after the arms that cannot speak were left out (partial, mixed top set).
#[derive(Clone, Debug, PartialEq)]
enum BreakEven {
    BanRoot,
    NoArm,
    InPoolAtEvery {
        smallest: f64,
    },
    OffPoolAtEvery {
        largest: f64,
    },
    /// Off-pool at low P, in-pool at high P — the one shape a single bound reads.
    Monotone {
        largest_off: f64,
        smallest_in: f64,
    },
    /// The top is off-pool at some P above a P where it was in-pool: no single bound exists.
    NonMonotone {
        in_pool_at: Vec<f64>,
        off_pool_at: Vec<f64>,
    },
}

fn break_even(pick_root: bool, in_pool_at: &[f64], off_pool_at: &[f64]) -> BreakEven {
    if !pick_root {
        return BreakEven::BanRoot;
    }
    match (in_pool_at.first(), off_pool_at.last()) {
        (None, None) => BreakEven::NoArm,
        (Some(&smallest), None) => BreakEven::InPoolAtEvery { smallest },
        (None, Some(&largest)) => BreakEven::OffPoolAtEvery { largest },
        (Some(&smallest_in), Some(&largest_off)) if largest_off < smallest_in => {
            BreakEven::Monotone {
                largest_off,
                smallest_in,
            }
        }
        _ => BreakEven::NonMonotone {
            in_pool_at: in_pool_at.to_vec(),
            off_pool_at: off_pool_at.to_vec(),
        },
    }
}

impl BreakEven {
    fn describe(&self) -> String {
        match self {
            BreakEven::BanRoot => "no off-pool question at a ban root".into(),
            BreakEven::NoArm => {
                "no roster arm could speak (every arm partial, a mixed tie or a failed search)".into()
            }
            BreakEven::InPoolAtEvery { .. } => "top in-pool at every P".into(),
            BreakEven::OffPoolAtEvery { .. } => "top off-pool at every P".into(),
            BreakEven::Monotone {
                largest_off,
                smallest_in,
            } => format!("top in-pool at P ≥ {smallest_in}; top off-pool at P ≤ {largest_off}"),
            BreakEven::NonMonotone {
                in_pool_at,
                off_pool_at,
            } => format!(
                "NON-MONOTONE across the sweep — in-pool at {in_pool_at:?}, off-pool at {off_pool_at:?}; no single bound, refine the sweep"
            ),
        }
    }
}

/// A verdict's constraint on P: half-open bounds over the sweep points (`None` = unbounded on that
/// side), or the reason the verdict cannot bound P. `off_pool: true` needs P below every P where the
/// top was in-pool; `false` needs P above every P where it was off-pool.
#[derive(Clone, Debug, PartialEq)]
enum Constraint {
    Bounds {
        lo: Option<f64>,
        hi: Option<f64>,
        note: &'static str,
    },
    Unusable(String),
}

fn constraint(off_pool: bool, be: &BreakEven) -> Constraint {
    use BreakEven::*;
    match (off_pool, be) {
        (_, BanRoot) => Constraint::Unusable("no off-pool question at a ban root".into()),
        (_, NoArm) => Constraint::Unusable("no roster arm could speak".into()),
        (_, NonMonotone { .. }) => {
            Constraint::Unusable("the sweep is non-monotone; refine it".into())
        }
        (true, Monotone { smallest_in, .. }) => Constraint::Bounds {
            lo: None,
            hi: Some(*smallest_in),
            note: "",
        },
        (true, InPoolAtEvery { smallest }) if *smallest <= 0.0 => Constraint::Unusable(
            "the top was in-pool even at P = 0; no P meets this verdict".into(),
        ),
        (true, InPoolAtEvery { smallest }) => Constraint::Bounds {
            lo: None,
            hi: Some(*smallest),
            note: " (below the whole sweep: widen it downward)",
        },
        (true, OffPoolAtEvery { .. }) => Constraint::Bounds {
            lo: None,
            hi: None,
            note: " (satisfied at every sweep P)",
        },
        (false, Monotone { largest_off, .. }) => Constraint::Bounds {
            lo: Some(*largest_off),
            hi: None,
            note: "",
        },
        (false, OffPoolAtEvery { largest }) => Constraint::Bounds {
            lo: Some(*largest),
            hi: None,
            note: " (above the whole sweep: widen it upward)",
        },
        (false, InPoolAtEvery { .. }) => Constraint::Bounds {
            lo: None,
            hi: None,
            note: " (satisfied at every sweep P)",
        },
    }
}

impl Constraint {
    fn describe(&self) -> String {
        match self {
            Constraint::Bounds { lo, hi, note } => {
                let lo = lo.map_or(String::new(), |l| format!("P > {l}"));
                let hi = hi.map_or(String::new(), |h| format!("P < {h}"));
                let both = match (lo.is_empty(), hi.is_empty()) {
                    (true, true) => "P unbounded".to_string(),
                    (false, true) => lo,
                    (true, false) => hi,
                    (false, false) => format!("{lo} and {hi}"),
                };
                format!("{both}{note}")
            }
            Constraint::Unusable(why) => format!("cannot bound P — {why}"),
        }
    }
}

/// The report's per-search limits: the node budget (cumulative across iterations;
/// `SearchParams::node_budget`) and how many ranked actions each arm prints (`TIER_B_TOP`).
#[derive(Clone, Copy, Debug)]
struct ReportLimits {
    node_budget: u64,
    top: usize,
}

impl ReportLimits {
    const DEFAULT: ReportLimits = ReportLimits {
        node_budget: 20_000_000,
        top: 3,
    };
}

/// The report's search mode, refused up front at 0 (the search would refuse every position with
/// `HorizonZero`: a horizon of 0 decides nothing).
fn report_mode(horizon: usize) -> Mode {
    assert!(
        horizon >= 1,
        "TIER_B_HORIZON: {horizon} decides nothing; the horizon must be at least 1"
    );
    Mode::Horizon(horizon)
}

/// The arms: `pool_or_roster`, then `roster` at each P of `ps` (ascending).
fn arms(ps: &[f64], loss: f64) -> Vec<Arm> {
    // Validated before any search runs (review round 2): a bad sweep entry must not panic mid-report.
    // P ≤ L is `resolve_off_pool_cost`'s own bound.
    for p in ps {
        assert!(
            p.is_finite() && *p >= 0.0,
            "TIER_B_P: {p} is not a finite non-negative logit"
        );
        assert!(*p <= loss, "TIER_B_P: {p} exceeds L = {loss}");
    }
    let mut sorted = ps.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("finite P"));
    std::iter::once(Arm::PoolOrRoster)
        .chain(sorted.into_iter().map(Arm::Roster))
        .collect()
}

/// The report for `loaded`, as text (B-proper § 3): per position, one block per arm — the top three,
/// each marked `[in-pool]` / `[off-pool n]` at a pick root, its value, ending and line, plus "searched
/// k of N"; `actual_next`'s pool membership and rank per arm; the break-even from the roster sweep;
/// the verdict's constraint on P; and a corpus summary with the verdict intersection (or the conflict,
/// or "no verdicts" — never a green line for an empty corpus).
fn render_report(
    loaded: &[Result<engine_core::reference::tier_b::Loaded, TierBError>],
    live: &LiveUniverse,
    mode: Mode,
    shortlist: Shortlist,
    ps: &[f64],
    limits: ReportLimits,
) -> String {
    use std::fmt::Write as _;
    let u = &live.universe;
    let mut out = String::new();
    let arms = arms(ps, u.loss());
    // (id, verdict, constraint) per position with a verdict.
    let mut constraints: Vec<(String, Verdict, Constraint)> = Vec::new();
    for l in loaded {
        let l = match l {
            Ok(l) => l,
            Err(e) => {
                let _ = writeln!(out, "\nFAILED TO LOAD: {e}");
                continue;
            }
        };
        for w in &l.warnings {
            let _ = writeln!(out, "  warning: {w}");
        }
        for n in &l.notes {
            let _ = writeln!(out, "  note: {n}");
        }
        let fx = &l.fixture;
        let position = fx
            .root
            .position(u)
            .unwrap_or_else(|e| panic!("{}: {e}", fx.id));
        let root = position
            .next_slot()
            .expect("a loaded position has a next slot");
        let pick_root = root.action == ActionType::Pick;
        // The mover's action charge (role-aware pools design § 2): the marker and the break-even's class
        // read what the search's root split reads. The same under either live rule.
        let charge = action_charge(
            &mut FeasibilityMemo::new(Price::ZERO),
            FeasibilityRule::Roster,
            root.side,
            &position,
            &fx.root.pools,
            u,
        );
        let names = |a: &Action| {
            a.champions()
                .map(|c| u.id(c).to_string())
                .collect::<Vec<_>>()
                .join("+")
        };
        let mark = |a: &Action| -> String {
            if !pick_root {
                return String::new();
            }
            let off = charge.of(*a).d_off;
            if off == 0 {
                " [in-pool]".to_string()
            } else {
                format!(" [off-pool {off}]")
            }
        };
        let _ = writeln!(
            out,
            "\n{} [{:?}] mover {:?} at slot {} — {}",
            fx.id,
            fx.category,
            root.side,
            position.slot_index(),
            fx.notes
        );
        let mut in_pool_at: Vec<f64> = Vec::new();
        let mut off_pool_at: Vec<f64> = Vec::new();
        let mut left_out: Vec<f64> = Vec::new();
        let mut actual_ranks: Vec<String> = Vec::new();
        for arm in &arms {
            let (feasibility, off_pool_cost) = match arm {
                Arm::PoolOrRoster => (FeasibilityRule::PoolOrRoster, None),
                Arm::Roster(p) => (FeasibilityRule::Roster, Some(*p)),
            };
            let out_come = search(
                &OracleInput {
                    position: &position,
                    universe: u,
                    pools: &fx.root.pools,
                    objective: u,
                    feasibility,
                    mode,
                    epsilon: 1e-9,
                    off_pool_cost,
                    // Q = 0 on every live position here: the slice-7 record.
                    off_role_cost: off_pool_cost.map(|_| 0.0),
                },
                &SearchParams {
                    node_budget: Some(limits.node_budget),
                    wall_budget: Duration::from_secs(300),
                    shortlist: Some(shortlist),
                    ..SearchParams::default()
                },
                &CancelHandle::new(),
                |_| {},
            );
            // One failed search is named in its place; the rest of the report still runs.
            let out_come = match out_come {
                Ok(o) => o,
                Err(e) => {
                    let _ = writeln!(
                        out,
                        "  rule {}\n    SEARCH FAILED: {}: {e}",
                        arm.label(u),
                        fx.id
                    );
                    if let (true, Arm::Roster(p)) = (pick_root, arm) {
                        left_out.push(*p);
                    }
                    if fx.actual_next.is_some() {
                        actual_ranks.push(format!("search failed ({})", arm.label(u)));
                    }
                    continue;
                }
            };
            let _ = writeln!(
                out,
                "  rule {} depth {} (partial {}) searched {} of {} top set {}",
                arm.label(u),
                out_come.depth,
                out_come.partial,
                out_come.ranked.len(),
                out_come.root_fan,
                out_come.top_set.len()
            );
            for r in out_come.ranked.iter().take(limits.top) {
                let padded = r
                    .action
                    .champions()
                    .any(|c| live.padded.iter().any(|p| p == u.id(c)));
                let _ = writeln!(
                    out,
                    "    {:<24} {:>10.4}{}{}  ends {:?} blue_feasible={} red_feasible={} off-pool blue {} red {}  line {}",
                    names(&r.action),
                    r.value,
                    mark(&r.action),
                    if padded { " [padded: no FM row]" } else { "" },
                    r.ends.kind,
                    r.ends.blue_feasible,
                    r.ends.red_feasible,
                    r.ends.blue_off_pool,
                    r.ends.red_off_pool,
                    r.continuation
                        .iter()
                        .map(names)
                        .collect::<Vec<_>>()
                        .join(" > ")
                );
            }
            if let (Some(top), Arm::Roster(p)) = (out_come.ranked.first(), arm) {
                if pick_root {
                    let in_pool = |a: &Action| charge.of(*a).is_in_pool();
                    let mixed = out_come.top_set.iter().any(in_pool)
                        && out_come.top_set.iter().any(|a| !in_pool(a));
                    if out_come.partial {
                        let _ = writeln!(out, "    (partial: excluded from the break-even)");
                        left_out.push(*p);
                    } else if mixed {
                        let _ = writeln!(
                            out,
                            "    (top set mixes in-pool and off-pool actions — a tie broken canonically; excluded from the break-even)"
                        );
                        left_out.push(*p);
                    } else if in_pool(&top.action) {
                        in_pool_at.push(*p);
                    } else {
                        off_pool_at.push(*p);
                    }
                }
            }
            if let Some(actual) = &fx.actual_next {
                // Rank = 1 + the number of STRICTLY better actions, so a tie reads as a tie.
                let rank = out_come
                    .ranked
                    .iter()
                    .find(|r| &r.action == actual)
                    .map(|found| {
                        1 + out_come
                            .ranked
                            .iter()
                            .filter(|r| match out_come.mover {
                                Side::Blue => r.value > found.value,
                                Side::Red => r.value < found.value,
                            })
                            .count()
                    });
                actual_ranks.push(format!(
                    "{} of {} ({})",
                    rank.map_or("unsearched".to_string(), |r| r.to_string()),
                    out_come.ranked.len(),
                    arm.label(u)
                ));
            }
        }
        if let Some(actual) = &fx.actual_next {
            let _ = writeln!(
                out,
                "  actual next {}{} ranked {}",
                names(actual),
                mark(actual),
                actual_ranks.join(", ")
            );
        }
        let be = break_even(pick_root, &in_pool_at, &off_pool_at);
        let _ = writeln!(out, "  break-even: {}", be.describe());
        if !left_out.is_empty() {
            let _ = writeln!(
                out,
                "  (roster arms left out of the break-even, which widens any bracket across them: P = {left_out:?})"
            );
        }
        // Every verdict is classified — a ban root's is `Unusable`, so the summary counts and names it
        // (the loader already warned; review round 2, Codex E).
        if let Some(v) = fx.verdict {
            let c = constraint(v.off_pool, &be);
            let _ = writeln!(
                out,
                "  verdict off_pool = {} → {}",
                v.off_pool,
                c.describe()
            );
            constraints.push((fx.id.clone(), v, c));
        }
        if !fx.review.is_empty() {
            let _ = writeln!(out, "  review: {}", fx.review);
        }
    }
    // The intersection over every verdict: lo = the largest "P >", hi = the smallest "P <".
    let _ = writeln!(out);
    if constraints.is_empty() {
        let _ = writeln!(out, "summary: no verdicts — nothing to calibrate against");
    } else {
        let usable: Vec<&(String, Verdict, Constraint)> = constraints
            .iter()
            .filter(|(_, _, c)| matches!(c, Constraint::Bounds { .. }))
            .collect();
        let unusable: Vec<String> = constraints
            .iter()
            .filter_map(|(id, _, c)| match c {
                Constraint::Unusable(why) => Some(format!("{id} ({why})")),
                Constraint::Bounds { .. } => None,
            })
            .collect();
        if !unusable.is_empty() {
            let _ = writeln!(
                out,
                "summary: {} verdict(s) could not bound P: {}",
                unusable.len(),
                unusable.join("; ")
            );
        }
        let lo = usable
            .iter()
            .filter_map(|(_, _, c)| match c {
                Constraint::Bounds { lo, .. } => *lo,
                Constraint::Unusable(_) => None,
            })
            .fold(None, |acc: Option<f64>, x| {
                Some(acc.map_or(x, |a| a.max(x)))
            });
        let hi = usable
            .iter()
            .filter_map(|(_, _, c)| match c {
                Constraint::Bounds { hi, .. } => *hi,
                Constraint::Unusable(_) => None,
            })
            .fold(None, |acc: Option<f64>, x| {
                Some(acc.map_or(x, |a| a.min(x)))
            });
        let empty = matches!((lo, hi), (Some(l), Some(h)) if l >= h);
        if usable.is_empty() {
            let _ = writeln!(
                out,
                "summary: no usable verdict — nothing to calibrate against"
            );
        } else if empty {
            let _ = writeln!(
                out,
                "summary: verdict interval over {} position(s) is EMPTY — P > {} and P < {} conflict; the positions: {}",
                usable.len(),
                lo.expect("empty needs both bounds"),
                hi.expect("empty needs both bounds"),
                usable
                    .iter()
                    .map(|(id, v, c)| format!("{id} (off_pool = {}, {})", v.off_pool, c.describe()))
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        } else {
            let _ = writeln!(
                out,
                "summary: verdict interval over {} position(s): {} and {} (sweep points; refine the sweep inside it)",
                usable.len(),
                lo.map_or("P ≥ 0".to_string(), |l| format!("P > {l}")),
                hi.map_or("P unbounded above".to_string(), |h| format!("P < {h}")),
            );
        }
    }
    out
}

/// Review round 1: the break-even and the verdict's constraint as pure functions of the sweep's
/// classes, on synthetic sweeps — the monotone flip, in-pool everywhere, off-pool everywhere, a
/// NON-MONOTONE sweep (no bound), a ban root and no arm.
#[test]
fn the_break_even_and_the_constraint_read_every_sweep_shape() {
    use BreakEven::*;
    let mono = break_even(true, &[0.15, 0.25], &[0.05]);
    assert_eq!(
        mono,
        Monotone {
            largest_off: 0.05,
            smallest_in: 0.15
        }
    );
    assert_eq!(constraint(true, &mono).describe(), "P < 0.15");
    assert_eq!(constraint(false, &mono).describe(), "P > 0.05");
    let in_every = break_even(true, &[0.05, 0.15], &[]);
    assert_eq!(in_every, InPoolAtEvery { smallest: 0.05 });
    assert_eq!(
        constraint(true, &in_every).describe(),
        "P < 0.05 (below the whole sweep: widen it downward)"
    );
    assert_eq!(
        constraint(false, &in_every).describe(),
        "P unbounded (satisfied at every sweep P)"
    );
    let off_every = break_even(true, &[], &[0.05, 0.15]);
    assert_eq!(off_every, OffPoolAtEvery { largest: 0.15 });
    assert_eq!(
        constraint(false, &off_every).describe(),
        "P > 0.15 (above the whole sweep: widen it upward)"
    );
    // In-pool at 0.05, off-pool at 0.25: the top flipped the wrong way — no single bound.
    let non_mono = break_even(true, &[0.05, 0.15], &[0.25]);
    assert!(matches!(non_mono, NonMonotone { .. }), "{non_mono:?}");
    assert!(non_mono.describe().starts_with("NON-MONOTONE"));
    assert_eq!(
        constraint(true, &non_mono),
        Constraint::Unusable("the sweep is non-monotone; refine it".into())
    );
    assert_eq!(
        constraint(false, &non_mono).describe(),
        "cannot bound P — the sweep is non-monotone; refine it"
    );
    // A flip back and forth is non-monotone too.
    assert!(matches!(
        break_even(true, &[0.15], &[0.05, 0.25]),
        NonMonotone { .. }
    ));
    assert_eq!(break_even(false, &[0.05], &[]), BanRoot);
    assert_eq!(break_even(true, &[], &[]), NoArm);
    assert!(matches!(constraint(true, &NoArm), Constraint::Unusable(_)));
    // Review round 2: "leave the pool" where the top was in-pool even at P = 0 has no P to offer.
    assert_eq!(
        constraint(true, &break_even(true, &[0.0, 0.15], &[])),
        Constraint::Unusable("the top was in-pool even at P = 0; no P meets this verdict".into())
    );
    // A bad sweep entry is refused before any search runs.
    assert!(std::panic::catch_unwind(|| arms(&[-0.1], 1.0)).is_err());
    assert!(std::panic::catch_unwind(|| arms(&[f64::NAN], 1.0)).is_err());
    assert_eq!(arms(&[0.15, 0.05], 1.0).len(), 3);
}

/// D7: a report read by a human, never a gate (B-proper § 3: the calibration instrument). Env:
/// `TIER_B_P` (comma list of logits, default `0.05,0.1,0.15`), `TIER_B_WIDTHS`
/// (`singles,pairs,root_off_pool`, default `30,60,100`), `TIER_B_HORIZON` (default 2), `TIER_B_TOP`
/// (ranked actions printed per arm, default 3).
#[test]
#[ignore = "Tier B report, not a gate (D7): cargo test --release --test tier_b -- --ignored --nocapture"]
fn tier_b_report() {
    let live = live();
    let corpus = dir("fixtures/tier-b");
    let loaded = TierBFixture::load_dir(&corpus, &live).unwrap_or_else(|e| panic!("{e}"));
    let ps: Vec<f64> = env_list("TIER_B_P", "0.05,0.1,0.15");
    let widths: Vec<usize> = env_list("TIER_B_WIDTHS", "30,60,100");
    let horizon: Vec<usize> = env_list("TIER_B_HORIZON", "2");
    let mode = report_mode(horizon[0]);
    let top: Vec<usize> = env_list("TIER_B_TOP", "3");
    assert_eq!(
        widths.len(),
        3,
        "TIER_B_WIDTHS = singles,pairs,root_off_pool"
    );
    let shortlist = Shortlist {
        singles: widths[0],
        pairs: widths[1],
        root_off_pool: widths[2],
    };
    println!(
        "{} Tier B position(s) in {} — P sweep {:?}, widths {:?}, horizon {}",
        loaded.len(),
        corpus.display(),
        ps,
        shortlist,
        horizon[0]
    );
    print!(
        "{}",
        render_report(
            &loaded,
            &live,
            mode,
            shortlist,
            &ps,
            ReportLimits {
                top: top[0],
                ..ReportLimits::DEFAULT
            }
        )
    );
}

/// A sample file with `verdict` spliced in before `review` (the smoke files carry review text).
fn with_verdict(
    name: &str,
    verdict: Option<bool>,
    live: &LiveUniverse,
) -> Result<engine_core::reference::tier_b::Loaded, TierBError> {
    let edit = verdict.map_or(String::new(), |v| {
        format!("\"verdict\": {{\"off_pool\": {v}}}, ")
    });
    TierBFixture::from_json(
        &sample_json(name).replace("\"review\":", &format!("{edit}\"review\":")),
        name,
        live,
    )
}

/// The refusal text of a call that must panic.
fn panic_text(f: impl FnOnce() + std::panic::UnwindSafe) -> String {
    let payload = std::panic::catch_unwind(f).expect_err("expected a refusal");
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

/// Execution-handoff parked item 1: one failed search must not kill the report. A node budget of 1
/// cuts every search inside depth 1 (`Timeout`, the failure a wide pair root meets on a real corpus);
/// each arm prints `SEARCH FAILED` in its place and the report goes on — the next arm, the next
/// position, the verdict and the summary.
#[test]
fn a_failed_search_is_named_and_the_report_continues() {
    let live = live();
    let loaded = vec![
        with_verdict("2026-09-27-smoke-1-blue-first-pick", Some(false), &live),
        with_verdict("sample-skip-at-slot-1", None, &live),
    ];
    let narrow = Shortlist {
        singles: 15,
        pairs: 25,
        root_off_pool: 50,
    };
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.05],
        ReportLimits {
            node_budget: 1,
            ..ReportLimits::DEFAULT
        },
    );
    println!("{text}");
    assert!(
        text.contains("SEARCH FAILED: 2026-09-27-smoke-1-blue-first-pick: "),
        "{text}"
    );
    assert_eq!(
        text.matches("SEARCH FAILED: ").count(),
        4,
        "two arms on two positions:\n{text}"
    );
    assert!(
        text.contains("SEARCH FAILED: sample-skip-at-slot-1: "),
        "{text}"
    );
    assert!(
        text.contains("verdict off_pool = false → cannot bound P — no roster arm could speak"),
        "{text}"
    );
    assert!(
        text.contains("summary: 1 verdict(s) could not bound P"),
        "{text}"
    );
}

/// Tier B authoring pass (2026-09-29): `TIER_B_TOP` sets how many ranked actions each arm prints, so
/// the reader sees the options behind the break-even, not just the top three.
#[test]
fn the_report_prints_the_requested_number_of_ranked_actions() {
    let live = live();
    let loaded = vec![with_verdict(
        "2026-09-27-smoke-1-blue-first-pick",
        None,
        &live,
    )];
    let narrow = Shortlist {
        singles: 15,
        pairs: 25,
        root_off_pool: 50,
    };
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.05],
        ReportLimits {
            top: 5,
            ..ReportLimits::DEFAULT
        },
    );
    let ranked = text
        .lines()
        .filter(|l| l.starts_with("    ") && l.contains("  ends "))
        .count();
    assert_eq!(ranked, 10, "five per arm on two arms:\n{text}");
}

/// Execution-handoff parked item 2: the sweep is checked before any search runs — a P above L (which
/// the search refuses) and a horizon of 0 (which decides nothing) are refused up front, named.
#[test]
fn a_p_above_l_and_a_zero_horizon_are_refused_before_any_search() {
    let l = live().universe.loss();
    let text = panic_text(|| {
        arms(&[0.15, 5000.0], l);
    });
    assert!(text.contains("TIER_B_P: 5000 exceeds L = "), "{text}");
    assert_eq!(arms(&[l], l).len(), 2, "P = L itself is a legal arm");
    let text = panic_text(|| {
        report_mode(0);
    });
    assert!(text.contains("TIER_B_HORIZON: 0"), "{text}");
    assert_eq!(report_mode(2), Mode::Horizon(2));
}

/// B-proper § 7 test 11: the sweep report on the four sample files with synthetic verdicts — one
/// block per arm, the marks, the break-evens and the verdict interval; then a contradictory pair of
/// verdicts prints the conflict. Horizon 1 and narrow widths keep it inside a debug-build budget;
/// the default list contains the shipped default P.
#[test]
fn the_report_sweeps_p_and_states_the_verdict_interval() {
    let live = live();
    let default_ps: Vec<f64> = env_list("TIER_B_P_UNSET_", "0.05,0.1,0.15");
    assert!(default_ps.contains(&DEFAULT_OFF_POOL_COST));
    let load = |name: &str, verdict: Option<bool>| with_verdict(name, verdict, &live);
    let loaded = vec![
        load("2026-09-27-smoke-1-blue-first-pick", Some(false)),
        load("2026-09-27-smoke-2-red-pair-no-adc", Some(true)),
        load("sample-fce65eb1-slot-11", None),
        load("sample-skip-at-slot-1", None),
    ];
    let narrow = Shortlist {
        singles: 15,
        pairs: 25,
        root_off_pool: 50,
    };
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.15, 0.05],
        ReportLimits::DEFAULT,
    );
    println!("{text}");
    for needle in [
        "rule pool_or_roster (P = L = 1026.4)",
        "rule roster P = 0.05",
        "rule roster P = 0.15",
        "searched 67 of 167",
        "searched 78 of 13695",
        "[in-pool]",
        "[off-pool 1]",
        "actual next Jinx [in-pool] ranked",
        "break-even: no off-pool question at a ban root",
        "break-even: top off-pool at every P",
        "verdict off_pool = true → P unbounded (satisfied at every sweep P)",
        "summary: verdict interval over 2 position(s)",
    ] {
        assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
    }
    // Smoke-1 (Blue's first pick at P = 0.05 and 0.15): whichever way its top goes, the verdict
    // "stay in pool" yields a lower bound or "unbounded below" — both are stated, never silent.
    assert!(
        text.contains("verdict off_pool = false → P > ")
            || text.contains("verdict off_pool = false → P unbounded (satisfied at every sweep P)"),
        "{text}"
    );
    assert_eq!(
        text.matches("rule roster P = ").count(),
        8,
        "two roster arms on four positions"
    );
    // A bracket: the sample's slot 11 goes off-pool (Syndra) at P = 0.05 and stays in pool (Hwei)
    // at 0.15, so "leave the pool" there means P < 0.15 and "stay" means P > 0.05; both verdicts on
    // that one position bracket P between the two sweep points.
    let loaded = vec![
        load("sample-fce65eb1-slot-11", Some(true)),
        load("sample-fce65eb1-slot-11", Some(false)),
    ];
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.05, 0.15],
        ReportLimits::DEFAULT,
    );
    println!("{text}");
    assert!(
        text.contains("verdict off_pool = true → P < 0.15"),
        "{text}"
    );
    assert!(
        text.contains("verdict off_pool = false → P > 0.05"),
        "{text}"
    );
    assert!(
        text.contains("summary: verdict interval over 2 position(s): P > 0.05 and P < 0.15"),
        "{text}"
    );
    // A conflict: "stay in pool" on smoke-2, whose top is off-pool at every P (P > 0.15), against
    // "leave the pool" on the sample's slot 11 (P < 0.15) — an empty interval, named.
    let loaded = vec![
        load("sample-fce65eb1-slot-11", Some(true)),
        load("2026-09-27-smoke-2-red-pair-no-adc", Some(false)),
    ];
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.05, 0.15],
        ReportLimits::DEFAULT,
    );
    assert!(
        text.contains(
            "verdict off_pool = false → P > 0.15 (above the whole sweep: widen it upward)"
        ),
        "{text}"
    );
    assert!(
        text.contains("is EMPTY — P > 0.15 and P < 0.15 conflict"),
        "{text}"
    );
    // Review focus (B-proper plan): an `actual_next` the root shortlist cut prints "unsearched", under
    // every arm — Zac is off-pool for Red at slot 11 and not among the best off-pool candidates.
    let zac = TierBFixture::from_json(
        &sample_json("sample-fce65eb1-slot-11")
            .replace("\"actual_next\": \"Jinx\"", "\"actual_next\": \"Zac\""),
        "zac",
        &live,
    );
    let text = render_report(
        &[zac],
        &live,
        Mode::Horizon(1),
        Shortlist {
            singles: 15,
            pairs: 25,
            root_off_pool: 1,
        },
        &[0.15],
        ReportLimits::DEFAULT,
    );
    assert!(
        text.contains("actual next Zac [off-pool 1] ranked unsearched of 93 (pool_or_roster (P = L = 1026.4)), unsearched of 94 (roster P = 0.15)"),
        "{text}"
    );
    // No verdicts at all: said so, never green.
    let loaded = vec![load("sample-skip-at-slot-1", None)];
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.05],
        ReportLimits::DEFAULT,
    );
    assert!(text.contains("summary: no verdicts"), "{text}");
    // A verdict at a ban root is counted as unusable, never silently dropped (round 2, Codex E).
    let loaded = vec![load("sample-skip-at-slot-1", Some(true))];
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.05],
        ReportLimits::DEFAULT,
    );
    assert!(
        text.contains(
            "verdict off_pool = true → cannot bound P — no off-pool question at a ban root"
        ),
        "{text}"
    );
    assert!(
        text.contains("summary: 1 verdict(s) could not bound P: sample-skip-at-slot-1 (no off-pool question at a ban root)"),
        "{text}"
    );
    assert!(text.contains("summary: no usable verdict"), "{text}");
    // A malformed entry is reported in its place and the rest still render.
    let loaded = vec![
        Err(TierBError::Invalid {
            id: "broken".into(),
            field: "x".into(),
            reason: "synthetic".into(),
        }),
        load("sample-skip-at-slot-1", None),
    ];
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(1),
        narrow,
        &[0.05],
        ReportLimits::DEFAULT,
    );
    assert!(
        text.contains("FAILED TO LOAD: broken: x: synthetic"),
        "{text}"
    );
    assert!(text.contains("sample-skip-at-slot-1"), "{text}");
}

/// Role-aware pools design § 6 test 1 (a), on the real pools: a pool written as a map of every meta
/// role is the list. For every position along the recorded line of every Tier B file (the corpus under
/// `fixtures/tier-b/` and the samples under `tests/data/tier-b/`), under both live rules and for both
/// sides: the off-pool count in both parts, the pool test, feasibility, the critical set, the legal fan
/// and the charge of every roster pick are equal for the list pools and for the same pools as maps.
/// This is the test that ties the tagged solver to list semantics — a list side never reaches it.
#[test]
fn a_map_of_every_meta_role_is_the_list_on_every_recorded_position() {
    let live = live();
    let u = &live.universe;
    let mut files = 0;
    let mut positions = 0;
    let mut charges = 0u64;
    for sub in ["fixtures/tier-b", "tests/data/tier-b"] {
        let loaded = TierBFixture::load_dir(&dir(sub), &live).unwrap_or_else(|e| panic!("{e}"));
        for fx in loaded
            .into_iter()
            .map(|l| l.unwrap_or_else(|e| panic!("{sub}: {e}")).fixture)
        {
            files += 1;
            let list = Pools {
                blue: fx.root.pools.blue,
                red: fx.root.pools.red,
                ..Pools::default()
            };
            let maps = list
                .with_roles(Side::Blue, RoleSets::meta_roles(list.blue, u))
                .with_roles(Side::Red, RoleSets::meta_roles(list.red, u));
            assert_eq!((maps.blue, maps.red), (list.blue, list.red), "{}", fx.id);
            for n in 0..=fx.root.entries.len() {
                let position = Position::new(&fx.root.format, &fx.root.entries[..n], &list, u)
                    .unwrap_or_else(|e| panic!("{} at {n}: {e}", fx.id))
                    .with_excluded(fx.root.excluded);
                positions += 1;
                for rule in [FeasibilityRule::PoolOrRoster, FeasibilityRule::Roster] {
                    for side in [Side::Blue, Side::Red] {
                        let ask = |pools: &Pools| {
                            let mut memo = FeasibilityMemo::new(Price::ZERO);
                            (
                                off_pool(&mut memo, rule, side, &position, pools, u),
                                pool_can_complete(&mut memo, rule, side, &position, pools, u),
                                side_feasible(&mut memo, rule, side, &position, pools, u),
                                critical_pool(&mut memo, side, &position, pools, u),
                            )
                        };
                        assert_eq!(ask(&maps), ask(&list), "{} at {n} {rule:?} {side:?}", fx.id);
                    }
                    let fan = |pools: &Pools| {
                        legal_actions_under(
                            &position,
                            u,
                            pools,
                            rule,
                            &mut FeasibilityMemo::new(Price::ZERO),
                        )
                    };
                    assert_eq!(fan(&maps), fan(&list), "{} at {n} {rule:?}", fx.id);
                    let Some(slot) = position.next_slot() else {
                        continue;
                    };
                    if slot.action != ActionType::Pick {
                        continue;
                    }
                    let mut memo = FeasibilityMemo::new(Price::ZERO);
                    let by_list = action_charge(&mut memo, rule, slot.side, &position, &list, u);
                    let by_map = action_charge(&mut memo, rule, slot.side, &position, &maps, u);
                    for action in position.pick_actions_from(position.available(u)) {
                        // The class and the off delta; not the grade delta — a map grades a
                        // displaced outside champion, a list never grades anything.
                        let (m, l) = (by_map.of(action), by_list.of(action));
                        assert_eq!(
                            (m.d_off, m.d_off_key),
                            (l.d_off, l.d_off_key),
                            "{} at {n} {rule:?} {action:?}",
                            fx.id
                        );
                        charges += 1;
                    }
                }
            }
        }
    }
    // Twelve corpus positions and the samples, every prefix, every roster pick at every pick slot.
    assert!(files >= 18, "{files} files");
    assert!(positions >= 250, "{positions} positions");
    assert!(charges >= 1_000_000, "{charges} charges");
}

/// The Rourke pool as the app stores it (dev DB, 2026-10-01): 23 entries, 20 champions — Jax and Udyr
/// sit under top and jungle, Yasuo under mid and adc.
fn rourke_map() -> serde_json::Value {
    json!({
        "top": ["Garen", "Jax", "Nasus", "Udyr"],
        "jungle": ["JarvanIV", "Jax", "Udyr", "Kindred", "Volibear"],
        "mid": ["Viktor", "Syndra", "Taliyah", "Yasuo"],
        "adc": ["Jhin", "MissFortune", "Sivir", "Varus", "Yasuo"],
        "support": ["Alistar", "Amumu", "Bard", "Shen", "Rakan"]
    })
}

/// The Team Liquid pool as the app stores it: 11 entries, 11 champions.
fn team_liquid_map() -> serde_json::Value {
    json!({
        "top": ["Aatrox", "KSante", "Renekton"],
        "jungle": ["Vi", "MonkeyKing"],
        "mid": ["Azir", "Sylas"],
        "adc": ["Jinx", "Kaisa"],
        "support": ["Nautilus", "Rakan"]
    })
}

/// smoke-4 (Rourke Blue against Team Liquid Red, Red's last pick) with `pools` replaced and,
/// optionally, a `capture` added.
fn smoke_4_with(pools: serde_json::Value, capture: Option<serde_json::Value>) -> String {
    let mut file: serde_json::Value =
        serde_json::from_str(&sample_json("2026-09-27-smoke-4-red-last-pick"))
            .unwrap_or_else(|e| panic!("{e}"));
    file["pools"] = pools;
    if let Some(capture) = capture {
        file["capture"] = capture;
    }
    file.to_string()
}

/// Role-aware pools design § 4 / § 6 test 16: a side's pool is a list or the app's role map. A map
/// loads with its tags — a champion under two roles under both — and the same set as the list file;
/// the two sides are independent; nothing is warned or noted for a map the meta agrees with.
#[test]
fn a_role_map_loads_with_its_tags_and_a_list_side_stays_a_list() {
    let live = live();
    let u = &live.universe;
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let list = TierBFixture::from_json(
        &sample_json("2026-09-27-smoke-4-red-last-pick"),
        "list",
        &live,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(list.fixture.root.pools.roles(Side::Blue), None);
    assert_eq!(list.fixture.root.pools.roles(Side::Red), None);
    assert!(list.notes.is_empty());

    let raw = smoke_4_with(
        json!({"blue": rourke_map(), "red": team_liquid_map()}),
        None,
    );
    let maps = TierBFixture::from_json(&raw, "maps", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(maps.warnings, list.warnings);
    assert!(maps.notes.is_empty(), "{:?}", maps.notes);
    let pools = &maps.fixture.root.pools;
    assert_eq!(
        (pools.blue, pools.red),
        (list.fixture.root.pools.blue, list.fixture.root.pools.red),
        "the map's union is the list"
    );
    let blue = pools.roles(Side::Blue).copied().unwrap_or_default();
    assert_eq!(blue.for_role(Role::Top).len(), 4);
    assert_eq!(blue.for_role(Role::Jungle).len(), 5);
    assert_eq!(blue.for_role(Role::Middle).len(), 4);
    assert_eq!(blue.for_role(Role::Adc).len(), 5);
    assert_eq!(blue.for_role(Role::Support).len(), 5);
    for (id, roles) in [
        ("Jax", [Role::Top, Role::Jungle]),
        ("Yasuo", [Role::Middle, Role::Adc]),
    ] {
        assert!(
            roles.iter().all(|r| blue.for_role(*r).contains(idx(id))),
            "{id}"
        );
    }
    assert!(
        !blue.for_role(Role::Top).contains(idx("Yasuo")),
        "the meta's top is not listed"
    );
    let red = pools.roles(Side::Red).copied().unwrap_or_default();
    assert!(red.for_role(Role::Adc).contains(idx("Jinx")));
    assert_eq!(red.union().len(), 11);

    // One side a map, the other a list: independent.
    let blue_list = list_ids(&sample_json("2026-09-27-smoke-4-red-last-pick"), "blue");
    let raw = smoke_4_with(json!({"blue": blue_list, "red": team_liquid_map()}), None);
    let mixed = TierBFixture::from_json(&raw, "mixed", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(mixed.fixture.root.pools.roles(Side::Blue), None);
    assert_eq!(mixed.fixture.root.pools.roles(Side::Red), Some(&red));
    assert_eq!(mixed.fixture.root.pools.blue, pools.blue);
}

/// One side's list of ids out of a Tier B file's `pools`.
fn list_ids(raw: &str, side: &str) -> serde_json::Value {
    let file: serde_json::Value = serde_json::from_str(raw).unwrap_or_else(|e| panic!("{e}"));
    file["pools"][side].clone()
}

/// Design § 4 / test 16: every mistake in a role map is named with its location.
#[test]
fn the_loader_names_every_mistake_in_a_role_map() {
    let live = live();
    let invalid = |blue: serde_json::Value| -> (String, String) {
        let raw = smoke_4_with(json!({"blue": blue, "red": team_liquid_map()}), None);
        match TierBFixture::from_json(&raw, "edited", &live) {
            Err(TierBError::Invalid { field, reason, .. }) => (field, reason),
            other => panic!("expected Invalid, got {other:?}"),
        }
    };
    let edit = |f: &dyn Fn(&mut serde_json::Value)| {
        let mut map = rourke_map();
        f(&mut map);
        invalid(map)
    };

    // A key the app's map does not have (the meta says BOTTOM, the engine Adc; the file says adc).
    let (field, reason) = edit(&|m| m["bottom"] = json!(["Jhin"]));
    assert_eq!(field, "pools.blue.bottom");
    assert_eq!(
        reason,
        "unknown role; a role map has exactly top, jungle, mid, adc, support"
    );
    // A missing role: all five are required (an empty list says "nobody").
    let (field, reason) = edit(&|m| {
        m.as_object_mut().map(|o| o.remove("support"));
    });
    assert_eq!(field, "pools.blue.support");
    assert_eq!(
        reason,
        "missing; a role map has exactly top, jungle, mid, adc, support"
    );
    // An unknown champion, named with its role.
    let (field, reason) = edit(&|m| m["mid"] = json!(["Viktor", "Nobody"]));
    assert_eq!(field, "pools.blue.mid");
    assert_eq!(reason, "unknown champion \"Nobody\"");
    // Something that is not an id, named with its index.
    let (field, reason) = edit(&|m| m["top"] = json!(["Garen", 7]));
    assert_eq!(field, "pools.blue.top[1]");
    assert_eq!(reason, "expected a champion id");
    // A role that is not a list.
    let (field, reason) = edit(&|m| m["jungle"] = json!("JarvanIV"));
    assert_eq!(field, "pools.blue.jungle");
    assert_eq!(reason, "expected a list of champion ids");
    // A side that is neither form.
    let (field, reason) = invalid(json!(7));
    assert_eq!(field, "pools.blue");
    assert_eq!(
        reason,
        "expected a list of champion ids or a role map {top, jungle, mid, adc, support}"
    );
    // An empty role is fine.
    let raw = smoke_4_with(
        json!({"blue": rourke_map(), "red": {"top": ["Aatrox"], "jungle": ["Vi"], "mid": ["Sylas"], "adc": [], "support": ["Nautilus"]}}),
        None,
    );
    assert!(TierBFixture::from_json(&raw, "edited", &live).is_ok());
}

/// Design RA4 / test 16: an entry under a role the meta does not list loads — it is honoured, not
/// refused — and the loader says so in a note, per entry, naming the side it is playable for.
#[test]
fn an_off_meta_entry_loads_and_is_noted() {
    let live = live();
    let mut red = team_liquid_map();
    // Vi is a jungler in the meta; this pool also lists her top.
    red["top"] = json!(["Aatrox", "KSante", "Renekton", "Vi"]);
    let raw = smoke_4_with(json!({"blue": rourke_map(), "red": red}), None);
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        loaded.notes,
        vec![format!(
            "{}: pools.red.top: Vi is not a meta top — playable for Red only",
            loaded.fixture.id
        )]
    );
    let u = &live.universe;
    let vi = u.index("Vi").expect("Vi");
    let tags = loaded
        .fixture
        .root
        .pools
        .roles(Side::Red)
        .copied()
        .unwrap_or_default();
    assert!(tags.for_role(Role::Top).contains(vi) && tags.for_role(Role::Jungle).contains(vi));
    assert_eq!(tags.off_meta(u), vec![(Role::Top, vi)]);
}

/// Design, Definitions / § 6 test 6 — `a_past_pick_outside_the_recorded_pool_loads_as_a_fact`, for a
/// role map: a board pick the map OMITS is added under every role the meta lists for it (a sunk fact:
/// it cannot be off-role, so it is never charged), and a board pick the map LISTS keeps its listed
/// roles and gains none.
#[test]
fn a_role_map_keeps_a_listed_board_picks_roles_and_adds_an_omitted_one_under_the_metas() {
    let live = live();
    let u = &live.universe;
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let mut red = team_liquid_map();
    // Sylas is on Red's board (slot 11); drop him from the recorded pool.
    red["mid"] = json!(["Azir"]);
    let raw = smoke_4_with(json!({"blue": rourke_map(), "red": red}), None);
    let loaded = TierBFixture::from_json(&raw, "edited", &live).unwrap_or_else(|e| panic!("{e}"));
    assert!(loaded.notes.is_empty(), "{:?}", loaded.notes);
    let pools = &loaded.fixture.root.pools;
    let tags = pools.roles(Side::Red).copied().unwrap_or_default();
    // Omitted: in the set, under the meta's three roles for Sylas.
    assert!(pools.red.contains(idx("Sylas")));
    assert_eq!(pools.red.len(), 11);
    for role in [Role::Middle, Role::Jungle, Role::Support] {
        assert!(tags.for_role(role).contains(idx("Sylas")), "{role:?}");
    }
    assert!(!tags.for_role(Role::Top).contains(idx("Sylas")));
    // Listed: Aatrox is on the board and listed top; the meta's jungle is not added.
    assert!(tags.for_role(Role::Top).contains(idx("Aatrox")));
    assert!(!tags.for_role(Role::Jungle).contains(idx("Aatrox")));
    // Nothing is charged for the board as it stands, on either side, under either live rule.
    let position = loaded
        .fixture
        .root
        .position(u)
        .unwrap_or_else(|e| panic!("{e}"));
    for rule in [FeasibilityRule::PoolOrRoster, FeasibilityRule::Roster] {
        for side in [Side::Blue, Side::Red] {
            let count = off_pool(
                &mut FeasibilityMemo::new(Price::ZERO),
                rule,
                side,
                &position,
                pools,
                u,
            );
            assert_eq!(count.made, 0, "{rule:?} {side:?}");
        }
    }
}

/// Design § 4 / test 16: a role-map side is checked against the capture's `display` map, role by role
/// (the wire's keys), and a list side against `search`, as before.
#[test]
fn a_role_map_is_checked_against_the_captures_display() {
    let live = live();
    let display = |map: &serde_json::Value| {
        json!({
            "TOP": map["top"], "JUNGLE": map["jungle"], "MIDDLE": map["mid"],
            "ADC": map["adc"], "SUPPORT": map["support"]
        })
    };
    let capture = |blue: serde_json::Value, red: serde_json::Value| {
        json!({
            "protocolVersion": "1.2.0",
            "pools": {
                // A map side never reads `search`: these lists are wrong on purpose.
                "blue": {"display": blue, "search": ["Zed"]},
                "red": {"display": red, "search": []},
                "crossGameExclusions": []
            }
        })
    };
    let pools = json!({"blue": rourke_map(), "red": team_liquid_map()});
    let load = |capture: serde_json::Value| {
        TierBFixture::from_json(&smoke_4_with(pools.clone(), Some(capture)), "edited", &live)
            .unwrap_or_else(|e| panic!("{e}"))
    };

    // The same maps on the wire: nothing to say.
    let same = load(capture(display(&rourke_map()), display(&team_liquid_map())));
    assert!(same.warnings.is_empty(), "{:?}", same.warnings);

    // One champion fewer in the captured Blue adc list: Blue differs, Red does not.
    let mut other = rourke_map();
    other["adc"] = json!(["Jhin", "MissFortune", "Sivir", "Varus"]);
    let differing = load(capture(display(&other), display(&team_liquid_map())));
    assert_eq!(differing.warnings.len(), 1, "{:?}", differing.warnings);
    assert!(differing.warnings[0].contains("pools.blue differs from the captured request"));
    // The top-level field is used.
    assert_eq!(
        differing
            .fixture
            .root
            .pools
            .roles(Side::Blue)
            .map(|t| t.for_role(Role::Adc).len()),
        Some(5)
    );
}

/// Role-aware pools design § 2 / § 6 test 11: the report's marker and the class its break-even reads
/// come from the same action charge as the search's root split. smoke-4 (Red needs an ADC) with Kaisa
/// listed under mid instead of adc: as a list she is an in-pool ADC; as a map she is an off-role fill,
/// marked `[off-pool 1]`, the entry is noted (the meta has no mid Kaisa), and the break-even reads the
/// top action's class accordingly.
#[test]
fn the_report_marks_an_off_role_fill_off_pool() {
    let live = live();
    let mut red = team_liquid_map();
    red["adc"] = json!(["Jinx"]);
    red["mid"] = json!(["Azir", "Sylas", "Kaisa"]);
    let widths = Shortlist {
        singles: 15,
        pairs: 25,
        root_off_pool: 50,
    };
    let report = |pools: serde_json::Value| {
        let loaded = vec![TierBFixture::from_json(
            &smoke_4_with(pools, None),
            "edited",
            &live,
        )];
        render_report(
            &loaded,
            &live,
            Mode::Horizon(1),
            widths,
            &[0.05, 0.25],
            ReportLimits {
                top: 4,
                ..ReportLimits::DEFAULT
            },
        )
    };
    let maps = report(json!({"blue": rourke_map(), "red": red}));
    let list = report(json!({
        "blue": list_ids(&sample_json("2026-09-27-smoke-4-red-last-pick"), "blue"),
        "red": list_ids(&sample_json("2026-09-27-smoke-4-red-last-pick"), "red")
    }));
    // The first line of `text` that ranks Kaisa (the `pool_or_roster` arm: three pool champions).
    let kaisa = |text: &str| -> String {
        text.lines()
            .find(|l| l.starts_with("    Kaisa "))
            .unwrap_or_else(|| panic!("no Kaisa line:\n{text}"))
            .to_string()
    };

    // As a map: an off-role fill. Marked, charged L under `pool_or_roster` (0.1138 + 1026.4), counted
    // on Red's side of the leaf, noted as an off-meta entry, and no longer one of the root's in-pool
    // actions (52 searched: Jinx, K'Sante and the best 50 off-pool).
    assert!(
        maps.contains(
            "  note: 2026-09-27-smoke-4-red-last-pick: pools.red.mid: Kaisa is not a meta mid — playable for Red only"
        ),
        "{maps}"
    );
    let line = kaisa(&maps);
    assert!(line.contains("1026.5508 [off-pool 1]"), "{line}");
    assert!(line.contains("off-pool blue 0 red 1"), "{line}");
    assert!(
        maps.contains("  actual next Kaisa [off-pool 1] ranked 2 of 3"),
        "{maps}"
    );
    assert_eq!(maps.matches("searched 52 of 154").count(), 2, "{maps}");
    assert!(
        maps.contains("    Jinx                         0.0555 [in-pool]"),
        "{maps}"
    );

    // As a list: an in-pool ADC, free, nothing noted, one more in-pool action at the root.
    assert!(!list.contains("  note: "), "{list}");
    let line = kaisa(&list);
    assert!(line.contains("0.1138 [in-pool]"), "{line}");
    assert!(line.contains("off-pool blue 0 red 0"), "{line}");
    assert!(
        list.contains("  actual next Kaisa [in-pool] ranked 2 of 3"),
        "{list}"
    );
    assert_eq!(list.matches("searched 53 of 154").count(), 2, "{list}");
}

/// Role-aware pools design § 6 test 20 — the acceptance corpus. The five positions parked on
/// 2026-09-29 because the engine's best "in-pool" action was an off-role fill, now written as role
/// maps (`gen_corpus_roles.py`), on the boards as recorded, under `roster` at the default P, widths B,
/// horizon 2. On the four parked directly:
///
/// - as LISTS the best in-pool action is the fill the parking note names (Galio pushed to support by
///   a second and third mid; Viktor, then Syndra, in the ADC slot; Vi at top);
/// - as MAPS that same action is off-pool with the charge shown, it falls in the ranking, and the
///   best in-pool action is a champion the pool lists for the missing role.
///
/// top-17 was parked one ply down: its best in-pool pair is the same in both forms, and what moves is
/// Red's reply — as a list the free off-role "Vi at top", as a map a reply Red pays for.
///
/// Whether the TOP action is in-pool is not asserted: at P = 0.10 it is an off-pool pick on every one
/// of these (the calibration question the next session reads), which is the search doing its job.
///
/// Pinned to P = 0.10 explicitly — the P the slice was measured at — so the ranks stay the record of
/// the slice when `DEFAULT_OFF_POOL_COST` moves (the recalibration, 2026-10-04).
#[test]
fn the_parked_positions_stop_calling_an_off_role_fill_in_pool() {
    const MEASURED_AT: f64 = 0.10;
    let live = live();
    let u = &live.universe;
    let action = |ids: &[&str]| -> Action {
        let c = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
        match ids {
            [a] => Action::Pick(c(a)),
            [a, b] => Action::pair(c(a), c(b)),
            other => panic!("{other:?}"),
        }
    };
    struct Reading {
        /// (rank, action) of the best in-pool action; the rank of `fill`.
        best_in_pool: (usize, Action),
        fill_rank: usize,
        fill_charge: usize,
        /// The best in-pool line: its value and Red's off-pool count at its end.
        value: f64,
        red_off_pool: usize,
        /// The fill's own line: its value and both sides' off-pool counts at its end.
        fill_value: f64,
        fill_off_pool: (usize, usize),
    }
    let read = |id: &str, fill: Action, as_list: bool| -> Reading {
        let fx = TierBFixture::load_file(
            &dir("fixtures/tier-b").join(format!("2026-09-29-{id}.json")),
            &live,
        )
        .unwrap_or_else(|e| panic!("{e}"))
        .fixture;
        assert!(
            fx.root.pools.roles(Side::Blue).is_some() && fx.root.pools.roles(Side::Red).is_some(),
            "{id}: the corpus is written as role maps"
        );
        let pools = if as_list {
            Pools {
                blue: fx.root.pools.blue,
                red: fx.root.pools.red,
                ..Pools::default()
            }
        } else {
            fx.root.pools
        };
        let position = fx.root.position(u).unwrap_or_else(|e| panic!("{e}"));
        let mover = position.mover().expect("a root");
        let outcome = search(
            &OracleInput {
                position: &position,
                universe: u,
                pools: &pools,
                objective: u,
                feasibility: FeasibilityRule::Roster,
                mode: Mode::Horizon(2),
                epsilon: 1e-9,
                off_pool_cost: Some(MEASURED_AT),
                // Q = 0: the ranks are the slice-7 record, read before the grade existed.
                off_role_cost: Some(0.0),
            },
            &SearchParams {
                node_budget: Some(20_000_000),
                wall_budget: Duration::from_secs(300),
                shortlist: Some(Shortlist {
                    singles: 30,
                    pairs: 60,
                    root_off_pool: 100,
                }),
                ..SearchParams::default()
            },
            &CancelHandle::new(),
            |_| {},
        )
        .unwrap_or_else(|e| panic!("{id}: {e}"));
        assert!(!outcome.partial, "{id}");
        let charge = action_charge(
            &mut FeasibilityMemo::new(Price::ZERO),
            FeasibilityRule::Roster,
            mover,
            &position,
            &pools,
            u,
        );
        let rank = |a: Action| {
            1 + outcome
                .ranked
                .iter()
                .position(|r| r.action == a)
                .unwrap_or_else(|| panic!("{id}: {a:?} is not ranked"))
        };
        let best = outcome
            .ranked
            .iter()
            .find(|r| charge.of(r.action).is_in_pool())
            .unwrap_or_else(|| panic!("{id}: no in-pool action ranked"));
        let filled = &outcome.ranked[rank(fill) - 1];
        Reading {
            best_in_pool: (rank(best.action), best.action),
            fill_rank: rank(fill),
            fill_charge: charge.of(fill).d_off,
            value: best.value,
            red_off_pool: best.ends.red_off_pool,
            fill_value: filled.value,
            fill_off_pool: (filled.ends.blue_off_pool, filled.ends.red_off_pool),
        }
    };

    // (position, the parked fill, its rank as a list, its charge and rank as a map, the best in-pool
    // action as a map and its rank).
    for (id, fill, list_rank, charge, map_rank, in_role, in_role_rank) in [
        (
            "supp-pinch-slot-17-dme",
            action(&["Ahri", "Syndra"]),
            1,
            2,
            16,
            action(&["Renata", "Ziggs"]),
            5,
        ),
        (
            "supp-pinch-slot-19-kittens",
            action(&["Viktor"]),
            2,
            1,
            13,
            action(&["Sivir"]),
            6,
        ),
        (
            "ad-pinch-slot-19-kittens",
            action(&["Syndra"]),
            1,
            1,
            2,
            action(&["Ashe"]),
            3,
        ),
        (
            "top-pinch-slot-19-kittens",
            action(&["Vi"]),
            5,
            1,
            27,
            action(&["Ornn"]),
            12,
        ),
    ] {
        let list = read(id, fill, true);
        assert_eq!(list.best_in_pool, (list_rank, fill), "{id}: as a list");
        assert_eq!(list.fill_charge, 0, "{id}: as a list the fill is free");
        let map = read(id, fill, false);
        assert_eq!(map.fill_charge, charge, "{id}: as a map");
        assert_eq!(map.fill_rank, map_rank, "{id}: as a map");
        assert_eq!(map.best_in_pool, (in_role_rank, in_role), "{id}: as a map");
        // The price itself, independently of any pinned rank: at a last-pick root the fill's leaf is
        // the same complete board in both forms, so its value moves by exactly P times the change in
        // (Red's off-pool count − Blue's) — the right amount, on the right side, with the right sign.
        if id.contains("slot-19") {
            let net = |r: &Reading| {
                f64::from(u8::try_from(r.fill_off_pool.1).expect("a handful"))
                    - f64::from(u8::try_from(r.fill_off_pool.0).expect("a handful"))
            };
            let moved = map.fill_value - list.fill_value;
            let expected = MEASURED_AT * (net(&map) - net(&list));
            assert!(
                (moved - expected).abs() < 1e-9,
                "{id}: the fill moved by {moved}, the counts say {expected}"
            );
            assert_eq!(list.fill_off_pool.1, 0, "{id}: free as a list");
            assert_eq!(map.fill_off_pool.1, charge, "{id}: charged to Red as a map");
        }
    }
    // Two more charges the design names: at top-19 Locke (listed Middle) cannot go top and pushes
    // MonkeyKing there — two off-role pilots; at supp-17 Ahri + Kaisa pushes Galio to support — one.
    // (Asked of the charge directly: Ahri + Kaisa is cut by the shortlist and never ranked.)
    let charge_at = |id: &str, a: Action| -> usize {
        let fx = TierBFixture::load_file(
            &dir("fixtures/tier-b").join(format!("2026-09-29-{id}.json")),
            &live,
        )
        .unwrap_or_else(|e| panic!("{e}"))
        .fixture;
        let position = fx.root.position(u).unwrap_or_else(|e| panic!("{e}"));
        action_charge(
            &mut FeasibilityMemo::new(Price::ZERO),
            FeasibilityRule::Roster,
            position.mover().expect("a root"),
            &position,
            &fx.root.pools,
            u,
        )
        .of(a)
        .d_off
    };
    assert_eq!(
        charge_at("top-pinch-slot-19-kittens", action(&["Locke"])),
        2
    );
    assert_eq!(
        charge_at("supp-pinch-slot-17-dme", action(&["Ahri", "Kaisa"])),
        1
    );

    // top-17, one ply down: the same best in-pool pair either way; Red's reply stops being free.
    let pair = action(&["Locke", "Rumble"]);
    let (list, map) = (
        read("top-pinch-slot-17-dme", pair, true),
        read("top-pinch-slot-17-dme", pair, false),
    );
    assert_eq!(list.best_in_pool, (2, pair));
    assert_eq!(map.best_in_pool, (2, pair));
    assert_eq!((list.red_off_pool, map.red_off_pool), (0, 1));
    assert!(
        map.value > list.value,
        "Red's reply is priced: {} then {}",
        list.value,
        map.value
    );
}

/// Role-aware pools design § 2 (the sixth reader): the report's break-even reads the action's CLASS
/// from the same charge. supp-17's top pair under role maps is Syndra + Ziggs — both in DME's pool as
/// a set, but taking them pushes Galio to support — so the top is OFF-pool, and the break-even says so.
/// At P = 0.10, the P the slice was measured at (the value line is P-dependent).
#[test]
fn the_report_classes_an_in_set_off_role_pair_off_pool() {
    let live = live();
    let loaded = vec![TierBFixture::load_file(
        &dir("fixtures/tier-b/2026-09-29-supp-pinch-slot-17-dme.json"),
        &live,
    )];
    let text = render_report(
        &loaded,
        &live,
        Mode::Horizon(2),
        Shortlist {
            singles: 30,
            pairs: 60,
            root_off_pool: 100,
        },
        &[0.10],
        ReportLimits {
            top: 2,
            ..ReportLimits::DEFAULT
        },
    );
    assert!(
        text.contains("    Syndra+Ziggs                 0.0099 [off-pool 1]"),
        "{text}"
    );
    assert!(
        text.contains("  break-even: top off-pool at every P"),
        "{text}"
    );
}

/// Engine-role-grade design § 7 tests 2 and 3 — the instrument: every Tier B fixture under both arms,
/// `pool_or_roster` and `roster` at P = 0.10 with Q = 0, at the report's smaller widths (15, 25, 50),
/// horizon 2 — horizon 1 at a root whose next turn is a pair (the two slot-7 pair roots and the four
/// slot-16 singles: ordering a child's 12 000 pairs costs 0.9–7.8 M board evaluations per root, 80 % of
/// a 112 s debug run; the full-width horizon-2 identity is the release report's at `TIER_B_Q=0`) —
/// rendered line for line and compared with `tests/data/tier-b/q0-record.txt`, which a copy
/// of this test (`docs/plans/2026-10-06-engine-role-grade-data/q0-record-base-test.rs`) wrote at
/// `2be5e71`, before any grade existed. Values are printed as their bits, so "identical" means bit for
/// bit: values, ranks, every counter, the root fan and the searched count, each line's continuation and
/// ending, each action's in-pool class and off count, and the root's legal-action count. Set
/// `TIER_B_Q0_RECORD=write` to rewrite the record — only ever at the base.
#[test]
fn at_q_zero_both_arms_reproduce_the_record_on_every_fixture() {
    use std::fmt::Write as _;
    let live = live();
    let u = &live.universe;
    let corpus = dir("fixtures/tier-b");
    let loaded = TierBFixture::load_dir(&corpus, &live).unwrap_or_else(|e| panic!("{e}"));
    assert!(loaded.len() >= 21, "{} fixtures", loaded.len());
    let mut out = String::new();
    for l in loaded {
        let fx = l.unwrap_or_else(|e| panic!("{e}")).fixture;
        let position = fx
            .root
            .position(u)
            .unwrap_or_else(|e| panic!("{}: {e}", fx.id));
        let root = position.next_slot().expect("a root");
        let next_is_pair = position
            .apply(position.legal_actions(u, &fx.root.pools)[0])
            .next_slot()
            .is_some_and(|s| s.pair_start);
        let horizon = if next_is_pair { 1 } else { 2 };
        let names = |a: &Action| {
            a.champions()
                .map(|c| u.id(c).to_string())
                .collect::<Vec<_>>()
                .join("+")
        };
        for (arm, feasibility, p, q) in [
            ("pool_or_roster", FeasibilityRule::PoolOrRoster, None, None),
            (
                "roster P=0.10 Q=0",
                FeasibilityRule::Roster,
                Some(0.10),
                Some(0.0),
            ),
        ] {
            let legal = legal_actions_under(
                &position,
                u,
                &fx.root.pools,
                feasibility,
                &mut FeasibilityMemo::new(Price::ZERO),
            )
            .len();
            let charge = action_charge(
                &mut FeasibilityMemo::new(Price::ZERO),
                feasibility,
                root.side,
                &position,
                &fx.root.pools,
                u,
            );
            let o = search(
                &OracleInput {
                    position: &position,
                    universe: u,
                    pools: &fx.root.pools,
                    objective: u,
                    feasibility,
                    mode: Mode::Horizon(horizon),
                    epsilon: 1e-9,
                    off_pool_cost: p,
                    off_role_cost: q,
                },
                &SearchParams {
                    node_budget: Some(ReportLimits::DEFAULT.node_budget),
                    wall_budget: Duration::from_secs(300),
                    shortlist: Some(Shortlist {
                        singles: 15,
                        pairs: 25,
                        root_off_pool: 50,
                    }),
                    ..SearchParams::default()
                },
                &CancelHandle::new(),
                |_| {},
            )
            .unwrap_or_else(|e| panic!("{} {arm}: {e}", fx.id));
            let _ = writeln!(
                out,
                "== {} | {arm} | horizon {horizon} depth {} partial {} root_fan {} searched {} nodes {} leaves {} orderings {} cutoffs {} table_hits {} table_entries {} top_set {} legal {legal}",
                fx.id, o.depth, o.partial, o.root_fan, o.ranked.len(), o.nodes, o.leaves, o.orderings,
                o.cutoffs, o.table_hits, o.table_entries, o.top_set.len()
            );
            for (rank, r) in o.ranked.iter().enumerate() {
                let class = if root.action == ActionType::Pick {
                    match charge.of(r.action).d_off {
                        0 => "in-pool".to_string(),
                        n => format!("off-pool {n}"),
                    }
                } else {
                    "-".to_string()
                };
                let _ =
                    writeln!(
                    out,
                    "  {:>3} {:<24} {:016x} {:?} {class} ends {:?} bf {} rf {} off {} {} line {}",
                    rank + 1,
                    names(&r.action),
                    r.value.to_bits(),
                    r.value,
                    r.ends.kind,
                    r.ends.blue_feasible,
                    r.ends.red_feasible,
                    r.ends.blue_off_pool,
                    r.ends.red_off_pool,
                    r.continuation.iter().map(names).collect::<Vec<_>>().join(" > ")
                );
            }
        }
    }
    let path = dir("tests/data/tier-b/q0-record.txt");
    if std::env::var("TIER_B_Q0_RECORD").as_deref() == Ok("write") {
        std::fs::write(&path, &out).unwrap_or_else(|e| panic!("{e}"));
        println!("wrote {} ({} lines)", path.display(), out.lines().count());
        return;
    }
    let record =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut head = String::new();
    for (n, (mine, theirs)) in out.lines().zip(record.lines()).enumerate() {
        if mine.starts_with("== ") {
            head = mine.to_string();
        }
        assert_eq!(
            mine,
            theirs,
            "line {} of the record differs under {head}",
            n + 1
        );
    }
    assert_eq!(
        out.lines().count(),
        record.lines().count(),
        "the record's length"
    );
}
