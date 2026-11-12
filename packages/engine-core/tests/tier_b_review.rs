//! The Tier B review tool (design docs/designs/tier-b-review-tool-design.md). Task 1: the whole side an
//! action makes, and the roles a side's locked picks leave open. Constructed band universes, with
//! shares so an off-role placement reads a real grade.

mod common;

use common::{load_production_data_from, repo_root};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, Side};
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::entries::SpecError;
use engine_core::reference::feasibility::{
    action_charge, arrangement, open_roles, placements, FeasibilityMemo, FeasibilityRule, Price,
    SidePlacement,
};
use engine_core::reference::format::{Format, Slot};
use engine_core::reference::live::LiveUniverse;
use engine_core::reference::node::{LeafEnd, LeafKind};
use engine_core::reference::oracle::{Mode, OracleInput};
use engine_core::reference::search::{search, SearchParams, Shortlist};
use engine_core::reference::state::{Action, Entry, Pools, Position, RoleSets};
use engine_core::reference::tier_b::{
    CorpusSplit, Label, Loaded, OptionKey, TierBError, TierBFixture, VerdictMode,
};
use engine_core::reference::tier_b_review::{
    draft_of, floor_keep, opponent_charge, render_summary, run_review, run_review_with,
    score_ranking, summary_of, ArmWire, DataStamp, EngineStamp, OwnPick, PositionScore,
    ReviewConfig, ReviewRun, RunHeader, ScoredAction, SearchStamp, TopClassName, WidthsWire,
};
use engine_core::reference::tier_b_rule::{
    canonical_line, choose_arm, grid_axes, line_text, read_arms, read_run, readable_metrics,
    weight_read, ArmInput, ArmRole, ArmScore, ArmSpec, Axis, Edge, EdgeSide, Fold, FoldKind,
    HoldoutState, LabelChange, LineState, Metrics, PickChange, PositionInput, RBucket, RevealRead,
    TopLine, WeightReason,
};
use engine_core::reference::universe::{ChampionIdx, ChampionSet, Universe, UniverseSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

/// `(id, positions, playable, shares)` per champion, as JSON list bodies; `""` leaves a field out.
type Row = (&'static str, &'static str, &'static str, &'static str);

/// The band (two single-role champions per role, no shares) plus `extra`.
fn universe(extra: &[Row]) -> Universe {
    let band = [
        ("T1", "Top"),
        ("T2", "Top"),
        ("J1", "Jungle"),
        ("J2", "Jungle"),
        ("M1", "Middle"),
        ("M2", "Middle"),
        ("A1", "Adc"),
        ("A2", "Adc"),
        ("S1", "Support"),
        ("S2", "Support"),
    ];
    let mut list: Vec<String> = band
        .iter()
        .map(|(id, role)| format!(r#"{{"id": "{id}", "positions": ["{role}"], "linear": 0}}"#))
        .collect();
    for (id, positions, playable, shares) in extra {
        let playable = if playable.is_empty() {
            String::new()
        } else {
            format!(r#", "playable": [{playable}]"#)
        };
        let shares = if shares.is_empty() {
            String::new()
        } else {
            format!(r#", "shares": [{shares}]"#)
        };
        list.push(format!(
            r#"{{"id": "{id}", "positions": [{positions}], "linear": 0{playable}{shares}}}"#
        ));
    }
    let spec: UniverseSpec =
        serde_json::from_str(&format!(r#"{{"champions": [{}]}}"#, list.join(",")))
            .unwrap_or_else(|e| panic!("{e}"));
    Universe::new(spec).unwrap_or_else(|e| panic!("{e:?}"))
}

fn idx(u: &Universe, id: &str) -> ChampionIdx {
    u.index(id).unwrap_or_else(|| panic!("no champion {id}"))
}

fn set(u: &Universe, ids: &[&str]) -> ChampionSet {
    ids.iter().map(|id| idx(u, id)).collect()
}

/// Tags from `(role, ids)` rows.
fn tags(u: &Universe, rows: &[(Role, &[&str])]) -> RoleSets {
    rows.iter().fold(RoleSets::default(), |tags, (role, ids)| {
        ids.iter()
            .fold(tags, |tags, id| tags.with(*role, idx(u, id)))
    })
}

/// The standard format's board, every ban a skip, each side's picks in the order given, stopping at the
/// first pick slot whose side has none left.
fn board(format: &Format, u: &Universe, blue: &[&str], red: &[&str]) -> Vec<Entry> {
    let (mut blue, mut red) = (blue.iter(), red.iter());
    let mut entries = Vec::new();
    for slot in format.slots() {
        match slot.action {
            ActionType::Ban => entries.push(Entry::Skip),
            ActionType::Pick => {
                let next = match slot.side {
                    Side::Blue => blue.next(),
                    Side::Red => red.next(),
                };
                match next {
                    Some(id) => entries.push(Entry::Pick(idx(u, id))),
                    None => break,
                }
            }
        }
    }
    entries
}

const PRICE: Price = Price {
    p: 0.1,
    q_unit: 0.0005,
};

/// Blue holds `L`, listed (by Blue's pool) only at mid, though the meta lets it play top at grade 75
/// (shares 0.2 top / 0.8 mid). The root is Blue's pair slot. `X` plays mid alone and `Y` adc alone, so a
/// pair `X + Y` has exactly one arrangement: `L` moves to top.
fn pair_rows() -> [Row; 3] {
    [
        (
            "L",
            r#""Middle", "Top""#,
            r#""Top", "Middle""#,
            "0.2, 0, 0.8, 0, 0",
        ),
        ("X", r#""Middle""#, "", "0, 0, 1, 0, 0"),
        ("Y", r#""Adc""#, "", "0, 0, 0, 1, 0"),
    ]
}

struct PairRoot {
    u: Universe,
    format: Format,
    pools: Pools,
    entries: Vec<Entry>,
}

fn pair_root() -> PairRoot {
    let u = universe(&pair_rows());
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["L", "X", "M1"]),
            (Role::Adc, &["Y", "A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let red = set(&u, &["T2", "J2", "M2", "A2", "S2"]);
    let pools = Pools {
        red,
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u, &["L"], &["T2", "J2"]);
    PairRoot {
        u,
        format,
        pools,
        entries,
    }
}

fn every_pair(u: &Universe, without: &[&str]) -> Vec<Action> {
    let all: Vec<ChampionIdx> = (0..u.len())
        .filter_map(|i| u8::try_from(i).ok())
        .map(ChampionIdx)
        .filter(|c| !without.iter().any(|id| idx(u, id) == *c))
        .collect();
    let mut pairs = Vec::new();
    for (i, a) in all.iter().enumerate() {
        for b in &all[i + 1..] {
            pairs.push(Action::pair(*a, *b));
        }
    }
    pairs
}

/// Task 1, `arrangement`: a pair whose only arrangement moves a locked pick off its listing reports
/// that pick too, `locked`, off-pool, at its grade; the action's two are in-pool.
#[test]
fn the_whole_side_includes_a_locked_pick_the_pair_moves() {
    let r = pair_root();
    let position =
        Position::new(&r.format, &r.entries, &r.pools, &r.u).unwrap_or_else(|e| panic!("{e}"));
    let (l, x, y) = (idx(&r.u, "L"), idx(&r.u, "X"), idx(&r.u, "Y"));
    let mut memo = FeasibilityMemo::new(PRICE);
    let side = arrangement(
        &mut memo,
        Side::Blue,
        &position,
        &r.pools,
        &r.u,
        Action::pair(x, y),
    );
    assert_eq!(
        side,
        vec![
            SidePlacement {
                champion: l,
                role: Role::Top,
                grade: 75,
                in_pool: false,
                locked: true
            },
            SidePlacement {
                champion: x,
                role: Role::Middle,
                grade: 0,
                in_pool: true,
                locked: false
            },
            SidePlacement {
                champion: y,
                role: Role::Adc,
                grade: 0,
                in_pool: true,
                locked: false
            },
        ]
    );
}

/// Task 1: the action's suffix is `placements`, field by field, on every action of the root (the
/// unarrangeable ones are empty in both); and some action really does move the locked pick.
#[test]
fn the_action_suffix_is_placements_on_every_action() {
    let r = pair_root();
    let position =
        Position::new(&r.format, &r.entries, &r.pools, &r.u).unwrap_or_else(|e| panic!("{e}"));
    let (mut moved, mut empty) = (0, 0);
    for action in every_pair(&r.u, &["L", "T2", "J2"]) {
        let mut memo = FeasibilityMemo::new(PRICE);
        let side = arrangement(&mut memo, Side::Blue, &position, &r.pools, &r.u, action);
        let plain = placements(&mut memo, Side::Blue, &position, &r.pools, &r.u, action);
        if side.is_empty() {
            assert!(plain.is_empty(), "{action:?}");
            empty += 1;
            continue;
        }
        assert_eq!(side.len(), 3, "{action:?}");
        assert!(side[0].locked && !side[1].locked && !side[2].locked);
        let suffix: Vec<_> = side[1..]
            .iter()
            .map(|p| (p.champion, p.role, p.grade, p.in_pool))
            .collect();
        let plain: Vec<_> = plain
            .iter()
            .map(|p| (p.champion, p.role, p.grade, p.in_pool))
            .collect();
        assert_eq!(suffix, plain, "{action:?}");
        moved += usize::from(!side[0].in_pool);
    }
    assert!(moved > 0, "no action moved the locked pick");
    assert!(empty > 0, "no action was unarrangeable");
}

/// Task 1: a list-form side and a ban are empty, from both readers.
#[test]
fn a_list_form_side_and_a_ban_arrange_nothing() {
    let r = pair_root();
    let (x, y) = (idx(&r.u, "X"), idx(&r.u, "Y"));
    let list = Pools {
        blue: set(&r.u, &["L", "X", "Y", "T1", "J1", "M1", "A1", "S1"]),
        red: r.pools.red,
        ..Pools::default()
    };
    let position =
        Position::new(&r.format, &r.entries, &list, &r.u).unwrap_or_else(|e| panic!("{e}"));
    let mut memo = FeasibilityMemo::new(PRICE);
    let pair = Action::pair(x, y);
    assert!(arrangement(&mut memo, Side::Blue, &position, &list, &r.u, pair).is_empty());
    assert!(placements(&mut memo, Side::Blue, &position, &list, &r.u, pair).is_empty());
    assert!(open_roles(Side::Blue, &position, &list, &r.u).is_empty());

    let tagged =
        Position::new(&r.format, &r.entries, &r.pools, &r.u).unwrap_or_else(|e| panic!("{e}"));
    let ban = Action::Ban(x);
    assert!(arrangement(&mut memo, Side::Blue, &tagged, &r.pools, &r.u, ban).is_empty());
    assert!(placements(&mut memo, Side::Blue, &tagged, &r.pools, &r.u, ban).is_empty());
}

/// Task 1, `open_roles`: `A` (listed top, plays top or mid) and `B` (listed top, plays top or jungle)
/// are each in-role only at top, so the best arrangements are "A top, B jungle" (mid left open) and
/// "A mid, B top" (jungle left open): both sets come back, each with adc and support still open.
#[test]
fn two_equally_good_arrangements_leave_two_open_sets() {
    let u = universe(&[
        ("A", r#""Top", "Middle""#, "", "0.6, 0, 0.4, 0, 0"),
        ("B", r#""Top", "Jungle""#, "", "0.6, 0.4, 0, 0, 0"),
    ]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["A", "B", "T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u, &["A", "B"], &["T2", "J2"]);
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let got = open_roles(Side::Blue, &position, &pools, &u);
    assert_eq!(
        got,
        vec![
            vec![Role::Jungle, Role::Adc, Role::Support],
            vec![Role::Middle, Role::Adc, Role::Support],
        ]
    );
}

/// Task 1: no picks leaves every role open, as one set.
#[test]
fn a_side_with_no_picks_leaves_all_five_roles_open() {
    let r = pair_root();
    let entries = board(&r.format, &r.u, &[], &[]);
    let position =
        Position::new(&r.format, &entries, &r.pools, &r.u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        open_roles(Side::Blue, &position, &r.pools, &r.u),
        vec![vec![
            Role::Top,
            Role::Jungle,
            Role::Middle,
            Role::Adc,
            Role::Support
        ]]
    );
}

/// Task 1: a single locked pick listed at one role (while it can play another) leaves the other four
/// open, one set: the in-role arrangement beats the off-role one.
#[test]
fn a_listed_pick_leaves_one_set_open() {
    let r = pair_root();
    let position =
        Position::new(&r.format, &r.entries, &r.pools, &r.u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        open_roles(Side::Blue, &position, &r.pools, &r.u),
        vec![vec![Role::Top, Role::Jungle, Role::Adc, Role::Support]]
    );
}

/// Task 1 review, minor 1: `C` and `D` are each listed top and can play top or jungle, so "C top, D
/// jungle" and "C jungle, D top" are equally good (one in-role placement each) and both leave mid, adc
/// and support open. That set comes back once, not twice.
#[test]
fn two_arrangements_leaving_the_same_roles_open_report_the_set_once() {
    let u = universe(&[
        ("C", r#""Top", "Jungle""#, "", "0.6, 0.4, 0, 0, 0"),
        ("D", r#""Top", "Jungle""#, "", "0.6, 0.4, 0, 0, 0"),
    ]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["C", "D", "T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u, &["C", "D"], &["T2", "J2"]);
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        open_roles(Side::Blue, &position, &pools, &u),
        vec![vec![Role::Middle, Role::Adc, Role::Support]]
    );
}

// ---- Task 2: verdicts on the fixture --------------------------------------------------------------
//
// `tests/data/tier-b-review/labelled-position.json` is a copy of a role-map pair root (Blue pair at
// slot 9, Rumble already locked) carrying two verdict entries. `fold-vectors.json` is read here and by
// the Node test of `tier-b:apply`: it states the two folds in the fixture's own spelling.

/// Three options on the labelled position, written as the fixture writes them.
const OPT_A: &str = "Galio+MonkeyKing|top=Rumble,jungle=MonkeyKing,mid=Galio";
const OPT_B: &str = "MonkeyKing+Syndra|top=Rumble,jungle=MonkeyKing,mid=Syndra";
const OPT_C: &str = "Ahri+LeeSin|top=Rumble,jungle=LeeSin,mid=Ahri";

/// The LIVE universe, as `tests/tier_b.rs` builds it.
fn live() -> LiveUniverse {
    #[derive(Deserialize)]
    struct MetaVersion {
        version: String,
    }
    let root = repo_root();
    let fm = FmWeights::from_json_str(
        &std::fs::read_to_string(root.join("data/compiled/fm-weights.json"))
            .expect("fm-weights.json"),
    )
    .expect("fm-weights parses");
    let meta_path = root.join("data/compiled/champion-meta.json");
    let version: MetaVersion = serde_json::from_str(
        &std::fs::read_to_string(&meta_path)
            .unwrap_or_else(|e| panic!("{}: {e}", meta_path.display())),
    )
    .expect("champion-meta version");
    let (_, meta) = load_production_data_from(&meta_path);
    LiveUniverse::build(&fm, &version.version, &meta).unwrap_or_else(|e| panic!("{e}"))
}

fn review_data(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/tier-b-review")
        .join(name);
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn labelled() -> Value {
    review_data("labelled-position.json")
}

fn load(v: &Value, live: &LiveUniverse) -> Result<Loaded, TierBError> {
    TierBFixture::from_json(&v.to_string(), "edited", live)
}

fn loaded(v: &Value, live: &LiveUniverse) -> Loaded {
    load(v, live).unwrap_or_else(|e| panic!("{e}"))
}

/// The field and reason of the `Invalid` error the edited file must raise.
fn invalid(v: &Value, live: &LiveUniverse) -> (String, String) {
    match load(v, live) {
        Err(TierBError::Invalid { field, reason, .. }) => (field, reason),
        other => panic!("expected Invalid, got {other:?}"),
    }
}

/// Renames option `from` to `to` in `labels` of entry `entry`.
fn rename_label(v: &mut Value, entry: usize, from: &str, to: &str) {
    let labels = v["verdicts"][entry]["labels"]
        .as_object_mut()
        .expect("labels is an object");
    let label = labels.remove(from).expect("the option is labelled");
    labels.insert(to.to_string(), label);
}

fn pick_of(live: &LiveUniverse, a: &str, b: &str) -> Action {
    let idx = |id: &str| live.universe.index(id).unwrap_or_else(|| panic!("{id}"));
    Action::pair(idx(a), idx(b))
}

/// The root slot and the mover's locked picks of a loaded fixture.
fn root_and_picks(fx: &TierBFixture, u: &Universe) -> (Slot, Vec<ChampionIdx>) {
    let position = fx.root.position(u).unwrap_or_else(|e| panic!("{e}"));
    let root = position.next_slot().expect("a root");
    (root, position.picks(root.side).to_vec())
}

/// A fold's map as id to label name.
fn label_names(map: &HashMap<OptionKey, Label>, u: &Universe) -> HashMap<String, String> {
    map.iter()
        .map(|(k, l)| (k.id(u), l.name().to_string()))
        .collect()
}

/// An expected map from a vector: id to label name.
fn expected_labels(v: &Value) -> HashMap<String, String> {
    v.as_object()
        .expect("an object of id to label")
        .iter()
        .map(|(k, l)| (k.clone(), l.as_str().expect("a label name").to_string()))
        .collect()
}

/// An expected pick from a vector: key absent = not answered, `null` = no view, a pair = an action.
fn expected_pick(case: &Value, key: &str, live: &LiveUniverse) -> Option<Option<Action>> {
    case.get(key).map(|v| match v {
        Value::Null => None,
        Value::Array(ids) => {
            let id = |i: usize| ids[i].as_str().expect("a champion id");
            Some(pick_of(live, id(0), id(1)))
        }
        other => panic!("{key}: {other}"),
    })
}

/// Every vector of `fold-vectors.json` folds as stated.
/// Kills: first-wins in either fold; the blind fold reading `scored` entries; `null` read as absent;
/// an entry without `would_pick` clearing the pick; `revealed` missing an empty scored entry.
#[test]
fn every_fold_vector_folds_as_stated() {
    let live = live();
    let u = &live.universe;
    let vectors = review_data("fold-vectors.json");
    let cases = vectors.as_array().expect("a list of cases");
    assert!(cases.len() >= 10, "{} vectors", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("a name");
        let mut file = labelled();
        file["verdicts"] = case["entries"].clone();
        let fx = loaded(&file, &live).fixture;
        let got = fx.resolved();
        assert_eq!(
            label_names(&got.blind, u),
            expected_labels(&case["blind"]),
            "{name}: blind"
        );
        assert_eq!(
            label_names(&got.current, u),
            expected_labels(&case["current"]),
            "{name}: current"
        );
        assert_eq!(
            got.blind_pick,
            expected_pick(case, "blind_pick", &live),
            "{name}: blind_pick"
        );
        assert_eq!(
            got.current_pick,
            expected_pick(case, "current_pick", &live),
            "{name}: current_pick"
        );
        assert_eq!(
            got.revealed,
            case["revealed"].as_bool().expect("revealed"),
            "{name}: revealed"
        );
        // `lines` is optional: a case that states it pins the whole resolved list, in order.
        if let Some(expected) = case.get("lines") {
            let got_lines: Vec<(String, String, bool)> = got
                .lines
                .iter()
                .map(|l| (l.option.id(u), l.line.clone(), l.ok))
                .collect();
            let want: Vec<(String, String, bool)> = expected
                .as_array()
                .expect("lines is a list")
                .iter()
                .map(|l| {
                    (
                        l["option"].as_str().expect("option").to_string(),
                        l["line"].as_str().expect("line").to_string(),
                        l["ok"].as_bool().expect("ok"),
                    )
                })
                .collect();
            assert_eq!(got_lines, want, "{name}: lines");
        }
    }
    assert!(
        cases
            .iter()
            .any(|c| c["lines"].as_array().is_some_and(|l| l.len() >= 3)),
        "a vector must pin two lines on one option and a repeat"
    );
}

/// Every case of `refusal-vectors.json` is refused at the labelled position, naming its field: the
/// loader's own errors by `field`, a serde error (a missing field) by its message.
/// Kills: a refusal that loads; one that names the wrong field.
#[test]
fn every_refusal_vector_is_refused_naming_its_field() {
    let live = live();
    let vectors = review_data("refusal-vectors.json");
    let cases = vectors.as_array().expect("a list of cases");
    assert!(cases.len() >= 9, "{} vectors", cases.len());
    for case in cases {
        let name = case["name"].as_str().expect("a name");
        let field = case["field"].as_str().expect("a field");
        let mut file = labelled();
        file["verdicts"] = case["entries"].clone();
        match load(&file, &live) {
            Err(TierBError::Invalid { field: got, .. }) => assert_eq!(got, field, "{name}"),
            Err(TierBError::Json { source, .. }) => {
                let message = source.to_string();
                assert!(
                    message.contains(field),
                    "{name}: {message:?} does not name {field:?}"
                );
            }
            other => panic!("{name}: expected a refusal, got {other:?}"),
        }
    }
}

/// The serde names and the hand-written `name()` are one spelling.
/// Kills: a renamed variant in one place only.
#[test]
fn the_serde_names_and_the_hand_written_names_agree() {
    for name in Label::NAMES {
        let label: Label = serde_json::from_value(json!(name)).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(label.name(), name);
        assert_eq!(Label::from_name(name), Some(label));
    }
    for name in VerdictMode::NAMES {
        let mode: VerdictMode =
            serde_json::from_value(json!(name)).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(mode.name(), name);
        assert_eq!(VerdictMode::from_name(name), Some(mode));
    }
    assert_eq!(Label::NAMES.len(), 3);
    assert_eq!(VerdictMode::NAMES.len(), 2);
}

/// Kills: a loader that drops `verdicts`; a fold over the wrong entries; the line verdict lost.
#[test]
fn the_labelled_position_loads_and_folds() {
    let live = live();
    let u = &live.universe;
    let Loaded {
        fixture, warnings, ..
    } = loaded(&labelled(), &live);
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(fixture.verdicts.len(), 2);
    assert_eq!(fixture.verdicts[0].mode, VerdictMode::Blind);
    assert_eq!(fixture.verdicts[1].mode, VerdictMode::Scored);
    assert_eq!(fixture.verdicts[0].from.rev, 17);
    assert_eq!(
        fixture.verdicts[0].note.as_deref(),
        Some("Syndra mid is not this team.")
    );
    let got = fixture.resolved();
    let names = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, l)| (k.to_string(), l.to_string()))
            .collect()
    };
    assert_eq!(
        label_names(&got.blind, u),
        names(&[(OPT_A, "play"), (OPT_B, "never")])
    );
    assert_eq!(
        label_names(&got.current, u),
        names(&[(OPT_A, "play"), (OPT_B, "maybe"), (OPT_C, "play")])
    );
    assert_eq!(
        got.blind_pick,
        Some(Some(pick_of(&live, "MonkeyKing", "Galio")))
    );
    assert_eq!(got.current_pick, got.blind_pick);
    assert!(got.revealed);
    assert_eq!(got.lines.len(), 1);
    assert_eq!(got.lines[0].option.id(u), OPT_A);
    assert_eq!(got.lines[0].line, "Zyra");
    assert!(!got.lines[0].ok);
}

/// Kills: a line fold that keeps the first write, or keeps both.
#[test]
fn a_line_verdict_is_the_last_write_for_its_option_and_line() {
    let live = live();
    let mut file = labelled();
    let mut third = file["verdicts"][1].clone();
    third["from"]["rev"] = json!(32);
    third["started"] = json!("2026-11-09T14:40:00Z");
    third["finished"] = json!("2026-11-09T14:41:00Z");
    third["labels"] = json!({});
    third["line"] = json!({ "option": OPT_A, "line": "Zyra", "ok": true });
    file["verdicts"]
        .as_array_mut()
        .expect("verdicts")
        .push(third);
    let got = loaded(&file, &live).fixture.resolved();
    assert_eq!(got.lines.len(), 1);
    assert!(got.lines[0].ok);
}

/// Kills: `verdict`, `role_verdict` and `review` read differently when `verdicts` is present.
#[test]
fn verdict_role_verdict_and_review_load_unchanged_beside_verdicts() {
    let live = live();
    let with = loaded(&labelled(), &live).fixture;
    let mut bare = labelled();
    bare.as_object_mut().expect("an object").remove("verdicts");
    let without = loaded(&bare, &live).fixture;
    assert!(without.verdicts.is_empty());
    assert_eq!(with.verdict, without.verdict);
    assert_eq!(with.verdict.map(|v| v.off_pool), Some(false));
    assert_eq!(with.role_verdict, without.role_verdict);
    assert!(with.role_verdict.is_some());
    assert_eq!(with.review, without.review);
    assert_eq!(with.actual_next, without.actual_next);
}

/// Kills: an id that does not round-trip; an unsorted pair accepted; a comp demanded where the id
/// gives the action alone; a comp that forgets the locked pick.
#[test]
fn an_option_id_round_trips_and_has_one_spelling() {
    let live = live();
    let u = &live.universe;
    let fx = loaded(&labelled(), &live).fixture;
    let (root, picks) = root_and_picks(&fx, u);
    assert_eq!(picks.len(), 1);
    let parse = |id: &str| OptionKey::parse(id, root, &picks, u);
    for id in [
        OPT_A,
        OPT_B,
        OPT_C,
        "Ezreal+Renata|top=Rumble,adc=Ezreal,support=Renata",
    ] {
        let key = parse(id).unwrap_or_else(|e| panic!("{id}: {e}"));
        assert_eq!(key.id(u), id);
        assert!(key.comp.is_some());
    }
    // The comp is in ROLES order.
    let key = parse(OPT_A).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(key.comp.expect("a comp")[0], u.index("Rumble"));

    // No comp gives the action alone, even with a locked pick on the board.
    let alone = parse("Galio+MonkeyKing").unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(alone.comp, None);
    assert_eq!(alone.id(u), "Galio+MonkeyKing");
    assert_eq!(alone.action, pick_of(&live, "Galio", "MonkeyKing"));

    // A pair spelled out of order is refused, not normalised.
    let reason = match parse("MonkeyKing+Galio|top=Rumble,jungle=MonkeyKing,mid=Galio") {
        Err(SpecError::Invalid { reason, .. }) => reason,
        other => panic!("{other:?}"),
    };
    assert!(reason.contains("not sorted"), "{reason}");
    // The same without a comp.
    assert!(matches!(
        parse("MonkeyKing+Galio"),
        Err(SpecError::Invalid { .. })
    ));
    // The locked pick must be in the comp.
    let reason = match parse("Galio+MonkeyKing|jungle=MonkeyKing,mid=Galio") {
        Err(SpecError::Invalid { reason, .. }) => reason,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        reason,
        "the comp is missing Rumble, a pick the side has already locked"
    );
}

/// Kills: a mid-pair root whose comp need not hold the first pick.
#[test]
fn a_mid_pair_roots_comp_holds_the_first_pick() {
    let live = live();
    let u = &live.universe;
    let mut file = labelled();
    for key in ["actual_next", "role_verdict", "verdicts"] {
        file.as_object_mut().expect("an object").remove(key);
    }
    file["position"]
        .as_array_mut()
        .expect("position")
        .push(json!({ "slot": 9, "side": "Blue", "kind": "pick", "champion": "Syndra" }));
    let fx = loaded(&file, &live).fixture;
    let (root, picks) = root_and_picks(&fx, u);
    assert!(!root.pair_start && root.pair_end);
    assert_eq!(picks.len(), 2);
    let parse = |id: &str| OptionKey::parse(id, root, &picks, u);
    let key = parse("LeeSin|top=Rumble,jungle=LeeSin,mid=Syndra").unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(key.action, Action::Pick(idx(u, "LeeSin")));
    assert_eq!(key.id(u), "LeeSin|top=Rumble,jungle=LeeSin,mid=Syndra");
    let reason = match parse("LeeSin|top=Rumble,jungle=LeeSin") {
        Err(SpecError::Invalid { reason, .. }) => reason,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        reason,
        "the comp is missing Syndra, a pick the side has already locked"
    );
    // A pair is not a single pick's spelling here.
    assert!(parse("Galio+LeeSin").is_err());
}

/// Each authoring mistake is named by its field.
/// Kills: a mistake that loads; a mistake reported under the wrong field or without one.
#[test]
fn the_loader_names_every_verdict_mistake() {
    let live = live();
    let check = |edit: &dyn Fn(&mut Value), field: &str, reason_has: &str| {
        let mut file = labelled();
        edit(&mut file);
        let (got_field, reason) = invalid(&file, &live);
        assert_eq!(got_field, field, "{reason}");
        assert!(
            reason.contains(reason_has),
            "{field}: {reason:?} lacks {reason_has:?}"
        );
    };
    let label_field = |entry: usize, id: &str| format!("verdicts[{entry}].labels[{id}]");

    check(
        &|v| v["verdicts"][0]["labels"][OPT_A] = json!("maybee"),
        &label_field(0, OPT_A),
        "unknown label \"maybee\"; the labels are play, maybe, never",
    );
    check(
        &|v| v["verdicts"][1]["mode"] = json!("revealed"),
        "verdicts[1].mode",
        "unknown mode \"revealed\"; the modes are blind, scored",
    );
    check(
        &|v| v["verdicts"][0]["started"] = json!("2026-11-09 14:10:05"),
        "verdicts[0].started",
        "not an ISO-8601 UTC timestamp",
    );
    check(
        &|v| v["verdicts"][1]["finished"] = json!("2026-11-09T14:33:18+01:00"),
        "verdicts[1].finished",
        "not an ISO-8601 UTC timestamp",
    );
    check(
        &|v| v["verdicts"][0]["started"] = json!("2026-02-30T14:10:05Z"),
        "verdicts[0].started",
        "not an ISO-8601 UTC timestamp",
    );
    check(
        &|v| v["verdicts"][0]["finished"] = json!("2026-11-09T24:00:00Z"),
        "verdicts[0].finished",
        "not an ISO-8601 UTC timestamp",
    );
    let no_top = "Galio+MonkeyKing|jungle=MonkeyKing,mid=Galio";
    check(
        &|v| rename_label(v, 0, OPT_A, no_top),
        &label_field(0, no_top),
        "the comp is missing Rumble, a pick the side has already locked",
    );
    let extra = "Galio+MonkeyKing|top=Rumble,jungle=MonkeyKing,mid=Galio,adc=Ezreal";
    check(
        &|v| rename_label(v, 0, OPT_A, extra),
        &label_field(0, extra),
        "the comp has Ezreal, who is neither a locked pick nor in the action",
    );
    let no_action_champion = "Galio+MonkeyKing|top=Rumble,mid=Galio";
    check(
        &|v| rename_label(v, 0, OPT_A, no_action_champion),
        &label_field(0, no_action_champion),
        "the comp is missing MonkeyKing, a champion of the action",
    );
    let bad_role = "Galio+MonkeyKing|top=Rumble,jgl=MonkeyKing,mid=Galio";
    check(
        &|v| rename_label(v, 0, OPT_A, bad_role),
        &label_field(0, bad_role),
        "unknown role key \"jgl\"; the keys are top, jungle, mid, adc, support",
    );
    let out_of_order = "Galio+MonkeyKing|top=Rumble,mid=Galio,jungle=MonkeyKing";
    check(
        &|v| rename_label(v, 0, OPT_A, out_of_order),
        &label_field(0, out_of_order),
        "\"jungle\" is out of place",
    );
    let twice = "Galio+MonkeyKing|top=Rumble,jungle=MonkeyKing,mid=MonkeyKing";
    check(
        &|v| rename_label(v, 0, OPT_A, twice),
        &label_field(0, twice),
        "the comp lists MonkeyKing twice",
    );
    let three = "Ahri+Galio+MonkeyKing";
    check(
        &|v| rename_label(v, 0, OPT_A, three),
        &label_field(0, three),
        "not one champion or two joined by '+'",
    );
    let unknown = "Galio+Nobody";
    check(
        &|v| rename_label(v, 0, OPT_A, unknown),
        &label_field(0, unknown),
        "unknown champion \"Nobody\"",
    );
    let single = "Galio";
    check(
        &|v| rename_label(v, 0, OPT_A, single),
        &label_field(0, single),
        "the root is a pair turn",
    );
    let unsorted = "MonkeyKing+Galio";
    check(
        &|v| rename_label(v, 0, OPT_A, unsorted),
        &label_field(0, unsorted),
        "not sorted by id",
    );
    // The action cannot re-pick a locked champion (mover's picks plus the action, each once).
    let repick = "Galio+Rumble|top=Rumble,mid=Galio";
    check(
        &|v| rename_label(v, 0, OPT_A, repick),
        &label_field(0, repick),
        "Rumble is already one of the side's locked picks",
    );
    let repick_alone = "Galio+Rumble";
    check(
        &|v| rename_label(v, 0, OPT_A, repick_alone),
        &label_field(0, repick_alone),
        "Rumble is already one of the side's locked picks",
    );
    // The line is shown only at reveal.
    check(
        &|v| v["verdicts"][0]["line"] = json!({ "option": OPT_A, "line": "Zyra", "ok": true }),
        "verdicts[0].line",
        "a line verdict in a blind entry",
    );
    check(
        &|v| v["verdicts"][1]["line"]["line"] = json!([["Zyra"]]),
        "verdicts[1].line.line",
        "must be a string",
    );
    check(
        &|v| v["verdicts"][0]["positions_patch"] = Value::Null,
        "verdicts[0].positions_patch",
        "must be a string",
    );
    let empty_comp = "Galio+MonkeyKing|";
    check(
        &|v| rename_label(v, 0, OPT_A, empty_comp),
        &label_field(0, empty_comp),
        "an empty comp",
    );
    check(
        &|v| v["verdicts"][1]["line"]["option"] = json!("Galio+Nobody"),
        "verdicts[1].line.option",
        "unknown champion \"Nobody\"",
    );
    check(
        &|v| v["verdicts"][1]["line"]["option"] = json!("MonkeyKing+Galio"),
        "verdicts[1].line.option",
        "not sorted by id",
    );
    check(
        &|v| v["verdicts"][0]["would_pick"] = json!(["Galio", "Nobody"]),
        "verdicts[0].would_pick",
        "unknown champion \"Nobody\"",
    );
    check(
        &|v| v["verdicts"][0]["would_pick"] = json!("Galio"),
        "verdicts[0].would_pick",
        "the root is a pair turn",
    );
    // Blind means the draft had never been revealed.
    check(
        &|v| {
            let entries = v["verdicts"].as_array_mut().expect("verdicts");
            entries.swap(0, 1);
        },
        "verdicts[1].mode",
        "a blind entry after a scored one",
    );

    // Unknown fields, anywhere in an entry, and a missing required field, are serde's.
    let json_error = |edit: &dyn Fn(&mut Value)| {
        let mut file = labelled();
        edit(&mut file);
        assert!(
            matches!(load(&file, &live), Err(TierBError::Json { .. })),
            "{file}"
        );
    };
    json_error(&|v| v["verdicts"][0]["extra"] = json!(1));
    json_error(&|v| v["verdicts"][0]["from"]["extra"] = json!(1));
    json_error(&|v| v["verdicts"][1]["line"]["extra"] = json!(1));
    json_error(&|v| {
        v["verdicts"][0]
            .as_object_mut()
            .expect("an entry")
            .remove("from");
    });
    json_error(&|v| v["verdicts"][0]["from"]["rev"] = json!(-1));
}

/// Both timestamp spellings the page can produce load; a leap day loads.
/// Kills: a timestamp check stricter than the page's `toISOString`.
#[test]
fn a_timestamp_may_carry_a_fraction() {
    let live = live();
    let mut file = labelled();
    file["verdicts"][0]["started"] = json!("2026-11-09T14:10:05.123Z");
    file["verdicts"][0]["finished"] = json!("2028-02-29T23:59:59Z");
    let _ = loaded(&file, &live);
}

/// An illegal own pick is a warning, as `actual_next` is, and is still recorded.
/// Kills: an illegal pick refused; an illegal pick silently accepted.
#[test]
fn an_illegal_would_pick_is_a_warning() {
    let live = live();
    let mut file = labelled();
    // Zilean was banned at slot 0.
    file["verdicts"][0]["would_pick"] = json!(["Zilean", "Ahri"]);
    let Loaded {
        fixture, warnings, ..
    } = loaded(&file, &live);
    assert_eq!(
        warnings,
        ["labelled-position: verdicts[0].would_pick Ahri+Zilean is not a legal action here (already on the board)"]
    );
    assert_eq!(
        fixture.resolved().blind_pick,
        Some(Some(pick_of(&live, "Zilean", "Ahri")))
    );
}

/// `null` is an answer, and it is not a warning.
#[test]
fn a_null_would_pick_is_no_view_and_warns_nothing() {
    let live = live();
    let mut file = labelled();
    file["verdicts"][0]["would_pick"] = Value::Null;
    let Loaded {
        fixture, warnings, ..
    } = loaded(&file, &live);
    assert!(warnings.is_empty(), "{warnings:?}");
    assert_eq!(fixture.resolved().blind_pick, Some(None));
}

/// At a ban root `verdicts` is a warning and is not read, so even an id that could not parse there
/// is no error. Kills: a ban root that reads, or refuses, the entries.
#[test]
fn verdicts_at_a_ban_root_are_warned_and_not_read() {
    let live = live();
    let mut file = labelled();
    let object = file.as_object_mut().expect("an object");
    for key in ["actual_next", "role_verdict", "verdict"] {
        object.remove(key);
    }
    file["position"] = json!([{ "slot": 0, "side": "Blue", "kind": "ban", "champion": "Zilean" }]);
    let Loaded {
        fixture, warnings, ..
    } = loaded(&file, &live);
    assert_eq!(
        warnings,
        ["labelled-position: verdicts: no options to judge at a ban root; not read"]
    );
    assert!(fixture.verdicts.is_empty());
    let got = fixture.resolved();
    assert!(got.current.is_empty() && !got.revealed);
}

// ---- Task 3: the runner ---------------------------------------------------------------------------
//
// A small config on the labelled position (Blue pair at slot 9): two P, two Q, k 3, horizon 2, narrow
// widths. At those widths the position has off-pool options of both classes, lines, and ranks that
// move with the price, so each assertion below reads something that varies.

fn review_config() -> ReviewConfig {
    ReviewConfig {
        ps: vec![0.02, 0.1],
        qs: vec![0.0, 0.05],
        shortlist: Shortlist {
            singles: 20,
            pairs: 40,
            root_off_pool: 60,
        },
        horizon: 2,
        k: 3,
        margin: 0.01,
        jobs: 4,
        depth_check: false,
        node_budget: 20_000_000,
        run_id: "2026-11-09T00:00:00Z".to_string(),
        engine: EngineStamp {
            name: "reference".to_string(),
            commit: Some("test".to_string()),
            dirty: Some(false),
        },
        positions_patch: "16.19".to_string(),
        playable_rule: None,
        holdout_open: false,
    }
}

const REFERENCE_ARM: &str = "roster:0.1:0.05";

/// The run on `files` (each loaded as a position) as a `Value`, `seconds` and `search.jobs` removed.
fn run_value(files: &[Value], cfg: &ReviewConfig, live: &LiveUniverse) -> Value {
    normalised(&run_of(files, cfg, live))
}

fn run_of(files: &[Value], cfg: &ReviewConfig, live: &LiveUniverse) -> ReviewRun {
    let corpus: Vec<Result<Loaded, TierBError>> = files.iter().map(|f| load(f, live)).collect();
    run_review(&corpus, live, cfg)
}

fn normalised(run: &ReviewRun) -> Value {
    let mut v = serde_json::to_value(run).expect("the run serialises");
    v["run"]["search"]
        .as_object_mut()
        .expect("run.search")
        .remove("jobs");
    for position in v["positions"].as_array_mut().expect("positions") {
        for reading in position["readings"].as_array_mut().expect("readings") {
            reading
                .as_object_mut()
                .expect("a reading")
                .remove("seconds");
        }
    }
    v
}

/// The labelled position's run under `review_config`, computed once for the tests that read it.
fn base_run() -> &'static Value {
    static BASE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    BASE.get_or_init(|| run_value(&[labelled()], &review_config(), &live()))
}

fn array<'a>(v: &'a Value, what: &str) -> &'a Vec<Value> {
    v.as_array().unwrap_or_else(|| panic!("{what} is a list"))
}

fn text<'a>(v: &'a Value, what: &str) -> &'a str {
    v.as_str().unwrap_or_else(|| panic!("{what} is a string"))
}

fn number(v: &Value, what: &str) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("{what} is a number"))
}

fn readings(position: &Value) -> &Vec<Value> {
    array(&position["readings"], "readings")
}

fn reading<'a>(position: &'a Value, arm: &str) -> &'a Value {
    readings(position)
        .iter()
        .find(|r| r["arm"] == arm)
        .unwrap_or_else(|| panic!("no reading for {arm}"))
}

fn ranked(reading: &Value) -> &Vec<Value> {
    array(&reading["ranked"], "ranked")
}

fn is_roster(reading: &Value) -> bool {
    reading["arm"] != "pool_or_roster"
}

/// A real slot-19 fixture (read-only copy of `fixtures/tier-b/2026-09-29-top-pinch-slot-19-kittens`),
/// in its own subdirectory so the labelled position's tests are unaffected. Under `review_config` its
/// `pool_or_roster` top 3 holds options no roster arm puts in its top K.
fn por_only_fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/tier-b-review/por-only/2026-09-29-top-pinch-slot-19-kittens.json");
    serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// An option that only `pool_or_roster` puts in its top K is not a row, and its `reach` is not within K.
/// The reach's exact value (a number or null) is for the user to settle; only "not <= K" is asserted.
/// Kills: rows counted from every arm, `pool_or_roster` included (460 rows instead of 404 on the corpus).
#[test]
fn an_option_only_pool_or_roster_puts_in_its_top_k_is_not_a_row() {
    let live = live();
    let k = 3;
    let run = run_value(&[por_only_fixture()], &review_config(), &live);
    let p = &run["positions"][0];
    let roster_top: Vec<&Value> = readings(p)
        .iter()
        .filter(|r| is_roster(r))
        .flat_map(|r| ranked(r).iter().filter(|x| x["rank"].as_u64() <= Some(k)))
        .map(|x| &x["option"])
        .collect();
    let por_only: Vec<&str> = ranked(reading(p, "pool_or_roster"))
        .iter()
        .filter(|x| x["rank"].as_u64() <= Some(k))
        .map(|x| text(&x["option"], "option"))
        .filter(|id| !roster_top.iter().any(|o| *o == *id))
        .collect();
    assert!(
        !por_only.is_empty(),
        "this fixture has por-only top-K options"
    );
    for id in por_only {
        let o = &p["options"][id];
        assert_eq!(o["row"], false, "{id}");
        assert_eq!(o["margin"], false, "{id}");
        assert!(
            o["reach"].as_u64() > Some(k),
            "{id}: reach is a number above K, not null: {}",
            o["reach"]
        );
    }
}

/// 1 job and 4 jobs give the same JSON once `seconds` and `search.jobs` are out.
/// Kills: results merged in completion order (also asserted without timing luck by the unit test of
/// `parallel_map` in the module).
#[test]
fn one_job_equals_four_jobs() {
    let live = live();
    let one = ReviewConfig {
        jobs: 1,
        ..review_config()
    };
    // A fast position (slot 19, milliseconds) after the slow one: with 4 workers the fast searches
    // finish while the slow ones started before them are still running.
    let files = [labelled(), por_only_fixture()];
    let run = run_of(&files, &one, &live);
    // The job count is in the part that is allowed to differ.
    assert_eq!(run.run.search.jobs, 1);
    assert_eq!(normalised(&run), run_value(&files, &review_config(), &live));
}

/// Every id referenced anywhere is in `options`; a `row` is exactly `reach` at most K or in a roster
/// arm's margin set at 3, with `reach` the best rank over the roster arms; the ranked list is in rank
/// order. Recomputed here from the readings. Kills: a dangling reference; a row decided by K alone, or
/// by the margin alone; `reach` read from `pool_or_roster`.
#[test]
fn the_catalog_holds_every_reference_and_a_row_is_reach_or_margin() {
    let run = base_run();
    let p = &run["positions"][0];
    assert_eq!(p["mover"], "Blue");
    let options = p["options"].as_object().expect("options");
    let (k, margin) = (3, 0.01);
    assert_eq!(run["run"]["k"], k);

    let mut referenced: Vec<&str> = readings(p)
        .iter()
        .flat_map(|r| {
            let best = r["best_in_pool"]["option"].as_str();
            best.into_iter()
                .chain(ranked(r).iter().map(|x| text(&x["option"], "option")))
        })
        .collect();
    referenced.extend(
        p["labels"]
            .as_object()
            .expect("labels")
            .keys()
            .map(String::as_str),
    );
    assert!(referenced.len() > 30, "{} references", referenced.len());
    for id in referenced {
        assert!(
            options.contains_key(id),
            "{id} is referenced but not an option"
        );
    }

    let mut reach: HashMap<&str, usize> = HashMap::new();
    let mut margin_set: Vec<&str> = Vec::new();
    for r in readings(p).iter().filter(|r| is_roster(r)) {
        let list = ranked(r);
        let ranks: Vec<u64> = list
            .iter()
            .map(|x| x["rank"].as_u64().expect("a rank"))
            .collect();
        assert!(ranks.windows(2).all(|w| w[0] <= w[1]), "{ranks:?}");
        for x in list {
            let rank = usize::try_from(x["rank"].as_u64().expect("rank")).expect("small");
            reach
                .entry(text(&x["option"], "option"))
                .and_modify(|best| *best = (*best).min(rank))
                .or_insert(rank);
        }
        // The Blue mover maximises: within `margin` below #3's value, or above it.
        let third = number(&list[2]["value"], "the third value");
        for x in list {
            if number(&x["value"], "value") >= third - margin {
                margin_set.push(text(&x["option"], "option"));
            }
        }
    }
    let (mut only_margin, mut not_row) = (0, 0);
    for (id, o) in options {
        let want_reach = reach.get(id.as_str()).copied();
        let got_reach = o["reach"]
            .as_u64()
            .map(|r| usize::try_from(r).expect("small"));
        assert_eq!(got_reach, want_reach, "{id}: reach");
        let want_row = want_reach.is_some_and(|r| r <= k) || margin_set.contains(&id.as_str());
        assert_eq!(o["row"], want_row, "{id}: row");
        let want_margin = margin_set.contains(&id.as_str());
        assert_eq!(o["margin"], want_margin, "{id}: margin");
        // The contract's identity: a row is reach within K or in a margin set.
        let by_fields = o["reach"].as_u64().is_some_and(|r| r <= 3) || o["margin"] == true;
        assert_eq!(o["row"], by_fields, "{id}: row == (reach <= K || margin)");
        only_margin += usize::from(want_row && want_reach.is_some_and(|r| r > k));
        not_row += usize::from(!want_row);
    }
    assert!(only_margin >= 1, "a row the margin set alone brings in");
    assert!(not_row >= 2, "options that are there for reference only");
}

/// A labelled option outside every top K is in the catalog with its true rank at each arm, the same
/// rank a run that seeds every ranked option reads. Kills: a label not seeded; a rank counted over the
/// catalog instead of the whole list.
#[test]
fn a_labelled_option_outside_every_top_k_has_its_true_rank_at_each_arm() {
    let live = live();
    let p = &base_run()["positions"][0];
    let wide = run_value(
        &[labelled()],
        &ReviewConfig {
            k: 1000,
            ..review_config()
        },
        &live,
    );
    let w = &wide["positions"][0];
    for id in [OPT_A, OPT_C] {
        assert!(p["options"].get(id).is_some(), "{id}");
        for r in readings(p) {
            let arm = text(&r["arm"], "arm");
            let here = ranked(r)
                .iter()
                .find(|x| x["option"] == id)
                .unwrap_or_else(|| panic!("{id} unranked at {arm}"));
            let there = ranked(reading(w, arm))
                .iter()
                .find(|x| x["option"] == id)
                .unwrap_or_else(|| panic!("{id} unranked at {arm} in the wide run"));
            assert_eq!(here["rank"], there["rank"], "{id} at {arm}");
            assert!(here["rank"].as_u64().expect("rank") > 3, "{id} at {arm}");
        }
    }
    // Every catalog option's rank, at every arm, is the one the wide run reads.
    for r in readings(p) {
        let arm = text(&r["arm"], "arm");
        for x in ranked(r) {
            let there = ranked(reading(w, arm))
                .iter()
                .find(|y| y["option"] == x["option"])
                .expect("the wide run ranks it too");
            assert_eq!(x["rank"], there["rank"], "{} at {arm}", x["option"]);
        }
    }
}

/// The blind own pick, where it differs from the current one, and the current one are in the catalog
/// though neither is near any top K; the base run, which has no such picks, lacks them. Kills: own
/// picks not seeded; only the current pick seeded.
#[test]
fn both_own_picks_are_in_the_catalog() {
    let live = live();
    let mut file = labelled();
    file["verdicts"][0]["would_pick"] = json!(["Bard", "Ziggs"]);
    file["verdicts"][1]["would_pick"] = json!(["Nami", "Yunara"]);
    let run = run_value(&[file], &review_config(), &live);
    let p = &run["positions"][0];
    assert_eq!(p["would_pick"]["blind"], json!(["Bard", "Ziggs"]));
    assert_eq!(p["would_pick"]["current"], json!(["Nami", "Yunara"]));
    let base = &base_run()["positions"][0];
    for pick in [json!(["Bard", "Ziggs"]), json!(["Nami", "Yunara"])] {
        let ids_of = |position: &Value| -> Vec<String> {
            position["options"]
                .as_object()
                .expect("options")
                .iter()
                .filter(|(_, o)| o["action"] == pick)
                .map(|(id, _)| id.clone())
                .collect()
        };
        let got = ids_of(p);
        assert_eq!(got.len(), 1, "{pick}: {got:?}");
        assert!(
            ids_of(base).is_empty(),
            "{pick} is in the base run's catalog"
        );
        for r in readings(p).iter().filter(|r| is_roster(r)) {
            let x = ranked(r)
                .iter()
                .find(|x| x["option"] == got[0].as_str())
                .unwrap_or_else(|| panic!("{pick} unranked at {}", r["arm"]));
            assert!(
                x["rank"].as_u64().expect("rank") > 3,
                "{pick}: not a top-K option"
            );
        }
    }
}

/// A label whose comp differs from the arm's arrangement does not match: the label stays on its own
/// id, which is in the catalog as written with no rank and no row, and the arm's option reads
/// unlabelled. The comp is the arm's with the action's two champions swapped. Kills: a label matched
/// on the action alone.
#[test]
fn a_label_whose_comp_differs_from_the_arrangement_does_not_match() {
    let live = live();
    let swapped = "Galio+MonkeyKing|top=Rumble,jungle=Galio,mid=MonkeyKing";
    let mut file = labelled();
    rename_label(&mut file, 0, OPT_A, swapped);
    let run = run_value(&[file], &review_config(), &live);
    let p = &run["positions"][0];
    // The arm's option is there, ranked, and unlabelled.
    assert!(p["options"].get(OPT_A).is_some());
    assert!(p["labels"].get(OPT_A).is_none(), "{}", p["labels"]);
    assert_eq!(p["labels"][swapped]["blind"], "play");
    for r in readings(p) {
        assert!(ranked(r).iter().any(|x| x["option"] == OPT_A));
        assert!(ranked(r).iter().all(|x| x["option"] != swapped));
    }
    // The label's own id: in the catalog as written, never ranked, never a row.
    let orphan = &p["options"][swapped];
    assert_eq!(orphan["action"], json!(["Galio", "MonkeyKing"]));
    assert_eq!(
        orphan["comp"],
        json!({"top": "Rumble", "jungle": "Galio", "mid": "MonkeyKing"})
    );
    assert!(orphan["reach"].is_null());
    assert_eq!(orphan["row"], false);
    let side: Vec<(&str, &str, bool)> = array(&orphan["side"], "side")
        .iter()
        .map(|s| {
            (
                text(&s["champion"], "champion"),
                text(&s["role"], "role"),
                s["locked"].as_bool().expect("locked"),
            )
        })
        .collect();
    assert_eq!(
        side,
        [
            ("Rumble", "top", true),
            ("Galio", "jungle", false),
            ("MonkeyKing", "mid", false)
        ]
    );
}

/// The class, the gains, the best in-pool and the side of every ranked option, recomputed from the
/// readings and `options`. Kills: a class rule other than `tests/tier_b.rs`'s; a gain over the wrong
/// base; a best in-pool that is not the first in-pool in rank order.
#[test]
fn class_gains_and_best_in_pool_read_as_the_report_reads_them() {
    let p = &base_run()["positions"][0];
    let options = p["options"].as_object().expect("options");
    let mut classes: Vec<&str> = Vec::new();
    for r in readings(p) {
        let list = ranked(r);
        let best = &r["best_in_pool"];
        assert!(
            best["option"].is_string(),
            "{}: an in-pool option is ranked",
            r["arm"]
        );
        let best_value = number(&best["value"], "best value");
        let bip = list
            .iter()
            .find(|x| x["option"] == best["option"])
            .expect("the best in-pool is ranked");
        assert_eq!(bip["rank"], best["rank"]);
        assert_eq!(bip["value"], best["value"]);
        assert_eq!(bip["class"], "in-pool");
        assert_eq!(bip["gain_logit"], 0.0);
        assert_eq!(bip["gain_pp"], 0.0);
        for x in list {
            let class = text(&x["class"], "class");
            classes.push(class);
            let side = array(&options[text(&x["option"], "option")]["side"], "side");
            let off_placed_with_grade = side.iter().any(|s| {
                s["locked"] == false && s["in_pool"] == false && s["grade"].as_u64() > Some(0)
            });
            let want = if x["d_off"] == 0 {
                "in-pool"
            } else if x["d_grade"] != 0 || off_placed_with_grade {
                "off-pool graded"
            } else {
                "off-pool base"
            };
            assert_eq!(class, want, "{} at {}", x["option"], r["arm"]);
            // The best in-pool option is the first in-pool one in the list.
            if class == "in-pool" {
                assert!(x["rank"].as_u64() >= best["rank"].as_u64());
            }
            let value = number(&x["value"], "value");
            let gain = number(&x["gain_logit"], "gain");
            assert!(
                (gain - (value - best_value)).abs() < 1e-12,
                "Blue's gain is the plain difference"
            );
            let pp = number(&x["gain_pp"], "gain_pp");
            assert_eq!(pp > 0.0, gain > 0.0, "{}", x["option"]);
            assert!(pp.abs() < 100.0);
            let win = number(&x["mover_win_pct"], "win");
            assert!((0.0..=100.0).contains(&win), "{win}");
        }
    }
    assert!(classes.contains(&"in-pool"));
    assert!(classes.contains(&"off-pool base"), "{classes:?}");
    assert!(classes.contains(&"off-pool graded"), "{classes:?}");
}

/// `line_side` is each continuation action's placements, read at the position that action is played
/// from, for the side whose turn it is there: re-derived here by replaying the root action. At this
/// root the line is Red's reply, so the placements are Red's, not the mover's. Kills: the mover's side
/// used throughout; the continuation read at the root position.
#[test]
fn line_side_reads_each_continuation_action_on_the_side_that_plays_it() {
    let live = live();
    let u = &live.universe;
    let fx = loaded(&labelled(), &live).fixture;
    let position = fx.root.position(u).expect("position");
    let (root, picks) = root_and_picks(&fx, u);
    let p = &base_run()["positions"][0];
    let r = reading(p, REFERENCE_ARM);
    let mut checked = 0;
    for x in ranked(r) {
        let key = OptionKey::parse(text(&x["option"], "option"), root, &picks, u)
            .unwrap_or_else(|e| panic!("{e}"));
        let mut replay = position.apply(key.action);
        let mut memo = FeasibilityMemo::new(Price::of(0.1, 0.05));
        let mut want: Vec<(String, &str)> = Vec::new();
        for step in array(&x["line"], "line") {
            let ids: Vec<ChampionIdx> = array(step, "step")
                .iter()
                .map(|id| idx(u, text(id, "id")))
                .collect();
            let action = match ids.as_slice() {
                [a] => Action::Pick(*a),
                [a, b] => Action::pair(*a, *b),
                other => panic!("{other:?}"),
            };
            let side = replay.next_slot().expect("a slot").side;
            assert_eq!(side, Side::Red, "the reply is Red's");
            for pl in placements(&mut memo, side, &replay, &fx.root.pools, u, action) {
                want.push((
                    u.id(pl.champion).to_string(),
                    engine_core::reference::entries::role_key(pl.role),
                ));
            }
            replay = replay.apply(action);
        }
        let got: Vec<(String, &str)> = array(&x["line_side"], "line_side")
            .iter()
            .map(|s| (text(&s["champion"], "c").to_string(), text(&s["role"], "r")))
            .collect();
        assert_eq!(got, want, "{}", x["option"]);
        checked += usize::from(!want.is_empty());
    }
    assert!(checked >= 5, "{checked} lines with placements");
}

/// A Red mover's gains are mover-signed: a lower value is a gain, the best in-pool option's own gain is
/// `0.0` and never `-0.0`, and the win is Red's. A pair root at slot 7, horizon 1.
/// Kills: Blue's sign for every mover; `-0.0` on the base.
#[test]
fn a_red_movers_gains_are_mover_signed() {
    let live = live();
    let mut file = labelled();
    {
        let object = file.as_object_mut().expect("an object");
        for key in [
            "actual_next",
            "role_verdict",
            "verdict",
            "verdicts",
            "our_side",
        ] {
            object.remove(key);
        }
    }
    file["position"]
        .as_array_mut()
        .expect("position")
        .truncate(7);
    let cfg = ReviewConfig {
        ps: vec![0.1],
        qs: vec![0.05],
        horizon: 1,
        ..review_config()
    };
    let run = run_value(&[file], &cfg, &live);
    let p = &run["positions"][0];
    assert_eq!(p["mover"], "Red");
    assert_eq!(p["kind"], "pair");
    assert_eq!(p["slot"], 7);
    let r = reading(p, REFERENCE_ARM);
    let best = number(&r["best_in_pool"]["value"], "value");
    let mut worse = 0;
    for x in ranked(r) {
        let value = number(&x["value"], "value");
        let gain = number(&x["gain_logit"], "gain");
        for field in ["gain_logit", "gain_pp"] {
            let g = number(&x[field], field);
            assert!(
                g != 0.0 || g.is_sign_positive(),
                "a negative zero in {field}"
            );
        }
        assert!(
            (gain - (best - value)).abs() < 1e-12,
            "Red's gain is best minus value"
        );
        // Red's win is one minus Blue's logistic.
        let blue = 1.0 / (1.0 + (-value).exp());
        assert!((number(&x["mover_win_pct"], "win") - (1.0 - blue) * 100.0).abs() < 1e-9);
        worse += usize::from(gain < 0.0);
    }
    assert!(
        worse >= 1,
        "options worse for Red than the best in-pool have a negative gain"
    );
    let best_ranked = ranked(r)
        .iter()
        .find(|x| x["option"] == r["best_in_pool"]["option"])
        .expect("the best in-pool is ranked");
    assert_eq!(best_ranked["rank"], r["best_in_pool"]["rank"]);
}

/// A ban root: no side, no best in-pool and no gains; the entries are echoed verbatim and counted in
/// `base`, though the loader read none of them.
/// Kills: `base` counting the parsed entries; a verbatim echo that drops or reshapes them.
#[test]
fn a_ban_root_echoes_and_counts_its_entries() {
    let live = live();
    let mut file = labelled();
    {
        let object = file.as_object_mut().expect("an object");
        for key in ["actual_next", "role_verdict", "verdict"] {
            object.remove(key);
        }
    }
    file["position"] = json!([{ "slot": 0, "side": "Blue", "kind": "ban", "champion": "Zilean" }]);
    let cfg = ReviewConfig {
        ps: vec![0.1],
        qs: vec![0.05],
        horizon: 1,
        ..review_config()
    };
    let run = run_value(&[file], &cfg, &live);
    let p = &run["positions"][0];
    assert_eq!(p["kind"], "ban");
    assert_eq!(p["mover"], "Red");
    assert_eq!(p["base"], 2);
    assert_eq!(p["verdicts"], labelled()["verdicts"]);
    assert_eq!(p["labels"], json!({}));
    assert_eq!(p["would_pick"], json!({}));
    assert_eq!(
        p["warnings"],
        json!(["labelled-position: verdicts: no options to judge at a ban root; not read"])
    );
    for r in readings(p) {
        assert!(r["best_in_pool"].is_null());
        assert!(!ranked(r).is_empty());
        for x in ranked(r) {
            assert_eq!(x["class"], "in-pool");
            assert!(x["gain_logit"].is_null() && x["gain_pp"].is_null());
        }
    }
    for (id, o) in p["options"].as_object().expect("options") {
        assert!(o["comp"].is_null() && o["side"] == json!([]), "{id}");
    }
}

/// The labelled position's `verdicts` go out verbatim, and `base` counts them.
/// Kills: a re-serialised entry that differs from the file's.
#[test]
fn the_fixtures_verdicts_are_echoed_verbatim() {
    let p = &base_run()["positions"][0];
    assert_eq!(p["verdicts"], labelled()["verdicts"]);
    assert_eq!(p["base"], 2);
    // The pools as authored: the arrays keep their authored order (not index order).
    assert_eq!(p["pools"], labelled()["pools"]);
    assert_eq!(p["pools"]["blue"]["adc"][0], "Yunara");
    assert_eq!(p["review"], labelled()["review"]);
    assert_eq!(p["legacy"]["off_pool"], false);
    assert_eq!(
        p["legacy"]["role_verdict"]["roles"],
        json!(["mid", "jungle"])
    );
    // The own pick: both folds, as the fixture's pair, in id order.
    assert_eq!(
        p["would_pick"],
        json!({"blind": ["Galio", "MonkeyKing"], "current": ["Galio", "MonkeyKing"]})
    );
    // A label given only after reveal has no `blind`.
    assert_eq!(p["labels"][OPT_C], json!({"current": "play"}));
    assert_eq!(
        p["labels"][OPT_B],
        json!({"blind": "never", "current": "maybe"})
    );
}

/// `would_pick`'s three states on the wire: absent, `null`, an action.
/// Kills: "no view" and "not answered" written alike.
#[test]
fn would_pick_has_three_states_on_the_wire() {
    use engine_core::reference::tier_b_review::PickPair;
    let never = PickPair::default();
    assert_eq!(serde_json::to_value(&never).expect("json"), json!({}));
    let no_view = PickPair {
        blind: Some(None),
        current: Some(Some(vec!["Galio".to_string()])),
    };
    assert_eq!(
        serde_json::to_value(&no_view).expect("json"),
        json!({"blind": null, "current": ["Galio"]})
    );
}

/// One search failure is recorded in that reading's `error` and the rest run: here an arm whose P is
/// above L, which `search` refuses, beside the arms that succeed.
/// Kills: a failed search that aborts the run or drops the arm.
#[test]
fn a_refused_arm_is_named_and_the_rest_run() {
    let live = live();
    let cfg = ReviewConfig {
        ps: vec![1.0e9],
        qs: vec![0.05],
        ..review_config()
    };
    let run = run_value(&[labelled()], &cfg, &live);
    let p = &run["positions"][0];
    let bad = reading(p, "roster:1000000000:0.05");
    let message = text(&bad["error"], "error");
    assert!(message.contains("invalid input"), "{message}");
    assert!(bad["depth"].is_null() && bad["partial"].is_null());
    assert_eq!(bad["ranked"], json!([]));
    assert!(bad["best_in_pool"].is_null());
    for arm in ["pool_or_roster", REFERENCE_ARM] {
        let r = reading(p, arm);
        assert!(r["error"].is_null(), "{arm}");
        assert!(!ranked(r).is_empty());
    }
    // The catalog is built from the arms that ran.
    assert!(p["options"].as_object().expect("options").len() > 5);
}

/// A node budget of 1 fails every search (`a_failed_search_is_named_and_the_report_continues`'s
/// setting): each reading says so, the position still comes out with its labelled options in the
/// catalog, and a malformed fixture beside it is reported in `load_errors` in its place.
/// Kills: a panic on an empty ranking; a load error that stops the run.
#[test]
fn every_search_failing_still_gives_a_run_and_a_bad_file_is_reported() {
    let live = live();
    let cfg = ReviewConfig {
        node_budget: 1,
        ..review_config()
    };
    let mut broken = labelled();
    broken["verdicts"][0]["labels"][OPT_A] = json!("maybee");
    let corpus = vec![load(&broken, &live), load(&labelled(), &live)];
    let run = normalised(&run_review(&corpus, &live, &cfg));
    let load_errors = array(&run["load_errors"], "load_errors");
    assert_eq!(load_errors.len(), 1);
    assert!(
        text(&load_errors[0], "error").contains("unknown label \"maybee\""),
        "{load_errors:?}"
    );
    let positions = array(&run["positions"], "positions");
    assert_eq!(positions.len(), 1);
    let p = &positions[0];
    for r in readings(p) {
        assert!(r["error"].is_string(), "{}", r["arm"]);
        assert_eq!(r["ranked"], json!([]));
    }
    assert_eq!(readings(p).len(), 5);
    // The labelled options are in the catalog; none was ranked.
    let options = p["options"].as_object().expect("options");
    assert_eq!(options.len(), 3);
    assert!(options
        .values()
        .all(|o| o["reach"].is_null() && o["row"] == false));
}

/// The arms: `pool_or_roster`, the grid Q-major, and the reference arm added once where the grid lacks
/// it, with `f64`'s shortest display in the ids.
/// Kills: a reference arm that is dropped or doubled; an id spelled another way.
#[test]
fn the_arms_are_the_grid_plus_the_reference_arm() {
    let run = base_run();
    let ids: Vec<&str> = array(&run["run"]["arms"], "arms")
        .iter()
        .map(|a| text(&a["id"], "id"))
        .collect();
    assert_eq!(
        ids,
        [
            "pool_or_roster",
            "roster:0.02:0",
            "roster:0.1:0",
            "roster:0.02:0.05",
            "roster:0.1:0.05"
        ]
    );
    assert_eq!(run["run"]["reference_arm"], REFERENCE_ARM);
    assert_eq!(
        run["run"]["arms"][0],
        json!({"id": "pool_or_roster", "rule": "pool_or_roster"})
    );
    assert_eq!(
        run["run"]["arms"][4],
        json!({"id": REFERENCE_ARM, "rule": "roster", "p": 0.1, "q": 0.05})
    );
    // A grid without it gains it, once.
    let live = live();
    let cfg = ReviewConfig {
        ps: vec![0.08],
        qs: vec![0.15],
        node_budget: 1,
        ..review_config()
    };
    let run = run_value(&[labelled()], &cfg, &live);
    let ids: Vec<&str> = array(&run["run"]["arms"], "arms")
        .iter()
        .map(|a| text(&a["id"], "id"))
        .collect();
    assert_eq!(ids, ["pool_or_roster", "roster:0.08:0.15", REFERENCE_ARM]);
}

/// The contract, pinned: the run on the labelled position, `seconds` and `search.jobs` removed. `insta`
/// has only its `yaml` feature here, so the normalised `Value` is snapshotted as pretty JSON text. The
/// floats are rounded to 9 places so a last-bit difference in the logistic (`exp`) on another platform
/// does not break the pin.
/// Kills: any change to the JSON's shape, names or values.
#[test]
fn the_run_json_on_the_labelled_position_is_pinned() {
    let mut v = base_run().clone();
    round_floats(&mut v);
    let text = serde_json::to_string_pretty(&v).expect("pretty json");
    insta::assert_snapshot!("run_on_the_labelled_position", text);
}

fn round_floats(v: &mut Value) {
    match v {
        Value::Number(n) if n.is_f64() => {
            if let Some(rounded) = n
                .as_f64()
                .and_then(|x| serde_json::Number::from_f64((x * 1e9).round() / 1e9))
            {
                *n = rounded;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(round_floats),
        Value::Object(map) => map.values_mut().for_each(round_floats),
        _ => {}
    }
}

/// A cut search leaves the position out at that arm: with a node budget that cuts every search at
/// depth 1, each reading is kept and flagged `partial` with no `ranked` and no best in-pool, and the
/// catalog gets no rows, no `reach` and no seeds from it (only the labelled options, as written).
/// Kills: a partial reading that still seeds the catalog or sets rows.
#[test]
fn a_partial_search_leaves_the_position_out_at_that_arm() {
    let live = live();
    let cfg = ReviewConfig {
        node_budget: 1_000,
        ..review_config()
    };
    let run = run_value(&[labelled()], &cfg, &live);
    let p = &run["positions"][0];
    for r in readings(p) {
        assert_eq!(r["partial"], true, "{}", r["arm"]);
        assert!(r["error"].is_null());
        assert_eq!(r["depth"], 1);
        assert!(r["searched"].as_u64() > Some(0));
        assert_eq!(r["ranked"], json!([]));
        assert!(r["best_in_pool"].is_null());
    }
    let options = p["options"].as_object().expect("options");
    assert_eq!(options.len(), 3, "only the labelled options");
    assert!(options
        .values()
        .all(|o| o["reach"].is_null() && o["row"] == false));
}

/// `actual_next` and a line verdict's option each seed the catalog without being labelled: neither
/// action is anywhere else (not labelled, not a top K, not an own pick), yet each is ranked at the
/// roster arms. Kills: `actual_next` not seeded; line-verdict options not seeded.
#[test]
fn actual_next_and_a_line_verdicts_option_seed_the_catalog_unlabelled() {
    let live = live();
    let mut file = labelled();
    file["actual_next"] = json!(["Nami", "Yunara"]);
    let line_option = "Bard+Ziggs|top=Rumble,adc=Ziggs,support=Bard";
    file["verdicts"][1]["line"]["option"] = json!(line_option);
    let run = run_value(&[file], &review_config(), &live);
    let p = &run["positions"][0];
    assert!(p["labels"].get(line_option).is_none());
    for action in [json!(["Nami", "Yunara"]), json!(["Bard", "Ziggs"])] {
        let ranked_here: Vec<&Value> = readings(p)
            .iter()
            .filter(|r| is_roster(r))
            .flat_map(ranked)
            .filter(|x| p["options"][text(&x["option"], "option")]["action"] == action)
            .collect();
        assert!(
            ranked_here.len() >= 4,
            "{action} is ranked at each roster arm: {}",
            ranked_here.len()
        );
        assert!(p["labels"]
            .as_object()
            .expect("labels")
            .keys()
            .all(|id| p["options"][id.as_str()]["action"] != action));
    }
}

/// `line_steps` carries each continuation action's side and kind from the replay position's next slot,
/// with that step's placements; `line_steps[i].champions` is `line[i]` and the steps' placements
/// concatenated are `line_side`. On the labelled position every step is Red's pick; on a slot-11
/// position (a copy of `2026-10-04-supp-pinch-slot-11-kittens`, in `ban-line/`) the line opens with
/// the mover's own ban, which a bare action list reads as a pick.
/// Kills: a side or kind guessed instead of read at the step; steps out of step with `line`/`line_side`.
#[test]
fn line_steps_carry_the_side_and_kind_of_each_step() {
    let live = live();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/tier-b-review/ban-line/2026-10-04-supp-pinch-slot-11-kittens.json");
    let ban_line: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let ban_run = run_value(&[ban_line], &review_config(), &live);
    let bp = &ban_run["positions"][0];
    let mover = text(&bp["mover"], "mover");
    let base = &base_run()["positions"][0];
    let mut first_bans = 0;
    for (p, first_side, first_kind) in [(base, "Red", "pick"), (bp, mover, "ban")] {
        let mut steps_seen = 0;
        for r in readings(p) {
            for x in ranked(r) {
                let steps = array(&x["line_steps"], "line_steps");
                let line = array(&x["line"], "line");
                assert_eq!(steps.len(), line.len(), "{}", x["option"]);
                let mut flat: Vec<Value> = Vec::new();
                for (step, ids) in steps.iter().zip(line) {
                    assert_eq!(&step["champions"], ids);
                    flat.extend(array(&step["placements"], "placements").iter().cloned());
                    steps_seen += 1;
                }
                assert_eq!(Value::Array(flat), x["line_side"], "{}", x["option"]);
                if let Some(first) = steps.first() {
                    assert_eq!(first["side"], first_side, "{} {}", p["id"], x["option"]);
                    assert_eq!(first["kind"], first_kind, "{} {}", p["id"], x["option"]);
                    if first["kind"] == "ban" {
                        assert_eq!(first["placements"], json!([]));
                        first_bans += 1;
                    }
                }
            }
        }
        assert!(steps_seen > 20, "{} steps", steps_seen);
    }
    assert!(first_bans > 20, "{first_bans} lines open with a ban");
}

// ---- Task 4: reference data, the depth check, the binary ---------------------------------------------

/// The depth check's config: one roster arm at the reference price, narrow widths, depth check on.
fn depth_config() -> ReviewConfig {
    ReviewConfig {
        ps: vec![0.1],
        qs: vec![0.05],
        shortlist: Shortlist {
            singles: 10,
            pairs: 20,
            root_off_pool: 30,
        },
        depth_check: true,
        ..review_config()
    }
}

/// A real slot-16 fixture (read-only copy of `fixtures/tier-b/2026-09-29-ad-pinch-slot-16-kittens`).
/// Measured (debug, widths 10/20/30, P 0.1 Q 0.05; about 7 s for the whole run): horizon 2 ranks Bard
/// 0.3985, Zeri 0.4151, Janna 0.4861, Seraphine 0.5027; horizon 3 ranks Zeri, Bard, Ashe first. One more
/// turn reaches another pick (F13), so both the #1 and the top-3 set move.
fn deeper_fixture() -> Value {
    review_data("depth/2026-09-29-ad-pinch-slot-16-kittens.json")
}

/// The slot-16 position's run under `depth_config`, computed once for the tests that read it (about 7 s).
fn deeper_run() -> &'static Value {
    static RUN: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    RUN.get_or_init(|| run_value(&[deeper_fixture()], &depth_config(), &live()))
}

fn names(v: &Value, what: &str) -> Vec<String> {
    array(v, what)
        .iter()
        .map(|c| text(c, what).to_string())
        .collect()
}

/// `draft` is the id's text between the date prefix and `-pinch` or `-slot-`, else the whole id.
/// Kills: a draft that keeps the date; a missing fallback.
#[test]
fn draft_is_derived_from_the_id() {
    for (id, draft) in [
        ("2026-10-04-supp-pinch-slot-17-dme", "supp"),
        ("2026-10-07-synth-dme-adc-pinch-slot-17", "synth-dme-adc"),
        (
            "2026-09-27-smoke-1-blue-first-pick",
            "2026-09-27-smoke-1-blue-first-pick",
        ),
        ("2026-09-29-top-pinch-slot-19-kittens", "top"),
        ("2026-10-04-supp-slot-17", "supp"),
        ("labelled-position", "labelled-position"),
        ("2026-10-04--slot-1", "2026-10-04--slot-1"),
    ] {
        assert_eq!(draft_of(id), draft, "{id}");
    }
    assert_eq!(base_run()["positions"][0]["draft"], "labelled-position");
}

/// One ply deeper moves the #1 and the top-3 set on a real slot-16 position: `stable` is false, and
/// the readings agree with the two rankings recomputed here from `reference_ranking` and `top_3`.
/// Kills: a depth check that searches the same horizon; `stable` that reads only the #1 or only the set.
#[test]
fn a_ranking_that_moves_one_ply_deeper_is_not_stable() {
    let p = &deeper_run()["positions"][0];
    let d = &p["depth_check"];
    assert_eq!(d["horizon"], 3);
    let shallow: Vec<Vec<String>> = array(&p["reference_ranking"], "reference_ranking")
        .iter()
        .take(3)
        .map(|x| names(&x["action"], "action"))
        .collect();
    let deep: Vec<Vec<String>> = array(&d["top_3"], "top_3")
        .iter()
        .map(|a| names(a, "a top-3 action"))
        .collect();
    assert_eq!(shallow[0], ["Bard"]);
    assert_eq!(deep[0], ["Zeri"]);
    assert_eq!(d["same_first"], false);
    let as_set = |l: &[Vec<String>]| l.iter().cloned().collect::<BTreeSet<Vec<String>>>();
    assert_ne!(as_set(&shallow), as_set(&deep));
    assert_eq!(d["same_top_3"], false);
    assert_eq!(d["stable"], false);
}

/// A position the extra ply cannot change reads `stable: true` with nothing null; with the check off
/// the key is absent; where every search is cut or fails every reading is `null` and `top_3` is empty.
/// Kills: `null` read as stable or unstable; a depth check written when switched off; a panic on failure.
#[test]
fn the_depth_check_is_null_free_when_stable_absent_when_off_and_null_when_cut() {
    let live = live();
    // Slot 19: the last pick, nothing deeper to see.
    let run = run_value(&[por_only_fixture()], &depth_config(), &live);
    let d = &run["positions"][0]["depth_check"];
    assert_eq!(d["horizon"], 3);
    assert_eq!(d["stable"], true, "{d}");
    assert_eq!(d["same_first"], true);
    assert_eq!(d["same_top_3"], true);
    assert_eq!(array(&d["top_3"], "top_3").len(), 3);

    let off = ReviewConfig {
        depth_check: false,
        ..depth_config()
    };
    let run = run_value(&[por_only_fixture()], &off, &live);
    assert!(!run["positions"][0]
        .as_object()
        .expect("a position")
        .contains_key("depth_check"));
    assert!(!base_run()["positions"][0]
        .as_object()
        .expect("a position")
        .contains_key("depth_check"));

    // A node budget of 1 fails every search; 1_000 cuts every one at depth 1 (partial).
    for node_budget in [1, 1_000] {
        let cut = ReviewConfig {
            node_budget,
            ..depth_config()
        };
        let run = run_value(&[labelled()], &cut, &live);
        let d = &run["positions"][0]["depth_check"];
        assert_eq!(d["horizon"], 3, "{node_budget}");
        for key in ["stable", "same_first", "same_top_3"] {
            assert!(d[key].is_null(), "{node_budget} {key}");
        }
        assert_eq!(d["top_3"], json!([]), "{node_budget}");
    }
}

/// `open_roles` on the wire: the labelled position's Blue side (Rumble at top) leaves the other four
/// open, in role order and in the role map's spelling.
/// Kills: roles in the wrong order or spelling (`middle`, `bottom`).
#[test]
fn open_roles_go_out_in_role_order() {
    let p = &base_run()["positions"][0];
    assert_eq!(
        p["open_roles"],
        json!([["jungle", "mid", "adc", "support"]])
    );
}

/// The menu at a pair root: the mover's pool for each open role; a champion the board took reads its
/// status and no best; an open champion's best is an in-pool pair carrying it, in the catalog, at the
/// reference arm's rank, and the arm's best in-pool option is the one with gain 0.
/// Kills: a best that is not in-pool or does not carry the champion; a champion on the board read as
/// open; a menu option missing from the catalog; the top role (Rumble locked there) offered as open.
#[test]
fn the_menu_reads_the_reference_arms_best_in_pool_pair_per_champion() {
    let p = &base_run()["positions"][0];
    let menu = check_menu(p, 20);
    assert_eq!(
        menu.keys().map(String::as_str).collect::<Vec<_>>(),
        ["adc", "jungle", "mid", "support"],
        "the open roles only"
    );

    // The board's champions: Locke (Red's pick) in mid, Naafiri (banned) and Vi (Red's pick) in jungle.
    let status = |role: &str, champion: &str| {
        array(&menu[role], role)
            .iter()
            .find(|e| e["champion"] == champion)
            .map(|e| e["status"].clone())
    };
    assert_eq!(status("mid", "Locke"), Some(json!("picked")));
    assert_eq!(status("jungle", "Naafiri"), Some(json!("banned")));
    assert_eq!(status("jungle", "Vi"), Some(json!("picked")));
}

/// The menu's rules on one position: every open champion's best is an in-pool action carrying it, in the
/// catalog, with the reading's rank and gains, gains at most 0, and the arm's best in-pool option the
/// only gain 0; a champion the board took has no best. Returns the menu.
fn check_menu(p: &Value, min_open: usize) -> &serde_json::Map<String, Value> {
    let menu = p["menu"].as_object().expect("menu");
    let reference = reading(p, REFERENCE_ARM);
    let best_in_pool = &reference["best_in_pool"];
    let mut zero_gain = Vec::new();
    let mut seen_open = 0;
    for (role, entries) in menu {
        for e in array(entries, role) {
            let c = text(&e["champion"], "champion");
            let status = text(&e["status"], "status");
            if status != "open" {
                assert!(e["best"].is_null(), "{role} {c} is {status}");
                continue;
            }
            seen_open += 1;
            let best = &e["best"];
            let id = text(&best["option"], "best option");
            let option = &p["options"][id];
            assert!(option.is_object(), "{id} is in the catalog");
            assert!(names(&option["action"], "action").iter().any(|a| a == c));
            let x = ranked(reference)
                .iter()
                .find(|x| x["option"] == id)
                .unwrap_or_else(|| panic!("{id} is read at the reference arm"));
            assert_eq!(x["class"], "in-pool", "{id}");
            assert_eq!(x["rank"], best["rank"], "{id}");
            assert_eq!(x["gain_logit"], best["gain_logit"], "{id}");
            assert_eq!(x["gain_pp"], best["gain_pp"], "{id}");
            // Nothing in-pool that carries the champion is read above its best.
            for y in ranked(reference) {
                let carries = names(
                    &p["options"][text(&y["option"], "option")]["action"],
                    "action",
                )
                .iter()
                .any(|a| a == c);
                if carries && y["class"] == "in-pool" {
                    assert!(
                        y["rank"].as_u64() >= best["rank"].as_u64(),
                        "{c}: {}",
                        y["option"]
                    );
                }
            }
            let gain = number(&best["gain_logit"], "gain");
            assert!(gain <= 0.0, "{id}");
            if gain == 0.0 {
                zero_gain.push(id);
            }
        }
    }
    assert!(seen_open >= min_open, "{seen_open} open champions");
    assert!(!zero_gain.is_empty());
    assert!(zero_gain.iter().all(|id| *id == best_in_pool["option"]));
    menu
}

/// `reference_ranking` is the reference arm's whole list: as long as the search's ranked list, best
/// first for the mover, ranks as 1 + the strictly better, and every option the reading carries is in it
/// at the same rank and value.
/// Kills: a truncated list; a list in another order; ranks that differ from the reading's.
#[test]
fn the_reference_ranking_is_complete_and_ordered() {
    let p = &base_run()["positions"][0];
    assert_eq!(p["mover"], "Blue");
    let list = array(&p["reference_ranking"], "reference_ranking");
    let reference = reading(p, REFERENCE_ARM);
    assert_eq!(
        list.len() as u64,
        reference["searched"].as_u64().expect("searched")
    );
    assert!(list.len() > 100);
    // Blue moves: best first is value descending, and a tie shares its rank.
    let values: Vec<f64> = list.iter().map(|x| number(&x["value"], "value")).collect();
    assert!(values.windows(2).all(|w| w[0] >= w[1]));
    for (i, x) in list.iter().enumerate() {
        let better = values.iter().filter(|v| **v > values[i]).count();
        assert_eq!(x["rank"].as_u64(), Some(better as u64 + 1), "entry {i}");
    }
    for x in ranked(reference) {
        let action = &p["options"][text(&x["option"], "option")]["action"];
        let found = list
            .iter()
            .find(|l| &l["action"] == action)
            .unwrap_or_else(|| panic!("{action} is in the reference ranking"));
        assert_eq!(found["rank"], x["rank"]);
        assert_eq!(found["value"], x["value"]);
    }
}

/// A Red mover's reference ranking is best first for Red: values ascend.
/// Kills: a sort that assumes Blue.
#[test]
fn a_red_movers_reference_ranking_ascends() {
    let run = run_value(&[por_only_fixture()], &review_config(), &live());
    let p = &run["positions"][0];
    assert_eq!(p["mover"], "Red");
    let list = array(&p["reference_ranking"], "reference_ranking");
    assert!(list.len() > 5);
    let values: Vec<f64> = list.iter().map(|x| number(&x["value"], "value")).collect();
    assert!(values.windows(2).all(|w| w[0] <= w[1]));
    assert_eq!(list[0]["rank"], 1);
}

/// The binary: a missing `TIER_B_JSON` is a usage error (exit 2) before any search; a run on a corpus
/// directory writes the `ReviewRun` struct in its field order (not a sorted `Value`), with the depth
/// check, and prints what it did.
/// Kills: a run that starts without an output path; output keys sorted alphabetically.
#[test]
fn the_binary_writes_the_run_in_struct_order_and_refuses_no_output_path() {
    let exe = env!("CARGO_BIN_EXE_tier_b_review");
    let refused = std::process::Command::new(exe)
        .env_remove("TIER_B_JSON")
        .output()
        .expect("the binary runs");
    assert_eq!(refused.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&refused.stderr);
    assert!(stderr.contains("TIER_B_JSON"), "{stderr}");

    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/tier-b-review/por-only");
    let out = std::env::temp_dir().join(format!("tier-b-review-bin-{}.json", std::process::id()));
    let ran = std::process::Command::new(exe)
        .env("TIER_B_JSON", &out)
        .env("TIER_B_FIXTURES", &dir)
        .env("TIER_B_P", "0.1")
        .env("TIER_B_W", "1")
        .env("TIER_B_Q", "0.05")
        .env("TIER_B_WIDTHS", "10,20,30")
        .env("TIER_B_K", "3")
        .env("TIER_B_JOBS", "2")
        .env("TIER_B_RUN_ID", "2026-11-09T00:00:00Z")
        .output()
        .expect("the binary runs");
    let stderr = String::from_utf8_lossy(&ran.stderr);
    assert!(ran.status.success(), "{stderr}");
    assert!(
        stderr.contains("1 positions, 2 arms, 0 load errors"),
        "{stderr}"
    );
    let written = std::fs::read_to_string(&out).expect("the run JSON");
    std::fs::remove_file(&out).expect("clean up");
    assert!(written.ends_with("}\n"));
    let at = |key: &str| {
        written
            .find(&format!("\n  \"{key}\""))
            .unwrap_or_else(|| panic!("top-level key {key}"))
    };
    assert!(at("schema") < at("run"));
    assert!(at("run") < at("positions"));
    assert!(at("positions") < at("load_errors"));
    let v: Value = serde_json::from_str(&written).expect("it is JSON");
    assert_eq!(v["schema"], "tier-b-run/1");
    assert_eq!(v["run"]["id"], "2026-11-09T00:00:00Z");
    assert_eq!(v["run"]["search"]["jobs"], 2);
    assert_eq!(v["run"]["data"]["positions_patch"], "16.19");
    assert_eq!(v["run"]["k"], 3);
    assert_eq!(
        v["run"]["search"]["widths"],
        json!({"singles": 10, "pairs": 20, "root_off_pool": 30})
    );
    assert_eq!(v["positions"][0]["depth_check"]["horizon"], 3);
    assert_eq!(v["positions"][0]["draft"], "top");
}

/// A Red mover's menu (the slot-16 position, Red to pick one champion): the same rules as the Blue
/// pair root, with gains signed for Red. Measured: Ashe's best is at rank 6 with gain -0.111 logit.
/// Kills: `menu_of` signing the gain for Blue (every Red gain would read >= 0 and not match the
/// reading's); a best that is any class rather than in-pool (here higher-ranked actions carrying a
/// champion are off-pool).
#[test]
fn a_red_movers_menu_gains_are_mover_signed() {
    let p = &deeper_run()["positions"][0];
    assert_eq!(p["mover"], "Red");
    let menu = check_menu(p, 5);
    assert_eq!(
        menu.keys().map(String::as_str).collect::<Vec<_>>(),
        ["adc", "support"]
    );
    let ashe = array(&menu["adc"], "adc")
        .iter()
        .find(|e| e["champion"] == "Ashe")
        .expect("Ashe is in the adc pool");
    assert_eq!(ashe["best"]["rank"], 6);
    let gain = number(&ashe["best"]["gain_logit"], "gain");
    assert!((gain + 0.111).abs() < 0.001, "{gain}");
}

/// A champion the fixture excludes reads `excluded` with no best (copy of the labelled position with
/// Aphelios, in Blue's adc pool, excluded); the rest of the adc menu is unchanged in kind.
/// Kills: the `excluded` branch of the board status read as open.
#[test]
fn an_excluded_champion_reads_excluded() {
    let mut file = labelled();
    file["exclusions"] = json!(["Aphelios"]);
    let cfg = ReviewConfig {
        depth_check: false,
        ..depth_config()
    };
    let run = run_value(&[file], &cfg, &live());
    let menu = &run["positions"][0]["menu"];
    let adc = array(&menu["adc"], "adc");
    let aphelios = adc
        .iter()
        .find(|e| e["champion"] == "Aphelios")
        .expect("Aphelios is in the adc pool");
    assert_eq!(aphelios["status"], "excluded");
    assert!(aphelios["best"].is_null());
    assert!(adc
        .iter()
        .any(|e| e["status"] == "open" && !e["best"].is_null()));
}

/// `TIER_B_JOBS=0` is one job, and the JSON records the jobs actually used.
/// Kills: a stamped 0.
#[test]
fn zero_jobs_is_one_job() {
    let exe = env!("CARGO_BIN_EXE_tier_b_review");
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/tier-b-review/por-only");
    let out = std::env::temp_dir().join(format!("tier-b-review-jobs-{}.json", std::process::id()));
    let ran = std::process::Command::new(exe)
        .env("TIER_B_JSON", &out)
        .env("TIER_B_FIXTURES", &dir)
        .env("TIER_B_P", "0.1")
        .env("TIER_B_W", "1")
        .env("TIER_B_Q", "0.05")
        .env("TIER_B_WIDTHS", "10,20,30")
        .env("TIER_B_DEPTH_CHECK", "0")
        .env("TIER_B_JOBS", "0")
        .output()
        .expect("the binary runs");
    assert!(
        ran.status.success(),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&out).expect("the run JSON"))
        .expect("it is JSON");
    std::fs::remove_file(&out).expect("clean up");
    assert_eq!(v["run"]["search"]["jobs"], 1);
}

// ---- Task 9: scoring a ranking ---------------------------------------------------------------------
//
// Rankings are written in the mover's terms (a larger `v` is better for the mover) and built for both
// movers: Blue values are `v`, Red values `-v`, so a dropped sign fails the Red half. Entry `i` is
// `Pick(ChampionIdx(i))`. Expected arrays are indexed k = 1, 3, 5, 10.

#[derive(Clone, Copy, PartialEq)]
enum L {
    P,
    M,
    N,
    /// No label; the option is resolved but not in the map.
    U,
}

#[derive(Clone, Copy)]
struct R {
    v: f64,
    l: L,
    charge: f64,
    in_pool: bool,
}

fn r(v: f64, l: L) -> R {
    R {
        v,
        l,
        charge: 0.0,
        in_pool: true,
    }
}

fn champ_action(i: u8) -> Action {
    Action::Pick(ChampionIdx(i))
}

fn score_for(mover: Side, rows: &[R], own: Option<(u8, bool)>, margin: f64) -> PositionScore {
    let sign = if mover == Side::Blue { 1.0 } else { -1.0 };
    let mut labels = HashMap::new();
    let ranking: Vec<ScoredAction> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let action = champ_action(u8::try_from(i).expect("small"));
            let key = OptionKey { action, comp: None };
            match row.l {
                L::P => labels.insert(key.clone(), Label::Play),
                L::M => labels.insert(key.clone(), Label::Maybe),
                L::N => labels.insert(key.clone(), Label::Never),
                L::U => None,
            };
            ScoredAction {
                action,
                value: sign * row.v,
                option: (row.l != L::U || i % 2 == 1).then_some(key),
                in_pool: own.map_or(row.in_pool, |(o, in_pool)| {
                    if usize::from(o) == i {
                        in_pool
                    } else {
                        row.in_pool
                    }
                }),
                class: if row.in_pool {
                    TopClassName::InPool
                } else {
                    TopClassName::Graded
                },
                opponent_charge: row.charge,
            }
        })
        .collect();
    score_ranking(
        mover,
        &ranking,
        &labels,
        own.map(|(i, _)| champ_action(i)),
        own.is_some_and(|(_, in_pool)| in_pool),
        margin,
    )
}

fn both(rows: &[R], own: Option<(u8, bool)>, margin: f64, check: impl Fn(Side, PositionScore)) {
    for mover in [Side::Blue, Side::Red] {
        check(mover, score_for(mover, rows, own, margin));
    }
}

const T: bool = true;
const F: bool = false;

/// A large lead at #1 is a clear `never` at every k whatever sits near #3. Hand measure: the `never`
/// at 2.0 is the best-ranked `never`; the non-`never` options at or above it or within 0.01 below:
/// none (the next is 1.0). Count 0 is under every k. The four plays at 0.9..0.891 sit within 0.01 of #3
/// (0.9) and number 4 >= 3: reading the cluster near #k would deny k = 3.
/// Kills: comparing against #k instead of the best-ranked `never`.
#[test]
fn a_large_lead_is_clear_whatever_sits_near_the_kth() {
    let rows = [
        r(2.0, L::N),
        r(1.0, L::P),
        r(0.9, L::P),
        r(0.895, L::P),
        r(0.893, L::P),
        r(0.891, L::P),
    ];
    both(&rows, None, 0.01, |mover, s| {
        assert_eq!(s.never, [T, T, T, T], "{mover:?}");
        assert_eq!(s.near, [F; 4], "{mover:?}");
        assert_eq!(s.unjudged, [F; 4], "{mover:?}");
    });
}

/// 0.5000 never, 0.4998 play, 0.1 play. Count of non-`never` within 0.01 of the `never`: 1 (the 0.4998;
/// the 0.1 is 0.4 away). k = 1: 1 < 1 fails, so not clear: a near tie, the `never` is in the top 1.
/// k = 3, 5, 10: 1 under k, clear; `play` is in the top 3 but not the top 1.
/// Kills: ε ignored (count 0 would make k = 1 clear).
#[test]
fn a_gap_of_two_ten_thousandths_is_a_near_tie_at_one_and_clear_at_three() {
    let rows = [r(0.5, L::N), r(0.4998, L::P), r(0.1, L::P)];
    both(&rows, None, 0.01, |mover, s| {
        assert_eq!(s.never, [F, T, T, T], "{mover:?}");
        assert_eq!(s.near, [T, F, F, F], "{mover:?}");
        assert_eq!(s.unjudged, [F; 4], "{mover:?}");
        assert_eq!(s.play, [F, T, T, T], "{mover:?}");
    });
}

/// The ε bound is inclusive. Margin 0.25 (exact in binary): `never` 1.0, play at 0.75 is exactly 0.25
/// below, so it counts: k = 1 not clear. Play at 0.7499 does not... it is 0.2501 below: k = 1 clear.
/// Kills: an exclusive bound.
#[test]
fn the_margin_bound_is_inclusive() {
    both(&[r(1.0, L::N), r(0.75, L::P)], None, 0.25, |mover, s| {
        assert_eq!(s.never, [F, T, T, T], "{mover:?}");
    });
    both(&[r(1.0, L::N), r(0.7499, L::P)], None, 0.25, |mover, s| {
        assert_eq!(s.never, [T, T, T, T], "{mover:?}");
    });
}

/// Two `never`s tied at 1.0, a `play` at 0.5. The best-ranked `never` is the first; the non-`never`s
/// at or above it or within 0.01 below: none. Clear at every k. Ranks are [1, 1, 3]: the top 1 holds
/// both `never`s and no `play` (`no_play@1`), the top 3 holds the `play`.
/// Kills: counting the second `never` as a non-`never`; comparing against #k.
#[test]
fn two_nevers_tied_at_the_top_with_a_play_far_behind_is_clear() {
    let rows = [r(1.0, L::N), r(1.0, L::N), r(0.5, L::P)];
    both(&rows, None, 0.01, |mover, s| {
        assert_eq!(s.never, [T, T, T, T], "{mover:?}");
        assert_eq!(s.near, [F; 4], "{mover:?}");
        assert_eq!(s.play, [F, T, T, T], "{mover:?}");
        assert_eq!(s.no_play, [T, F, F, F], "{mover:?}");
    });
}

/// `1.000 never, 0.995 unlabelled, 0.800 play`. Unlabelled as `never`: the best `never` is #1 and no
/// non-`never` is within 0.01: count 0, clear. Unlabelled as non-`never`: count 1 (0.995): clear only
/// where 1 < k. So k = 1 disagrees (`unjudged@1`, so `near@1` is off), k = 3, 5, 10 agree on clear.
/// Kills: a single completion; unlabelled read as `never` only.
#[test]
fn an_unlabelled_option_inside_the_margin_is_unjudged_at_one_and_certain_at_three() {
    let rows = [r(1.0, L::N), r(0.995, L::U), r(0.8, L::P)];
    both(&rows, None, 0.01, |mover, s| {
        assert_eq!(s.never, [F, T, T, T], "{mover:?}");
        assert_eq!(s.unjudged, [T, F, F, F], "{mover:?}");
        assert_eq!(s.near, [F; 4], "{mover:?}");
    });
}

/// Nine plays (2.9 .. 2.1), a `never` at rank 10 (1.000), an unlabelled option at rank 11. As `never`
/// the unlabelled is outside the count: 9 non-`never`s above the best `never`, 9 < 10 clear. As
/// non-`never` at 0.995 (within 0.01): 10, not clear. So `unjudged@10`, `never@10` off; k = 1, 3, 5:
/// 9 >= k under both, agreed not clear. With the rank-11 option at 0.9 (outside) both agree: clear.
/// Kills: truncating the ranking at k (rank 11 unread); a single completion.
#[test]
fn an_unlabelled_rank_eleven_decides_never_at_ten() {
    let mut rows: Vec<R> = (0..9).map(|i| r(2.9 - 0.1 * f64::from(i), L::P)).collect();
    rows.push(r(1.0, L::N));
    let mut near = rows.clone();
    near.push(r(0.995, L::U));
    both(&near, None, 0.01, |mover, s| {
        assert_eq!(s.never, [F; 4], "{mover:?}");
        assert_eq!(s.unjudged, [F, F, F, T], "{mover:?}");
        assert_eq!(s.near, [F; 4], "{mover:?}");
    });
    let mut far = rows;
    far.push(r(0.9, L::U));
    both(&far, None, 0.01, |mover, s| {
        assert_eq!(s.never, [F, F, F, T], "{mover:?}");
        assert_eq!(s.unjudged, [F; 4], "{mover:?}");
    });
}

/// `near@k`: `never` at 1.0, `maybe` at 0.995, `play` at 0.5, no unlabelled. k = 1: count 1, not clear;
/// `never` in top 1; certain: near. k = 3: clear, so not near. A `never` outside the top k is no near
/// tie either: `never` at rank 2 under a `play` far above is not in the top 1.
/// Kills: `near` set wherever a `never` is not clear regardless of the top k.
#[test]
fn near_needs_a_labelled_never_in_the_top_k() {
    both(
        &[r(1.0, L::N), r(0.995, L::M), r(0.5, L::P)],
        None,
        0.01,
        |mover, s| {
            assert_eq!(s.near, [T, F, F, F], "{mover:?}");
            assert_eq!(s.never, [F, T, T, T], "{mover:?}");
        },
    );
    // play 2.0, never 1.0, play 0.999: the never is #2, count above or within = 2.
    // k = 1: not in the top 1 (not near, and not clear: 2 >= 1); k = 3: 2 < 3 clear.
    both(
        &[r(2.0, L::P), r(1.0, L::N), r(0.999, L::P)],
        None,
        0.01,
        |mover, s| {
            assert_eq!(s.near, [F; 4], "{mover:?}");
            assert_eq!(s.never, [F, T, T, T], "{mover:?}");
        },
    );
}

/// `neither_play`: never 1.0, unlabelled 0.9, maybe 0.8, no `play`. Top 1 is the `never`, fully
/// labelled, no `play`: `no_play@1`. Top 3 and beyond hold an unlabelled option: in neither.
/// All maybes: fully labelled everywhere, `no_play` throughout.
/// Kills: reading an unlabelled option as not-`play` (no_play at k = 3).
#[test]
fn an_unlabelled_option_in_range_counts_in_neither_play() {
    let rows = [r(1.0, L::N), r(0.9, L::U), r(0.8, L::M)];
    both(&rows, None, 0.01, |mover, s| {
        assert_eq!(s.play, [F; 4], "{mover:?}");
        assert_eq!(s.no_play, [T, F, F, F], "{mover:?}");
        assert_eq!(s.neither_play, [F, T, T, T], "{mover:?}");
    });
    both(
        &[r(1.0, L::N), r(0.9, L::M), r(0.8, L::M)],
        None,
        0.01,
        |mover, s| {
            assert_eq!(s.no_play, [T; 4], "{mover:?}");
            assert_eq!(s.neither_play, [F; 4], "{mover:?}");
        },
    );
}

fn five(fourth: f64) -> [R; 5] {
    [
        r(1.0, L::P),
        r(0.75, L::P),
        r(0.5, L::P),
        r(fourth, L::P),
        r(0.1, L::P),
    ]
}

/// The own pick is entry 3 (rank 4). Margin 0.25. #3 is 0.5; the pick at 0.25 is exactly 0.25 below, so
/// within: `pick@3`. Rank 4 <= 5 and <= 10: counts. #1 is 1.0: 0.25 is far outside: no.
/// The pick at 0.249 is 0.251 below #3: `pick@3` off. Regret is the mover-signed gap to #1: 0.75, 0.751.
/// Kills: plain rank for picks; a dropped sign (a Red value would put the pick above or below wrongly).
#[test]
fn an_own_pick_within_the_margin_of_the_kth_counts_and_one_outside_does_not() {
    both(&five(0.25), Some((3, true)), 0.25, |mover, s| {
        assert_eq!(s.pick, [F, T, T, T], "{mover:?}");
        assert_eq!(
            s.own,
            OwnPick::Ranked {
                rank: 4,
                regret: 0.75
            },
            "{mover:?}"
        );
    });
    both(&five(0.249), Some((3, true)), 0.25, |mover, s| {
        assert_eq!(s.pick, [F, F, T, T], "{mover:?}");
        match s.own {
            OwnPick::Ranked { rank: 4, regret } => assert!((regret - 0.751).abs() < 1e-12),
            other => panic!("{mover:?}: {other:?}"),
        }
    });
}

/// A pick at rank 2 (0.9) is within 0.25 of #1 (1.0): `pick@1` although rank 2.
/// Kills: plain rank; margin read only below the k-th.
#[test]
fn an_own_pick_at_two_is_within_the_margin_of_one() {
    let rows = [r(1.0, L::P), r(0.9, L::P), r(0.1, L::P)];
    both(&rows, Some((1, true)), 0.25, |mover, s| {
        assert_eq!(s.pick, [T; 4], "{mover:?}");
    });
    both(&rows, Some((2, true)), 0.25, |mover, s| {
        assert_eq!(s.pick, [F, T, T, T], "{mover:?}");
    });
}

/// `pick_off` counts only an off-pool own pick; in-pool leaves `pick_off` empty and not eligible.
/// No own pick (no view): outside the pick metrics, `NoPick`, not eligible, no median rank. An own
/// pick not in the ranking: `Absent`, rank infinity in the median, no regret, never a pick, but
/// eligible when off-pool (it is counted in the denominator).
/// Kills: `pick_off` as `pick`; absent read as no view; a rank-0 absent.
#[test]
fn pick_off_is_for_off_pool_picks_and_absent_is_not_no_view() {
    let rows = [r(1.0, L::P), r(0.5, L::P)];
    both(&rows, Some((0, false)), 0.01, |mover, s| {
        assert_eq!(s.pick, [T; 4], "{mover:?}");
        assert_eq!(s.pick_off, [T; 4], "{mover:?}");
        assert!(s.pick_off_eligible);
    });
    both(&rows, Some((0, true)), 0.01, |mover, s| {
        assert_eq!(s.pick, [T; 4], "{mover:?}");
        assert_eq!(s.pick_off, [F; 4], "{mover:?}");
        assert!(!s.pick_off_eligible);
    });
    both(&rows, None, 0.01, |mover, s| {
        assert_eq!(s.own, OwnPick::NoPick, "{mover:?}");
        assert_eq!(s.pick, [F; 4], "{mover:?}");
        assert!(!s.pick_off_eligible);
        assert_eq!(s.own.rank_for_median(), None);
    });
    both(&rows, Some((200, false)), 0.01, |mover, s| {
        assert_eq!(s.own, OwnPick::Absent, "{mover:?}");
        assert_eq!(s.pick, [F; 4], "{mover:?}");
        assert_eq!(s.pick_off, [F; 4], "{mover:?}");
        assert!(s.pick_off_eligible);
        assert_eq!(s.own.rank_for_median(), Some(f64::INFINITY));
    });
}

/// A ranking shorter than k, and an empty one, do not panic. One `never` alone: clear at every k, its
/// class is #1's. Empty: everything off, no class, an own pick absent.
/// Kills: indexing the k-th entry directly.
#[test]
fn a_ranking_shorter_than_k_is_handled() {
    both(&[r(1.0, L::N)], Some((0, true)), 0.01, |mover, s| {
        assert_eq!(s.never, [T; 4], "{mover:?}");
        assert_eq!(s.pick, [T; 4], "{mover:?}");
        assert_eq!(s.class_at_1, Some(TopClassName::InPool));
    });
    both(&[], Some((0, true)), 0.01, |mover, s| {
        assert_eq!(s.never, [F; 4], "{mover:?}");
        assert_eq!(s.no_play, [F; 4], "{mover:?}");
        assert_eq!(s.neither_play, [T; 4], "{mover:?}");
        assert_eq!(s.own, OwnPick::Absent, "{mover:?}");
        assert_eq!(s.class_at_1, None);
        assert!(!s.opp_lead);
    });
}

fn charged(v: f64, charge: f64) -> R {
    R {
        charge,
        ..r(v, L::P)
    }
}

/// `opp_lead`: the #1 changes when `value - mover_sign * charge` replaces `value`, re-ordered for the
/// mover. Hand measure (mover terms, adjusted = v - charge): A 0.30 c 0.05 -> 0.25 below B 0.28: lead.
/// A 0.30 c 0.01 -> 0.29 above B: none. A 0.5 c 0.25 -> 0.25 ties B 0.25: a tie keeps the #1: none.
/// C third (0.2 c 0.0) beating both adjusted (A 0.5 c 0.4 -> 0.1, B 0.4 c 0.3 -> 0.1): lead.
/// Pins only what `score_ranking` does with the `opponent_charge` it is given. That the runner leaves an
/// infeasibility band out of the charge cannot be tested here; it is tested where `opponent_charge` is
/// computed (Task 10/11).
/// Kills: a dropped sign (Red would add the charge); the tie going to the later entry.
#[test]
fn opp_lead_flips_with_the_sign_and_keeps_a_tied_leader() {
    both(
        &[charged(0.30, 0.05), charged(0.28, 0.0)],
        None,
        0.01,
        |m, s| {
            assert!(s.opp_lead, "{m:?}");
        },
    );
    both(
        &[charged(0.30, 0.01), charged(0.28, 0.0)],
        None,
        0.01,
        |m, s| {
            assert!(!s.opp_lead, "{m:?}");
        },
    );
    both(
        &[charged(0.5, 0.25), charged(0.25, 0.0)],
        None,
        0.01,
        |m, s| {
            assert!(!s.opp_lead, "{m:?}");
        },
    );
    both(
        &[charged(0.5, 0.4), charged(0.4, 0.3), charged(0.2, 0.0)],
        None,
        0.01,
        |m, s| {
            assert!(s.opp_lead, "{m:?}");
        },
    );
}

/// `class_at_1` reads the #1's class: an off-pool #1 is `Graded` here, an in-pool one `InPool`.
/// Kills: reading the last entry or the pick's class.
#[test]
fn class_at_one_is_the_top_entrys() {
    let off = R {
        in_pool: false,
        ..r(1.0, L::P)
    };
    both(&[off, r(0.5, L::P)], None, 0.01, |m, s| {
        assert_eq!(s.class_at_1, Some(TopClassName::Graded), "{m:?}");
    });
    both(&[r(1.0, L::P), off], None, 0.01, |m, s| {
        assert_eq!(s.class_at_1, Some(TopClassName::InPool), "{m:?}");
    });
}

/// An unlabelled option above the best labelled `never`. `[U 1.0, P 0.9, N 0.5]`: as `never` the
/// unlabelled is the best `never` with nothing above it: count 0, clear at every k. As non-`never` the
/// best `never` is 0.5 with two non-`never`s above: clear only at k = 3, 5, 10. So `unjudged@1`,
/// `never` at 3, 5, 10. `[U 1.0, P 0.5]` (no labelled `never`): as `never` the unlabelled #1 is clear
/// (the play at 0.5 is outside the margin); as non-`never` there is no `never`, so not clear:
/// `unjudged` at every k.
/// Kills: the best never chosen from labelled options only.
#[test]
fn an_unlabelled_option_above_the_best_labelled_never_is_unjudged() {
    both(
        &[r(1.0, L::U), r(0.9, L::P), r(0.5, L::N)],
        None,
        0.01,
        |m, s| {
            assert_eq!(s.never, [F, T, T, T], "{m:?}");
            assert_eq!(s.unjudged, [T, F, F, F], "{m:?}");
        },
    );
    both(&[r(1.0, L::U), r(0.5, L::P)], None, 0.01, |m, s| {
        assert_eq!(s.never, [F; 4], "{m:?}");
        assert_eq!(s.unjudged, [T; 4], "{m:?}");
    });
}

/// Ties at the k boundary are read by rank. `[N 1.0, P 1.0, P 0.5]` has ranks [1, 1, 3]: the top 1
/// holds both tied entries, so `play@1` (by list position it would be off and `no_play@1` on). The
/// `never` is not clear at k = 1 (the tied play is within the margin: count 1), so `near@1`.
/// Kills: the top k taken by list position.
#[test]
fn a_tie_at_the_k_boundary_is_in_the_top_k() {
    both(
        &[r(1.0, L::N), r(1.0, L::P), r(0.5, L::P)],
        None,
        0.01,
        |m, s| {
            assert_eq!(s.play, [T; 4], "{m:?}");
            assert_eq!(s.no_play, [F; 4], "{m:?}");
            assert_eq!(s.near, [T, F, F, F], "{m:?}");
            assert_eq!(s.never, [F, T, T, T], "{m:?}");
        },
    );
}

/// `at(k)` reads the same as the arrays, and refuses a k outside `SCORE_KS`.
/// Kills: an off-by-one in the index.
#[test]
fn at_reads_the_metric_for_that_k() {
    let s = score_for(
        Side::Red,
        &[r(1.0, L::N), r(0.995, L::U), r(0.8, L::P)],
        None,
        0.01,
    );
    assert!(s.at(1).expect("k = 1").unjudged);
    assert!(s.at(3).expect("k = 3").never);
    assert!(!s.at(1).expect("k = 1").never);
    assert!(s.at(2).is_none());
}

// ---- Task 10: the rule (design § 4), on constructed inputs -------------------------------------------

const REF: &str = "roster:0.1:0.05";
const P_AXIS: [f64; 8] = [0.08, 0.09, 0.095, 0.1, 0.105, 0.11, 0.12, 0.15];
const Q_AXIS: [f64; 6] = [0.0, 0.02, 0.05, 0.08, 0.1, 0.15];

fn roster_spec(p: f64, q: f64) -> ArmSpec {
    ArmSpec {
        id: format!("roster:{p}:{q}"),
        role: ArmRole::Roster,
        p: Some(p),
        q: Some(q),
        w: None,
    }
}

/// An arm that reads as the metrics say: every position speaks, nothing unjudged.
fn arm_with(spec: ArmSpec, never_1: usize, never_3: usize, pick_3: usize) -> ArmScore {
    ArmScore {
        spec,
        rows: Vec::new(),
        all: Metrics {
            positions: 3,
            speaking: 3,
            never: [never_1, never_3, 0, 0],
            pick: [0, pick_3, 0, 0],
            ..Metrics::default()
        },
        unknown_r_kept: 0,
    }
}

/// A grid of `arms_with` over `ps` x `qs`, `f(p, q)` giving `(never@1, never@3, pick@3)`, plus a
/// `pool_or_roster` arm that would win every key.
fn grid_of(ps: &[f64], qs: &[f64], f: impl Fn(f64, f64) -> (usize, usize, usize)) -> Vec<ArmScore> {
    let mut arms = vec![arm_with(
        ArmSpec {
            id: "pool_or_roster".to_string(),
            role: ArmRole::PoolOrRoster,
            p: None,
            q: None,
            w: None,
        },
        0,
        0,
        99,
    )];
    for q in qs {
        for p in ps {
            let (a, b, c) = f(*p, *q);
            arms.push(arm_with(roster_spec(*p, *q), a, b, c));
        }
    }
    arms
}

fn default_grid(f: impl Fn(f64, f64) -> (usize, usize, usize)) -> Vec<ArmScore> {
    grid_of(&P_AXIS, &Q_AXIS, f)
}

fn pick_of_rule(arms: &[ArmScore]) -> String {
    choose_arm(arms, REF).pick.expect("an arm is readable")
}

/// The first key alone decides: the arm with the fewest `never@1` wins though it is worse on both other
/// keys, and `pool_or_roster` (best on every key) is never selectable.
/// Kills: dropping the first key; the keys read in another order; `pool_or_roster` selectable.
#[test]
fn the_first_key_alone_decides() {
    let arms = default_grid(|p, q| {
        if (p, q) == (0.12, 0.08) {
            (0, 9, 0)
        } else {
            (1, 0, 9)
        }
    });
    let out = choose_arm(&arms, REF);
    assert_eq!(out.pick.as_deref(), Some("roster:0.12:0.08"));
    assert_eq!(out.ties, ["roster:0.12:0.08"]);
    assert_eq!((out.readable, out.roster_arms), (48, 48));
}

/// The second key alone decides, among arms tied on the first, though the other arm has more `pick@3`.
/// Kills: dropping the second key; `never@3` read after `pick@3`.
#[test]
fn the_second_key_alone_decides() {
    let arms = default_grid(|p, q| {
        if (p, q) == (0.09, 0.02) {
            (1, 1, 0)
        } else {
            (1, 2, 9)
        }
    });
    assert_eq!(pick_of_rule(&arms), "roster:0.09:0.02");
}

/// The third key alone decides: most `pick@3` among arms tied on the first two (a larger count wins).
/// Kills: dropping the third key; fewest instead of most.
#[test]
fn the_third_key_alone_decides() {
    let arms = default_grid(|p, q| {
        if (p, q) == (0.11, 0.1) {
            (1, 1, 5)
        } else {
            (1, 1, 4)
        }
    });
    assert_eq!(pick_of_rule(&arms), "roster:0.11:0.1");
}

/// The reference arm is kept when it is among the ties, though an arm with a smaller P ties with it
/// (and, by the steps, is next to it).
/// Kills: a tie-break that skips the reference (smaller P first).
#[test]
fn the_reference_arm_is_kept_when_tied() {
    let arms = default_grid(|p, q| {
        if (p, q) == (0.1, 0.05) || (p, q) == (0.08, 0.05) || (p, q) == (0.105, 0.05) {
            (0, 0, 7)
        } else {
            (1, 1, 7)
        }
    });
    let out = choose_arm(&arms, REF);
    assert_eq!(out.ties.len(), 3);
    assert_eq!(out.pick.as_deref(), Some(REF));
}

/// Not tied with the reference: the fewest grid steps from it, counted in grid indices, not in value.
/// 0.105 (P index 4) is one step from 0.1 (index 3); 0.08 (index 0) is three. Of equal steps, 0.09
/// (index 1, two steps, 0.01 away) beats 0.11 (index 5, two steps) on the smaller P, and an arm at
/// 0.12 (index 6, three steps, 0.02 away) loses to 0.095 (index 2, one step, 0.005 away) either way:
/// the steps are indices, so the spacing of the grid does not enter.
/// Kills: a tie-break by smaller P first; steps measured in value; the larger P on equal steps.
#[test]
fn fewest_grid_steps_when_the_reference_is_not_tied() {
    let tied = |set: &'static [(f64, f64)]| {
        default_grid(move |p, q| {
            if set.contains(&(p, q)) {
                (0, 0, 7)
            } else {
                (1, 1, 7)
            }
        })
    };
    assert_eq!(
        pick_of_rule(&tied(&[(0.08, 0.05), (0.105, 0.05)])),
        "roster:0.105:0.05"
    );
    assert_eq!(
        pick_of_rule(&tied(&[(0.11, 0.05), (0.09, 0.05)])),
        "roster:0.09:0.05"
    );
    assert_eq!(
        pick_of_rule(&tied(&[(0.12, 0.05), (0.095, 0.05)])),
        "roster:0.095:0.05"
    );
    // A step in Q counts as a step in P: (0.1, 0.08) is one step away, (0.12, 0.05) is three.
    assert_eq!(
        pick_of_rule(&tied(&[(0.12, 0.05), (0.1, 0.08)])),
        "roster:0.1:0.08"
    );
}

/// On equal steps the smaller P, then the smaller Q.
/// Kills: the larger P or Q on a tie; a tie left to the arms' order; the Q clause deleted.
#[test]
fn equal_steps_break_to_the_smaller_p_then_the_smaller_q() {
    let tied = |set: &'static [(f64, f64)]| {
        default_grid(move |p, q| {
            if set.contains(&(p, q)) {
                (0, 0, 7)
            } else {
                (1, 1, 7)
            }
        })
    };
    // One step each: (0.105, 0.05) and (0.1, 0.08): the smaller P wins.
    assert_eq!(
        pick_of_rule(&tied(&[(0.105, 0.05), (0.1, 0.08)])),
        "roster:0.1:0.08"
    );
    // One step each, the same P: (0.1, 0.02) and (0.1, 0.08): the smaller Q wins, whichever order the
    // arms come in (`min_by` keeps the first of equals, so the Q clause must decide it).
    let both = tied(&[(0.1, 0.08), (0.1, 0.02)]);
    assert_eq!(pick_of_rule(&both), "roster:0.1:0.02");
    let mut reversed = both;
    reversed.reverse();
    assert_eq!(pick_of_rule(&reversed), "roster:0.1:0.02");
}

/// The same inputs in any order give the same pick and the same ties.
/// Kills: a tie resolved by the arms' order.
#[test]
fn the_tie_is_deterministic() {
    let set: &[(f64, f64)] = &[(0.09, 0.05), (0.11, 0.05), (0.1, 0.02), (0.1, 0.1)];
    let make = || {
        default_grid(|p, q| {
            if set.contains(&(p, q)) {
                (0, 0, 7)
            } else {
                (1, 1, 7)
            }
        })
    };
    let forward = choose_arm(&make(), REF);
    let mut shuffled = make();
    shuffled.reverse();
    shuffled.rotate_left(7);
    let backward = choose_arm(&shuffled, REF);
    assert_eq!(forward.pick, backward.pick);
    assert_eq!(forward.pick.as_deref(), Some("roster:0.1:0.02"));
    let mut a = forward.ties.clone();
    let mut b = backward.ties.clone();
    a.sort();
    b.sort();
    assert_eq!(a, b);
}

/// The pick's edge flag, on all four edges and with the design's wording; none in the interior; none
/// on an axis that has one value.
/// Kills: a missing edge; wording drift; an edge on a one-value axis.
#[test]
fn the_edge_flag_reads_all_four_edges_in_the_designs_words() {
    let at = |ps: &[f64], qs: &[f64], target: (f64, f64)| {
        let arms = grid_of(ps, qs, |p, q| {
            if (p, q) == target {
                (0, 0, 9)
            } else {
                (1, 1, 1)
            }
        });
        choose_arm(&arms, "roster:none:none")
    };
    let texts = |out: &engine_core::reference::tier_b_rule::RuleOutcome| -> Vec<String> {
        out.edge.iter().map(Edge::text).collect()
    };
    // Both tops.
    let out = at(&P_AXIS, &Q_AXIS, (0.15, 0.15));
    assert_eq!(
        texts(&out),
        [
            "on the grid's edge (P = 0.15): read r_by_label and the floor rows before widening",
            "on the grid's edge (Q = 0.15): read r_by_label and the floor rows before widening",
        ]
    );
    assert_eq!(out.edge[0].axis, Axis::P);
    assert_eq!(out.edge[1].side, EdgeSide::Top);
    // Q = 0 at the bottom of Q: the off-role grade is doing no work.
    let out = at(&P_AXIS, &Q_AXIS, (0.1, 0.0));
    assert_eq!(
        texts(&out),
        ["on the grid's edge (Q = 0): the off-role grade is doing no work here"]
    );
    // The bottom of P above zero is an edge of the sweep too; P = 0 says its price does no work.
    assert_eq!(
        texts(&at(&P_AXIS, &Q_AXIS, (0.08, 0.05))),
        ["on the grid's edge (P = 0.08)"]
    );
    assert_eq!(
        texts(&at(&[0.0, 0.1], &Q_AXIS, (0.0, 0.05))),
        ["on the grid's edge (P = 0): the off-pool price is doing no work here"]
    );
    // A bottom edge above zero, on Q too, prints the bare flag with no advice.
    assert_eq!(
        texts(&at(&P_AXIS, &[0.02, 0.1], (0.1, 0.02))),
        ["on the grid's edge (Q = 0.02)"]
    );
    // The interior, and an axis of one value, carry none.
    assert!(at(&P_AXIS, &Q_AXIS, (0.1, 0.05)).edge.is_empty());
    assert_eq!(
        texts(&at(&[0.1], &Q_AXIS, (0.1, 0.15))),
        ["on the grid's edge (Q = 0.15): read r_by_label and the floor rows before widening"]
    );
}

/// An arm with every key best but a silent position is not readable.
/// Kills: `readable` ignoring a position that does not speak.
#[test]
fn an_arm_where_a_position_does_not_speak_is_not_readable() {
    let mut arms = default_grid(|_, _| (2, 2, 2));
    arms[1].all.speaking = 2;
    arms[1].all.never = [0, 0, 0, 0];
    arms[1].all.pick = [0, 9, 0, 0];
    let out = choose_arm(&arms, REF);
    assert_eq!(out.readable, 47);
    assert_ne!(out.pick.as_deref(), Some(arms[1].spec.id.as_str()));
}

/// `unjudged@3 = 0` with `unjudged@1 > 0` is not readable, and with `unjudged@3 > 0` and `unjudged@1 =
/// 0` neither. Each arm has the best keys.
/// Kills: `readable` reading only @3; reading only @1.
#[test]
fn readable_needs_both_unjudged_counts_at_zero() {
    for (u1, u3) in [(1, 0), (0, 1), (1, 1)] {
        let mut arms = default_grid(|_, _| (2, 2, 2));
        arms[5].all.never = [0, 0, 0, 0];
        arms[5].all.pick = [0, 9, 0, 0];
        arms[5].all.unjudged = [u1, u3, 0, 0];
        let out = choose_arm(&arms, REF);
        assert_eq!(out.readable, 47, "{u1} {u3}");
        assert_ne!(
            out.pick.as_deref(),
            Some(arms[5].spec.id.as_str()),
            "{u1} {u3}"
        );
    }
}

/// No readable arm: the rule says so (no pick, no receipt, no edge), however good `pool_or_roster` is.
/// Kills: a pick among unreadable arms; `pool_or_roster` selectable.
#[test]
fn no_readable_arm_says_so() {
    let mut arms = default_grid(|_, _| (0, 0, 9));
    for a in &mut arms {
        a.all.unjudged = [1, 1, 0, 0];
    }
    let out = choose_arm(&arms, REF);
    assert_eq!(out.readable, 0);
    assert_eq!(out.roster_arms, 48);
    assert!(out.pick.is_none() && out.ties.is_empty() && out.edge.is_empty());
    assert!(out.receipt.is_none());
}

// ---- positions built from rankings -----------------------------------------------------------------

fn act(n: u8) -> Action {
    Action::Pick(ChampionIdx(n))
}

fn opt(n: u8) -> OptionKey {
    OptionKey {
        action: act(n),
        comp: None,
    }
}

/// A position whose `arms` are `(arm id, [(champion, strength)])`, strength best-first (the mover's
/// view: a Red value is the negated strength). An empty list is a position that does not speak at that
/// arm. Both folds read `labels`; champion `own` is the own pick.
fn rpos(
    id: &str,
    draft: &str,
    mover: Side,
    stable: Option<bool>,
    labels: &[(u8, Label)],
    own: Option<u8>,
    arms: &[(&str, &[(u8, f64)])],
) -> PositionInput {
    let sign = if mover == Side::Blue { 1.0 } else { -1.0 };
    let labels: HashMap<OptionKey, Label> = labels.iter().map(|(c, l)| (opt(*c), *l)).collect();
    let fold = Fold {
        labels: labels.clone(),
        own_pick: own.map(act),
    };
    PositionInput {
        id: id.to_string(),
        draft: draft.to_string(),
        mover,
        stable,
        rule: fold.clone(),
        current: fold,
        label_fallbacks: 0,
        pick_fallback: false,
        lines: HashMap::new(),
        arms: arms
            .iter()
            .map(|(arm, list)| ArmInput {
                id: arm.to_string(),
                speaks: !list.is_empty(),
                ranking: list
                    .iter()
                    .map(|(c, v)| ScoredAction {
                        action: act(*c),
                        value: sign * v,
                        option: labels.contains_key(&opt(*c)).then(|| opt(*c)),
                        in_pool: true,
                        class: TopClassName::InPool,
                        opponent_charge: 0.0,
                    })
                    .collect(),
                own_in_pool: own.map(|o| (act(o), true)).into_iter().collect(),
                top_line: None,
                unknown_r_kept: 0,
            })
            .collect(),
        unlabelled_rows: Vec::new(),
        r_labels: Vec::new(),
        reveal: RevealRead::default(),
        split: CorpusSplit::Development,
    }
}

/// c0 is the `never`; every other champion is a `play`.
const LABELS: [(u8, Label); 6] = [
    (0, Label::Never),
    (1, Label::Play),
    (2, Label::Play),
    (3, Label::Play),
    (4, Label::Play),
    (5, Label::Play),
];

/// The `never` first: `never@1` and `never@3`. The own pick c2 is at rank 2.
const BAD_C2_AT_2: [(u8, f64); 6] = [(0, 1.0), (2, 0.5), (1, 0.4), (3, 0.3), (4, 0.2), (5, 0.1)];
/// The `never` first again; the own pick at rank 5.
const BAD_C2_AT_5: [(u8, f64); 6] = [(0, 1.0), (1, 0.5), (3, 0.4), (4, 0.3), (2, 0.2), (5, 0.1)];
/// Three plays above the `never`; the own pick at rank 5 (out of the top 3).
const GOOD_C2_AT_5: [(u8, f64); 6] = [(1, 1.0), (3, 0.9), (4, 0.8), (5, 0.7), (2, 0.6), (0, 0.1)];
/// Three plays above the `never`; the own pick at rank 2.
const GOOD_C2_AT_2: [(u8, f64); 6] = [(1, 1.0), (2, 0.9), (3, 0.8), (4, 0.7), (5, 0.6), (0, 0.1)];

const ARM_A: &str = "roster:0.1:0.05";
const ARM_B: &str = "roster:0.15:0.05";

fn specs_ab() -> Vec<ArmSpec> {
    vec![roster_spec(0.1, 0.05), roster_spec(0.15, 0.05)]
}

fn refs(ps: &[PositionInput]) -> Vec<&PositionInput> {
    ps.iter().collect()
}

/// The rule reads the blind fold, not the current one: the label of c0 is `never` blind and `play`
/// current, so arm A (the `never` first) has `never@1` on the rule's fold and not on the current one,
/// and the rule picks B; the second line, on the current fold, keeps the reference arm A and is
/// flagged.
/// Kills: reading the current fold for the rule; a second line that is the first.
#[test]
fn the_rule_reads_the_blind_fold_not_the_current_one() {
    for mover in [Side::Blue, Side::Red] {
        let mut p = rpos(
            "p",
            "d",
            mover,
            None,
            &LABELS,
            None,
            &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
        );
        p.current.labels.insert(opt(0), Label::Play);
        let ps = [p];
        let arms = read_arms(&refs(&ps), &specs_ab(), FoldKind::Rule, 0.01);
        assert_eq!(arms[0].all.never[0], 1, "{mover:?}");
        let current = read_arms(&refs(&ps), &specs_ab(), FoldKind::Current, 0.01);
        assert_eq!(current[0].all.never[0], 0, "{mover:?}");
        let read = read_run(&refs(&ps), &specs_ab(), ARM_A, 0.01, false);
        assert_eq!(read.rule.pick.as_deref(), Some(ARM_B), "{mover:?}");
        assert_eq!(
            read.second_line.outcome.pick.as_deref(),
            Some(ARM_A),
            "{mover:?}"
        );
        assert!(read.second_line.differs, "{mover:?}");
    }
}

/// Folds that agree give a second line that is not flagged, and the fallback counts add up.
/// Kills: a flag that is always on.
#[test]
fn the_second_line_is_flagged_only_when_the_pick_differs() {
    let mut p = rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &LABELS,
        None,
        &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
    );
    p.label_fallbacks = 2;
    p.pick_fallback = true;
    let q = rpos(
        "q",
        "d",
        Side::Blue,
        None,
        &LABELS,
        None,
        &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
    );
    let ps = [p, q];
    let read = read_run(&refs(&ps), &specs_ab(), ARM_A, 0.01, false);
    assert!(!read.second_line.differs);
    assert_eq!(read.second_line.outcome.pick, read.rule.pick);
    assert_eq!((read.fallbacks.labels, read.fallbacks.picks), (2, 1));
}

/// Codex's case at a position with arms A and B: A reads `[N 1.000, U 0.995, P 0.800]` (certain at k = 3,
/// unjudged at k = 1) and so looks best on `never@1` (0) but is not readable; B (all labelled, with a
/// `never@1` of one) is the only readable arm and is picked.
/// Kills: `readable` reading only `unjudged@3`.
#[test]
fn an_arm_unjudged_at_one_and_certain_at_three_is_not_readable() {
    let labels = [(0, Label::Never), (2, Label::Play), (3, Label::Play)];
    let p = rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &labels,
        None,
        &[
            (ARM_A, &[(0, 1.0), (1, 0.995), (2, 0.8)]),
            (ARM_B, &[(0, 1.0), (2, 0.5), (3, 0.4)]),
        ],
    );
    let ps = [p];
    let arms = read_arms(&refs(&ps), &specs_ab(), FoldKind::Rule, 0.01);
    assert_eq!(arms[0].all.unjudged, [1, 0, 0, 0]);
    assert_eq!(arms[0].all.never, [0, 1, 1, 1]);
    assert!(!arms[0].readable());
    assert!(arms[1].readable());
    let out = choose_arm(&arms, ARM_A);
    assert_eq!((out.readable, out.pick.as_deref()), (1, Some(ARM_B)));
}

/// Never selectable: a floor row and `pool_or_roster` read the same positions through the same seam,
/// and are never picked even where they read best.
/// Kills: a floor row or `pool_or_roster` chosen by the rule; floor rows left unscored.
#[test]
fn a_floor_row_is_scored_through_the_seam_and_never_selected() {
    let mut p = rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &LABELS,
        None,
        &[
            (ARM_A, &BAD_C2_AT_2),
            (ARM_B, &BAD_C2_AT_2),
            ("pool_or_roster", &GOOD_C2_AT_2),
        ],
    );
    let mut floor = p.arms[2].clone();
    floor.id = "floor:0.25".to_string();
    p.arms.push(floor);
    let mut specs = specs_ab();
    specs.push(ArmSpec {
        id: "pool_or_roster".to_string(),
        role: ArmRole::PoolOrRoster,
        p: None,
        q: None,
        w: None,
    });
    specs.push(ArmSpec {
        id: "floor:0.25".to_string(),
        role: ArmRole::Floor,
        p: None,
        q: None,
        w: None,
    });
    let ps = [p];
    let read = read_run(&refs(&ps), &specs, ARM_A, 0.01, false);
    // A good ranking: the `never` is last, clear only at k = 10.
    assert_eq!(
        read.arms[3].all.never,
        [0, 0, 0, 1],
        "the floor row is scored"
    );
    assert_eq!(read.arms[3].all.never, read.arms[2].all.never);
    assert_eq!(read.arms[3].all.speaking, 1);
    assert_eq!(read.rule.readable, 2);
    assert_eq!(read.rule.roster_arms, 2);
    assert_eq!(read.rule.pick.as_deref(), Some(ARM_A));
}

/// The receipt says what the move does, from the reference to the pick: `never@1 2 -> 0`, `pick@3 2 ->
/// 2`, and names own picks that leave the top 3 (p1) and enter it (p2), with the position whose depth
/// check did not hold (p1) counted apart from the rest.
/// Kills: from and to swapped; the leaving set not named; the unstable split mixed into the rest.
#[test]
fn the_receipt_reads_from_the_reference_to_the_pick() {
    for mover in [Side::Blue, Side::Red] {
        let mk = |id: &str, stable, a: &[(u8, f64)], b: &[(u8, f64)]| {
            rpos(
                id,
                "d",
                mover,
                stable,
                &LABELS,
                Some(2),
                &[(ARM_A, a), (ARM_B, b)],
            )
        };
        let ps = [
            mk("p1", Some(false), &BAD_C2_AT_2, &GOOD_C2_AT_5),
            mk("p2", Some(true), &BAD_C2_AT_5, &GOOD_C2_AT_2),
            mk("p3", None, &GOOD_C2_AT_2, &GOOD_C2_AT_2),
        ];
        let arms = read_arms(&refs(&ps), &specs_ab(), FoldKind::Rule, 0.01);
        let out = choose_arm(&arms, ARM_A);
        assert_eq!(out.pick.as_deref(), Some(ARM_B), "{mover:?}");
        let r = out.receipt.expect("a pick has a receipt");
        assert_eq!((r.reference.as_str(), r.pick.as_str()), (ARM_A, ARM_B));
        assert_eq!((r.from.never[0], r.to.never[0]), (2, 0), "{mover:?}");
        assert_eq!((r.from.never[1], r.to.never[1]), (2, 0), "{mover:?}");
        assert_eq!((r.from.pick[1], r.to.pick[1]), (2, 2), "{mover:?}");
        assert_eq!(r.leaves_top_3, ["p1"], "{mover:?}");
        assert_eq!(r.enters_top_3, ["p2"], "{mover:?}");
        assert_eq!(r.unstable.positions, ["p1"]);
        assert_eq!((r.unstable.from.never[0], r.unstable.to.never[0]), (1, 0));
        assert_eq!(r.stable.positions, ["p2", "p3"]);
        assert_eq!((r.stable.from.never[0], r.stable.to.never[0]), (1, 0));
        assert_eq!((r.stable.from.pick[1], r.stable.to.pick[1]), (1, 2));
    }
}

/// The sensitivity line re-scores at the two other margins. Arm A has `[N 1.000, P 0.993, ...]`: at
/// 0.02 and the run's 0.01 the play is inside the margin (no clear `never@1`, A keeps the more
/// `pick@3`); at 0.005 it is outside and A has a clear `never@1`, so B wins. The pick at 0.005 is not
/// the pick at 0.02, and the order of the list is (0.005, 0.02).
/// Kills: sensitivity re-using the main scoring; the margins swapped or ignored.
#[test]
fn sensitivity_re_scores_at_the_other_margins() {
    let a: &[(u8, f64)] = &[(0, 1.0), (1, 0.993), (2, 0.5), (3, 0.4), (4, 0.3), (5, 0.2)];
    let b: &[(u8, f64)] = &[(1, 1.0), (0, 0.9), (3, 0.8), (4, 0.7), (2, 0.6), (5, 0.5)];
    let ps = [rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &LABELS,
        Some(2),
        &[(ARM_A, a), (ARM_B, b)],
    )];
    let read = read_run(&refs(&ps), &specs_ab(), ARM_A, 0.01, false);
    assert_eq!(read.rule.pick.as_deref(), Some(ARM_A));
    assert_eq!(
        read.sensitivity.margins,
        [
            (0.005, Some(ARM_B.to_string())),
            (0.02, Some(ARM_A.to_string()))
        ]
    );
}

/// Leave-one-draft-out re-sums without that draft: A has the `never` first at d1, B at d2 and d3, so on
/// the whole A wins 1 to 2; without d1 A wins on 0 to 2; without d2 (or d3) they tie at 1 and the
/// reference arm (B) is kept. The drafts are listed in order.
/// Kills: a leave-out that keeps the draft; the reference not kept on the tie.
#[test]
fn sensitivity_leaves_each_draft_out_in_turn() {
    let good = &GOOD_C2_AT_2[..];
    let bad = &BAD_C2_AT_2[..];
    let mk = |id: &str, draft: &str, a: &[(u8, f64)], b: &[(u8, f64)]| {
        rpos(
            id,
            draft,
            Side::Blue,
            None,
            &LABELS,
            None,
            &[(ARM_A, a), (ARM_B, b)],
        )
    };
    let ps = [
        mk("p1", "d1", bad, good),
        mk("p2", "d2", good, bad),
        mk("p3", "d3", good, bad),
    ];
    let read = read_run(&refs(&ps), &specs_ab(), ARM_B, 0.01, false);
    assert_eq!(read.rule.pick.as_deref(), Some(ARM_A));
    assert_eq!(
        read.sensitivity.leave_out,
        [
            ("d1".to_string(), Some(ARM_A.to_string())),
            ("d2".to_string(), Some(ARM_B.to_string())),
            ("d3".to_string(), Some(ARM_B.to_string())),
        ]
    );
}

/// With no readable arm the worklist names what is left: the unlabelled rows per position, and the #1
/// lines (at the reference arm here) with no verdict.
/// Kills: a worklist that is empty without a pick.
#[test]
fn no_readable_arm_names_the_worklist() {
    let labels = [(0, Label::Never), (2, Label::Play)];
    let mut p = rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &labels,
        None,
        &[
            (ARM_A, &[(0, 1.0), (1, 0.995), (2, 0.8)]),
            (ARM_B, &[(1, 1.0), (2, 0.5)]),
        ],
    );
    p.unlabelled_rows = vec!["c1".to_string(), "c7".to_string()];
    p.arms[0].top_line = Some(TopLine {
        option: opt(0),
        option_id: "c0".to_string(),
        line: "Zyra > Karma+Lulu".to_string(),
    });
    let ps = [p];
    let read = read_run(&refs(&ps), &specs_ab(), ARM_A, 0.01, false);
    assert_eq!(read.rule.readable, 0);
    assert!(read.rule.pick.is_none());
    assert_eq!(
        read.worklist.unlabelled_rows,
        [("p".to_string(), vec!["c1".to_string(), "c7".to_string()])]
    );
    assert_eq!(read.worklist.lines_at.as_deref(), Some(ARM_A));
    assert_eq!(read.worklist.unjudged_lines.len(), 1);
    assert_eq!(read.worklist.unjudged_lines[0].line, "Zyra > Karma+Lulu");
}

/// `bad_line@1` is "bad of judged", keyed by the exact (option, line): a #1 whose line has a verdict
/// counts judged (and bad when `ok` is false); the same line on another option, or another line on the
/// same option, is unjudged and reads as such, not as a good line; the canonical text sorts each turn's
/// champions, so a pair written in the other order still matches.
/// Kills: a bad count that treats unjudged as good; a match on the line alone or the option alone.
#[test]
fn bad_line_reads_bad_of_judged_by_option_and_line() {
    let mut p = rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &LABELS,
        None,
        &[
            (ARM_A, &GOOD_C2_AT_2),
            (ARM_B, &GOOD_C2_AT_2),
            ("third", &GOOD_C2_AT_2),
            ("fourth", &GOOD_C2_AT_2),
        ],
    );
    let top = |option: u8, line: &str| {
        Some(TopLine {
            option: opt(option),
            option_id: format!("c{option}"),
            line: line.to_string(),
        })
    };
    p.lines
        .insert((opt(1), canonical_line("Lulu+Karma > Zyra")), false);
    p.arms[0].top_line = top(
        1,
        &line_text(&[vec!["Lulu".into(), "Karma".into()], vec!["Zyra".into()]]),
    );
    p.arms[1].top_line = top(1, "Zyra");
    p.arms[2].top_line = top(2, "Karma+Lulu > Zyra");
    let mut specs = specs_ab();
    for id in ["third", "fourth"] {
        specs.push(roster_spec(0.2, if id == "third" { 0.1 } else { 0.2 }));
        specs.last_mut().expect("just pushed").id = id.to_string();
    }
    let ps = [p];
    let arms = read_arms(&refs(&ps), &specs, FoldKind::Rule, 0.01);
    assert_eq!(arms[0].rows[0].line, LineState::Bad);
    assert_eq!(
        (
            arms[0].all.bad_line,
            arms[0].all.judged_line,
            arms[0].all.unjudged_line
        ),
        (1, 1, 0)
    );
    assert_eq!(
        arms[1].rows[0].line,
        LineState::Unjudged,
        "another line, the same option"
    );
    assert_eq!(
        (
            arms[1].all.bad_line,
            arms[1].all.judged_line,
            arms[1].all.unjudged_line
        ),
        (0, 0, 1)
    );
    assert_eq!(
        arms[2].rows[0].line,
        LineState::Unjudged,
        "the same line, another option"
    );
    assert_eq!(arms[3].rows[0].line, LineState::None, "no #1 line read");
    assert_eq!(canonical_line("Lulu+Karma > Zyra"), "Karma+Lulu > Zyra");
    assert_eq!(canonical_line(""), "");
    assert_eq!(line_text(&[]), "");
}

/// `never_everywhere` names the positions with a clear `never` at #1 at every readable arm; an
/// unreadable arm does not count, and with no readable arm it is empty.
/// Kills: reading any arm instead of every one; counting unreadable arms.
#[test]
fn never_everywhere_needs_every_readable_arm() {
    let mk = |id: &str, a: &[(u8, f64)], b: &[(u8, f64)], c: &[(u8, f64)]| {
        rpos(
            id,
            "d",
            Side::Blue,
            None,
            &LABELS,
            None,
            &[(ARM_A, a), (ARM_B, b), ("roster:0.2:0.05", c)],
        )
    };
    let bad = &BAD_C2_AT_2[..];
    let good = &GOOD_C2_AT_2[..];
    let ps = [
        mk("stuck", bad, bad, bad),
        mk("fixable", bad, bad, good),
        mk("fine", good, good, good),
    ];
    let mut specs = specs_ab();
    specs.push(roster_spec(0.2, 0.05));
    let read = read_run(&refs(&ps), &specs, ARM_A, 0.01, false);
    assert_eq!(read.never_everywhere, ["stuck"]);
    // An arm that is not readable (a silent position) does not hold `fixable` back.
    let mut quiet = mk("fine", good, good, &[]);
    quiet.id = "fine".to_string();
    let ps = [
        mk("stuck", bad, bad, bad),
        mk("fixable", bad, bad, bad),
        quiet,
    ];
    let read = read_run(&refs(&ps), &specs, ARM_A, 0.01, false);
    assert_eq!(read.never_everywhere, ["stuck", "fixable"]);
    // No readable arm, no list.
    let ps = [mk("only", bad, bad, &[])];
    let read = read_run(&refs(&ps), &[roster_spec(0.2, 0.05)], ARM_A, 0.01, false);
    assert!(read.never_everywhere.is_empty());
}

/// `r_by_label`'s buckets and their edges: below 0.1, below 0.25, below 0.5, below 1, exactly 1,
/// unknown; the counts add per label in the order play, maybe, never.
/// Kills: a boundary off by one bucket; unknown folded into a bucket.
#[test]
fn r_by_label_buckets_and_sums() {
    assert_eq!(RBucket::of(Some(0.0999)), RBucket::Below10);
    assert_eq!(RBucket::of(Some(0.1)), RBucket::Below25);
    assert_eq!(RBucket::of(Some(0.2499)), RBucket::Below25);
    assert_eq!(RBucket::of(Some(0.25)), RBucket::Below50);
    assert_eq!(RBucket::of(Some(0.5)), RBucket::Below100);
    assert_eq!(RBucket::of(Some(0.9999)), RBucket::Below100);
    assert_eq!(RBucket::of(Some(1.0)), RBucket::One);
    assert_eq!(RBucket::of(None), RBucket::Unknown);
    let mut p = rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &LABELS,
        None,
        &[(ARM_A, &GOOD_C2_AT_2)],
    );
    p.r_labels = vec![
        (RBucket::Below25, Label::Never),
        (RBucket::Below25, Label::Never),
        (RBucket::Below25, Label::Play),
        (RBucket::Unknown, Label::Maybe),
        (RBucket::One, Label::Play),
    ];
    let ps = [p];
    let read = read_run(&refs(&ps), &[roster_spec(0.1, 0.05)], ARM_A, 0.01, false);
    assert_eq!(read.r_by_label.counts[1], [1, 0, 2]);
    assert_eq!(read.r_by_label.counts[5], [0, 1, 0]);
    assert_eq!(read.r_by_label.counts[4], [1, 0, 0]);
    assert_eq!(read.r_by_label.counts[0], [0, 0, 0]);
}

/// `reveal_changes` lists the labels and own picks that differ between the folds over those given
/// blind, and the revealed drafts where nothing changed; a draft never revealed is in neither list.
/// Kills: counting an unrevealed draft; a changed label read as no change.
#[test]
fn reveal_changes_lists_differences_and_quiet_reveals() {
    let mk = |id: &str, draft: &str, revealed: bool| {
        let mut p = rpos(
            id,
            draft,
            Side::Blue,
            None,
            &LABELS,
            None,
            &[(ARM_A, &GOOD_C2_AT_2)],
        );
        p.reveal = RevealRead {
            revealed,
            blind_labels: 3,
            blind_pick: true,
            ..RevealRead::default()
        };
        p
    };
    let mut changed = mk("a1", "d1", true);
    changed.reveal.label_changes = vec![LabelChange {
        option: "c1".to_string(),
        blind: Label::Never,
        current: Label::Play,
    }];
    let mut picked = mk("a2", "d1", false);
    picked.reveal.pick_change = Some(PickChange {
        blind: Some("c2".to_string()),
        current: None,
    });
    let ps = [changed, picked, mk("b1", "d2", true), mk("c1", "d3", false)];
    let read = read_run(&refs(&ps), &[roster_spec(0.1, 0.05)], ARM_A, 0.01, false);
    let rc = &read.reveal_changes;
    assert_eq!(rc.labels.len(), 1);
    assert_eq!(rc.picks.len(), 1);
    assert_eq!((rc.blind_labels, rc.blind_picks), (12, 4));
    assert_eq!(rc.drafts_revealed, ["d1", "d2"]);
    assert_eq!(rc.reveals_without_change, ["d2"]);
}

// ---- Task 10: the runner's half --------------------------------------------------------------------

/// The opponent's charge is its off-pool count x P plus its grade x Q/100, for the right side, and
/// never carries the infeasibility band: an infeasible end (whose `L'` is in the value) charges the
/// same as a feasible one with the same counts.
/// Kills: a band folded into the charge; Blue's counts read for a Blue mover; Q read as per unit
/// instead of per 100.
#[test]
fn the_opponent_charge_leaves_the_infeasibility_band_out() {
    let end = |red_feasible| LeafEnd {
        kind: LeafKind::Horizon,
        blue_feasible: true,
        red_feasible,
        blue_off_pool: 1,
        red_off_pool: 2,
        blue_grade: 30,
        red_grade: 150,
    };
    let price = Price::of(0.1, 0.05);
    let red_side = 2.0 * 0.1 + 150.0 * 0.0005;
    assert!((opponent_charge(&end(true), Side::Blue, price) - red_side).abs() < 1e-12);
    assert_eq!(
        opponent_charge(&end(false), Side::Blue, price),
        opponent_charge(&end(true), Side::Blue, price),
        "an infeasible end charges its counts only"
    );
    assert!(opponent_charge(&end(false), Side::Blue, price) < 1.0);
    let blue_side = 1.0 * 0.1 + 30.0 * 0.0005;
    assert!((opponent_charge(&end(true), Side::Red, price) - blue_side).abs() < 1e-12);
    assert_eq!(opponent_charge(&end(true), Side::Blue, Price::ZERO), 0.0);
}

/// The labelled position's ranking at one input, as the ids of the entries that resolved an option.
fn resolved_ids(a: &ArmInput, u: &Universe) -> BTreeSet<String> {
    a.ranking
        .iter()
        .filter_map(|e| e.option.as_ref().map(|k| k.id(u)))
        .collect()
}

/// What the rule reads is the whole ranking, kept before the catalog prunes anything: at every arm the
/// ranking holds every searched action (the rows are a tenth of it), `option` is resolved for the three
/// labelled options (the arrangement at that arm's price gives the labelled comp), and the floor rows
/// follow the arms.
/// Kills: a ranking pruned to the catalog's rows; a trace that resolves no option; arms and floor rows
/// out of order.
#[test]
fn the_rule_reads_every_arms_whole_ranking_with_its_options_resolved() {
    let live = live();
    let run = run_of(&[labelled()], &review_config(), &live);
    let p = &run.positions[0];
    let ids: Vec<&str> = p.scoring.arms.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "pool_or_roster",
            "roster:0.02:0",
            "roster:0.1:0",
            "roster:0.02:0.05",
            "roster:0.1:0.05",
            "floor:0.1",
            "floor:0.25"
        ]
    );
    let labelled_ids: BTreeSet<String> = [OPT_A, OPT_B, OPT_C].map(String::from).into();
    for reading in &p.readings {
        let input = p
            .scoring
            .arms
            .iter()
            .find(|a| a.id == reading.arm)
            .expect("an input per arm");
        assert!(input.speaks);
        assert_eq!(
            Some(input.ranking.len()),
            reading.searched,
            "{}",
            reading.arm
        );
        assert!(
            input.ranking.len() > 10 * reading.ranked.len(),
            "{}",
            reading.arm
        );
        assert_eq!(
            resolved_ids(input, &live.universe),
            labelled_ids,
            "{}",
            reading.arm
        );
    }
    assert!(p.scoring.arms[5..].iter().all(|a| a.speaks));
}

/// A label whose comp differs from the arm's arrangement reads unlabelled at every arm (the fail-safe):
/// with option A's comp written the other way round, no entry of that action resolves an option at any
/// arm, while B and C still do.
/// Kills: a label carried to another arrangement; the action matched without its comp.
#[test]
fn an_arrangement_that_differs_from_the_labelled_comp_reads_unlabelled_in_the_rule() {
    let live = live();
    let swapped = "Galio+MonkeyKing|top=Rumble,jungle=Galio,mid=MonkeyKing";
    let mut file = labelled();
    rename_label(&mut file, 0, OPT_A, swapped);
    let run = run_of(&[file], &review_config(), &live);
    let p = &run.positions[0];
    let wanted: BTreeSet<String> = [OPT_B, OPT_C].map(String::from).into();
    for a in &p.scoring.arms {
        assert_eq!(resolved_ids(a, &live.universe), wanted, "{}", a.id);
    }
    // The label itself is in the rule's labels as written; no ranked entry resolves to it (above).
    let original = loaded(&labelled(), &live);
    let (root, picks) = root_and_picks(&original.fixture, &live.universe);
    let key =
        OptionKey::parse(swapped, root, &picks, &live.universe).expect("the swapped id parses");
    assert!(p.scoring.rule.labels.contains_key(&key));
}

/// The rule's fold is blind with a per-option fallback to current, and counts the fallbacks: the labelled
/// position holds B `never` blind and `maybe` after, and C `play` only after, so the rule reads B `never`
/// and C `play` (one fallback) while the current fold reads B `maybe`; the reveal record lists the one
/// change over the two blind labels.
/// Kills: the rule fold reading the current labels; no fallback to current; an uncounted fallback.
#[test]
fn the_rule_fold_is_blind_with_a_counted_fallback_to_current() {
    let live = live();
    let run = run_of(&[labelled()], &review_config(), &live);
    let sc = &run.positions[0].scoring;
    let u = &live.universe;
    let by_id = |m: &HashMap<OptionKey, Label>| -> HashMap<String, Label> {
        m.iter().map(|(k, v)| (k.id(u), *v)).collect()
    };
    let rule = by_id(&sc.rule.labels);
    let current = by_id(&sc.current.labels);
    assert_eq!(rule[OPT_A], Label::Play);
    assert_eq!(rule[OPT_B], Label::Never);
    assert_eq!(rule[OPT_C], Label::Play);
    assert_eq!(current[OPT_B], Label::Maybe);
    assert_eq!(sc.label_fallbacks, 1);
    assert!(!sc.pick_fallback);
    assert_eq!(
        sc.rule.own_pick,
        Some(pick_of(&live, "MonkeyKing", "Galio"))
    );
    assert!(sc.reveal.revealed);
    assert_eq!(sc.reveal.blind_labels, 2);
    assert_eq!(
        sc.reveal.label_changes,
        [LabelChange {
            option: OPT_B.to_string(),
            blind: Label::Never,
            current: Label::Maybe
        }]
    );
    assert!(sc.reveal.pick_change.is_none());
    assert_eq!(run.read.fallbacks.labels, 1);
    // Unlabelled rows: every row not in the rule fold, none that is.
    let p = normalised(&run)["positions"][0].clone();
    let rows: BTreeSet<String> = p["options"]
        .as_object()
        .expect("options")
        .iter()
        .filter(|(_, o)| o["row"] == true)
        .map(|(id, _)| id.clone())
        .filter(|id| !rule.contains_key(id))
        .collect();
    assert_eq!(
        sc.unlabelled_rows.iter().cloned().collect::<BTreeSet<_>>(),
        rows
    );
    assert!(!rows.is_empty());
    // No arm is readable on this corpus (every #1 is unlabelled), and the worklist says what is left.
    assert_eq!(run.read.rule.readable, 0);
    assert_eq!(run.read.worklist.unlabelled_rows.len(), 1);
    assert_eq!(run.read.worklist.lines_at.as_deref(), Some(REFERENCE_ARM));
    assert_eq!(run.read.worklist.unjudged_lines.len(), 1);
}

/// The 09-29 supp-17 position, small: the reference arm and `pool_or_roster` only.
fn supp_config() -> ReviewConfig {
    ReviewConfig {
        ps: vec![0.1],
        qs: vec![0.05],
        ..review_config()
    }
}

fn supp_17() -> Value {
    review_data("unlabelled/2026-09-29-supp-pinch-slot-17-dme.json")
}

/// The opponent's charge in the rankings the rule reads is its off-pool count x P plus its grade x Q/100
/// at the arm's price, for every ranked action, the rows whose leaf ends are infeasible included (45 of
/// them here, whose band is in the value, about 1 here, and not in the charge).
/// Kills: the band left in the charge; a charge at the wrong price; the wrong side's counts.
#[test]
fn the_runner_charges_the_opponent_its_counts_and_leaves_the_band_out() {
    let live = live();
    let run = run_of(&[supp_17()], &supp_config(), &live);
    let p = &run.positions[0];
    let (mut checked, mut infeasible) = (0, 0);
    for reading in &p.readings {
        let (pp, q) = match reading.arm.as_str() {
            "pool_or_roster" => (live.universe.off_pool_cost(), 0.0),
            REFERENCE_ARM => (0.1, 0.05),
            other => panic!("{other}"),
        };
        let input = p
            .scoring
            .arms
            .iter()
            .find(|a| a.id == reading.arm)
            .expect("an input per arm");
        for row in &reading.ranked {
            let action = &p.options[&row.option].action;
            let entry = input
                .ranking
                .iter()
                .find(|e| {
                    let ids: Vec<String> = e
                        .action
                        .champions()
                        .map(|c| live.universe.id(c).to_string())
                        .collect();
                    &ids == action && e.value == row.value
                })
                .expect("the row's action is in the whole ranking");
            // The mover is Blue: the opponent is Red.
            let expected =
                row.ends.red_off_pool as f64 * pp + row.ends.red_grade as f64 * q / 100.0;
            assert!(
                (entry.opponent_charge - expected).abs() < 1e-12,
                "{} {action:?}: {} vs {expected}",
                reading.arm,
                entry.opponent_charge
            );
            checked += 1;
            infeasible += usize::from(!row.ends.red_feasible || !row.ends.blue_feasible);
        }
    }
    assert!(checked > 20);
    assert!(infeasible > 0, "the test must include infeasible ends");
    for a in &p.scoring.arms {
        assert!(a
            .ranking
            .iter()
            .all(|e| (0.0..1.0).contains(&e.opponent_charge)));
    }
}

const F5: &str = "Syndra+Ziggs|top=Camille,jungle=LeeSin,mid=Syndra,adc=Ziggs,support=Galio";

/// The floor rows trace every action of the reference ranking, so a moved locked pick counts: at the
/// reference arm the #1 is `Syndra+Ziggs` with the locked Galio moved to support (r 0.176, the only
/// off-pool placement, the action's own champions in-pool), so a floor that read the action's own
/// placements would keep it at both cut-offs. The 0.10 floor keeps it (0.176 is above) and the 0.25
/// floor removes it; each floor's ranking is the reference's with options removed, in the same order,
/// and the 0.25 floor is shorter than the 0.10 one.
/// Kills: a floor that ignores locked picks; a floor read from the action's placements alone; the
/// wrong cut-off; a reordered ranking.
#[test]
fn the_floor_rows_remove_an_option_that_moves_a_locked_pick() {
    let live = live();
    let run = run_of(&[supp_17()], &supp_config(), &live);
    let p = &run.positions[0];
    let side = &p.options[F5].side;
    let off_pool: Vec<(&str, bool)> = side
        .iter()
        .filter(|s| !s.in_pool)
        .map(|s| (s.champion.as_str(), s.locked))
        .collect();
    assert_eq!(
        off_pool,
        [("Galio", true)],
        "the only off-pool placement is the moved locked pick"
    );
    let r = side
        .iter()
        .find(|s| s.champion == "Galio")
        .and_then(|s| s.r)
        .expect("a known r");
    assert!(r > 0.10 && r < 0.25, "{r}");
    let input = |id: &str| p.scoring.arms.iter().find(|a| a.id == id).expect(id);
    let (reference, f10, f25) = (
        input(REFERENCE_ARM),
        input("floor:0.1"),
        input("floor:0.25"),
    );
    let first = |a: &ArmInput| a.top_line.as_ref().map(|t| t.option_id.clone());
    assert_eq!(first(reference).as_deref(), Some(F5));
    assert_eq!(first(f10).as_deref(), Some(F5));
    assert_ne!(first(f25).as_deref(), Some(F5));
    assert!(reference.ranking.len() > f10.ranking.len());
    assert!(f10.ranking.len() > f25.ranking.len());
    // Each floor is a subsequence of the reference ranking.
    for f in [f10, f25] {
        let mut at = reference.ranking.iter().map(|e| e.action);
        assert!(
            f.ranking.iter().all(|e| at.any(|a| a == e.action)),
            "{}",
            f.id
        );
        assert!(f.speaks);
        assert_eq!(f.unknown_r_kept, 0);
    }
    // A floor is scored through the seam: it has a row in the read.
    let read = &run.read;
    assert_eq!(read.arms.len(), 4);
    assert_eq!(read.arms[3].spec.id, "floor:0.25");
    assert_eq!(read.arms[3].spec.role, ArmRole::Floor);
    assert_eq!(read.arms[3].all.speaking, 1);
}

/// An option with exactly one off-pool placement is read in `r_by_label` by that placement's share
/// ratio: labelling `Syndra+Ziggs` (the moved locked Galio, r 0.176) `never` puts one `never` in the 0.1
/// to 0.25 bucket, and an in-pool option labelled alongside is in no bucket.
/// Kills: counting options with other than one off-pool placement; a locked pick left out; the wrong
/// bucket.
#[test]
fn r_by_label_reads_the_single_off_pool_placement() {
    let live = live();
    let mut file = supp_17();
    let mut entry = labelled()["verdicts"][0].clone();
    entry
        .as_object_mut()
        .expect("an entry")
        .remove("would_pick");
    entry["labels"] = json!({F5: "never"});
    file["verdicts"] = json!([entry]);
    let run = run_of(&[file], &supp_config(), &live);
    let sc = &run.positions[0].scoring;
    assert_eq!(sc.r_labels, [(RBucket::Below25, Label::Never)]);
    assert_eq!(run.read.r_by_label.counts[1], [0, 0, 1]);
    assert_eq!(
        run.read.r_by_label.counts.iter().flatten().sum::<usize>(),
        1
    );
}

/// The second line reads the current fold's own pick as well as its labels: the rule's own pick is c2
/// (in the top 3 at A, out at B) and the current fold's is c5 (the other way round), so the rule keeps A
/// and the second line picks B.
/// Kills: a second line that reads the rule fold's own pick.
#[test]
fn the_second_line_reads_the_current_folds_own_pick() {
    let b: &[(u8, f64)] = &[(1, 1.0), (5, 0.9), (3, 0.8), (4, 0.7), (2, 0.6), (0, 0.1)];
    let mut p = rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &LABELS,
        Some(2),
        &[(ARM_A, &GOOD_C2_AT_2), (ARM_B, b)],
    );
    p.current.own_pick = Some(act(5));
    p.arms[0].own_in_pool.push((act(5), true));
    p.arms[1].own_in_pool.push((act(5), true));
    let ps = [p];
    let read = read_run(&refs(&ps), &specs_ab(), ARM_A, 0.01, false);
    assert_eq!(read.rule.pick.as_deref(), Some(ARM_A));
    assert_eq!(read.second_line.outcome.pick.as_deref(), Some(ARM_B));
    assert!(read.second_line.differs);
}

fn sp(champion: u8, in_pool: bool, locked: bool) -> SidePlacement {
    SidePlacement {
        champion: ChampionIdx(champion),
        role: Role::Top,
        grade: 0,
        in_pool,
        locked,
    }
}

/// A floor keeps an option whose off-pool placement has unknown r, and counts it; removes one whose
/// known r is below the cut (a locked placement too); keeps one whose r is at the cut. When it removes
/// every option the floor row does not speak, so the position is not read as a clean one.
/// Kills: unknown r removed; unknown r uncounted; the cut inclusive; an emptied floor that speaks.
#[test]
fn a_floor_keeps_and_counts_unknown_r_and_an_emptied_floor_does_not_speak() {
    let r_of = |p: &SidePlacement| match p.champion.0 {
        1 => Some(0.05),
        2 => Some(0.25),
        _ => None,
    };
    let sides = vec![
        vec![sp(0, true, false)],                      // all in-pool: kept
        vec![sp(1, false, true)],                      // locked, r 0.05: removed
        vec![sp(2, false, false)],                     // r 0.25: kept at 0.25
        vec![sp(3, false, false)],                     // unknown r: kept, counted
        vec![sp(3, false, false), sp(1, false, true)], // unknown and low: removed, not counted
    ];
    assert_eq!(floor_keep(&sides, 0.25, r_of), (vec![0, 2, 3], 1));
    assert_eq!(floor_keep(&sides, 0.03, r_of), (vec![0, 1, 2, 3, 4], 2));
    let all_low = vec![
        vec![sp(1, false, true)],
        vec![sp(1, false, true), sp(0, true, false)],
    ];
    assert_eq!(floor_keep(&all_low, 0.25, r_of), (vec![], 0));
}

/// An own pick first given after the reveal (the blind entry has none) is read by the rule through the
/// fallback and counted: the position counts in the reference arm's `pick` on the rule's fold and
/// `fallbacks.picks` says 1. A blind "no view" stays no view with no fallback; a "no view" given only
/// after is counted but reads no pick.
/// Kills: the rule fold dropping a pick given only after the reveal; an uncounted fallback.
#[test]
fn an_own_pick_first_given_after_the_reveal_is_read_and_counted() {
    let live = live();
    let pick = json!(["MonkeyKing", "Galio"]);
    let run_with = |blind_pick: Option<Value>, scored_pick: Value| {
        let mut file = labelled();
        let blind = file["verdicts"][0].as_object_mut().expect("entry");
        blind.remove("would_pick");
        if let Some(b) = blind_pick {
            blind.insert("would_pick".to_string(), b);
        }
        file["verdicts"][1]["would_pick"] = scored_pick;
        run_of(&[file], &review_config(), &live)
    };
    let with_reference = |run: &ReviewRun| {
        run.read
            .arms
            .iter()
            .find(|a| a.spec.id == REFERENCE_ARM)
            .expect("the reference arm")
            .all
            .with_pick
    };
    // Given only after.
    let run = run_with(None, pick.clone());
    let sc = &run.positions[0].scoring;
    assert!(sc.pick_fallback);
    assert_eq!(
        sc.rule.own_pick,
        Some(pick_of(&live, "MonkeyKing", "Galio"))
    );
    assert_eq!(sc.rule.own_pick, sc.current.own_pick);
    assert_eq!(run.read.fallbacks.picks, 1);
    assert_eq!(with_reference(&run), 1);
    // Given blind as "no view", then a pick after: blind stands.
    let run = run_with(Some(Value::Null), pick);
    let sc = &run.positions[0].scoring;
    assert!(!sc.pick_fallback);
    assert_eq!(sc.rule.own_pick, None);
    assert_eq!(run.read.fallbacks.picks, 0);
    assert_eq!(with_reference(&run), 0);
    // No pick blind, "no view" after: counted, reads no pick.
    let run = run_with(None, Value::Null);
    assert!(run.positions[0].scoring.pick_fallback);
    assert_eq!(run.positions[0].scoring.rule.own_pick, None);
    assert_eq!(run.read.fallbacks.picks, 1);
}

// ---- Task 11: the run's `metrics`, the text summary, the history ---------------------------------------

/// The labelled position's run, kept in memory (the in-memory `Read` is not in the JSON).
fn base_review() -> &'static ReviewRun {
    static BASE: std::sync::OnceLock<ReviewRun> = std::sync::OnceLock::new();
    BASE.get_or_init(|| run_of(&[labelled()], &review_config(), &live()))
}

/// The summary on the labelled position is pinned: the table, floor rows, the rule's line, receipt,
/// sensitivity, second line, `never_everywhere`, `r_by_label`, `bad_line@1` and the worklist, in order.
/// Nothing in it is wall-clock or platform dependent (the run id and commit are the config's).
/// Kills: any change to what the summary prints or the order it prints it in.
#[test]
fn the_summary_on_the_labelled_position_is_pinned() {
    insta::assert_snapshot!(
        "summary_on_the_labelled_position",
        render_summary(base_review())
    );
}

/// `bad_line@1` reads "bad of judged": an arm whose #1 line has no verdict prints 0 bad of 0 judged
/// with the line counted as unjudged, never as a clean zero; the figures are the arm's `Metrics`.
/// Kills: printing `bad_line` alone; unjudged lines left out of the line.
#[test]
fn the_summary_reads_bad_line_as_bad_of_judged() {
    let run = base_review();
    let text = render_summary(run);
    let arm = run
        .read
        .arms
        .iter()
        .find(|a| a.spec.id == REFERENCE_ARM)
        .expect("the reference arm");
    let line = format!(
        "{REFERENCE_ARM}: {} bad of {} judged, {} unjudged",
        arm.all.bad_line, arm.all.judged_line, arm.all.unjudged_line
    );
    assert!(text.contains(&line), "{line}\n{text}");
    assert!(text.contains("bad_line@1 (bad of judged"), "{text}");
    let m = &run.metrics.as_ref().expect("labelled run has metrics")["arms"];
    let wire = m
        .as_array()
        .and_then(|a| a.iter().find(|a| a["id"] == REFERENCE_ARM))
        .expect("the reference arm's metrics");
    assert_eq!(wire["metrics"]["bad_line"], arm.all.bad_line);
    assert_eq!(wire["metrics"]["judged_line"], arm.all.judged_line);
    assert_eq!(wire["metrics"]["unjudged_line"], arm.all.unjudged_line);
}

/// A run header for the constructed summaries (nothing in it is measured).
fn test_header(arm_ids: &[&str]) -> RunHeader {
    RunHeader {
        id: "2026-11-11T00:00:00Z".to_string(),
        engine: EngineStamp {
            name: "reference".to_string(),
            commit: Some("abc1234".to_string()),
            dirty: Some(false),
        },
        data: DataStamp {
            fm_version: "fm-test".to_string(),
            meta_version: "meta-test".to_string(),
            positions_patch: "16.19".to_string(),
            playable_rule: None,
        },
        search: SearchStamp {
            horizon: 2,
            widths: WidthsWire {
                singles: 1,
                pairs: 1,
                root_off_pool: 1,
            },
            node_budget: 1,
            jobs: 1,
        },
        k: 3,
        margin: 0.01,
        reference_arm: arm_ids[0].to_string(),
        arms: arm_ids
            .iter()
            .map(|id| ArmWire {
                id: id.to_string(),
                rule: "roster",
                p: None,
                q: None,
                w: None,
            })
            .collect(),
        holdout_open: false,
    }
}

/// Every field `metrics.arms[]` emits for an arm, against the in-memory `ArmScore`.
fn assert_wire_arm(wire: &Value, arm: &ArmScore, unknown_r_kept: usize) {
    let m = &wire["metrics"];
    let a = &arm.all;
    assert_eq!(wire["id"], arm.spec.id);
    assert_eq!(wire["readable"], arm.readable());
    assert_eq!(wire["unknown_r_kept"], unknown_r_kept);
    for (name, got) in [
        ("never", a.never),
        ("near", a.near),
        ("unjudged", a.unjudged),
        ("play", a.play),
        ("no_play", a.no_play),
        ("neither_play", a.neither_play),
        ("pick", a.pick),
        ("pick_off", a.pick_off),
    ] {
        assert_eq!(m[name], json!(got), "{name} of {}", arm.spec.id);
    }
    for (name, got) in [
        ("positions", a.positions),
        ("speaking", a.speaking),
        ("non_speaking", a.positions - a.speaking),
        ("with_pick", a.with_pick),
        ("pick_off_eligible", a.pick_off_eligible),
        ("top_in_pool", a.top_in_pool),
        ("pick_absent", a.pick_absent),
        ("opp_charge_lead", a.opp_charge_lead),
        ("bad_line", a.bad_line),
        ("judged_line", a.judged_line),
        ("unjudged_line", a.unjudged_line),
    ] {
        assert_eq!(m[name], json!(got), "{name} of {}", arm.spec.id);
    }
    assert_eq!(
        m["never_1_by_class"],
        json!({"in_pool": a.never_1_in_pool, "off_pool_base": a.never_1_base, "off_pool_graded": a.never_1_graded})
    );
    assert_eq!(m["pick_median_regret"], json!(a.pick_median_regret));
    let ids = |f: &dyn Fn(&PositionScore) -> bool| -> Vec<String> {
        arm.rows
            .iter()
            .filter(|r| r.score.as_ref().is_some_and(f))
            .map(|r| r.id.clone())
            .collect()
    };
    let behind = &wire["positions"];
    for (name, got) in [
        ("never_1", ids(&|s| s.never[0])),
        ("never_3", ids(&|s| s.never[1])),
        ("near_1", ids(&|s| s.near[0])),
        ("near_3", ids(&|s| s.near[1])),
        ("unjudged_1", ids(&|s| s.unjudged[0])),
        ("unjudged_3", ids(&|s| s.unjudged[1])),
        ("pick_3", ids(&|s| s.pick[1])),
    ] {
        assert_eq!(behind[name], json!(got), "{name} of {}", arm.spec.id);
    }
    let silent: Vec<&str> = arm
        .rows
        .iter()
        .filter(|r| r.score.is_none())
        .map(|r| r.id.as_str())
        .collect();
    assert_eq!(behind["not_speaking"], json!(silent));
}

/// The `metrics` block carries what the page and the summary read, and agrees with the in-memory read.
/// Kills: a metrics block that drifts from `Read`; positions behind a count missing.
#[test]
fn the_metrics_block_agrees_with_the_read() {
    let run = base_review();
    let v = serde_json::to_value(run).expect("serialises");
    let m = &v["metrics"];
    assert_eq!(m["ks"], json!([1, 3, 5, 10]));
    assert_eq!(m["reference"], REFERENCE_ARM);
    assert_eq!(m["labels"]["positions"], 1);
    assert_eq!(m["labels"]["labelled_positions"], 1);
    assert_eq!(m["rule"]["roster_arms"], 4);
    assert_eq!(
        m["rule"]["pick"],
        serde_json::to_value(&run.read.rule.pick).unwrap()
    );
    let arms = array(&m["arms"], "arms");
    assert_eq!(
        arms.len(),
        run.read.arms.len(),
        "arms then the two floor rows"
    );
    for (wire, arm) in arms.iter().zip(&run.read.arms) {
        assert_wire_arm(wire, arm, 0);
    }
    let roles: Vec<&str> = arms.iter().map(|a| text(&a["role"], "role")).collect();
    assert_eq!(roles.iter().filter(|r| **r == "floor").count(), 2);
    for key in [
        "sensitivity",
        "second_line",
        "never_everywhere",
        "r_by_label",
        "reveal_changes",
        "worklist",
    ] {
        assert!(m.get(key).is_some(), "metrics.{key}");
    }
    assert_eq!(array(&m["r_by_label"], "r_by_label").len(), 6);
}

/// With no labels there is nothing to read: `metrics` is absent (not null, not empty), the JSON still
/// parses and carries `tier-b-run/1`, and the summary says so.
/// Kills: an always-present `metrics`; a summary that tables an unread corpus.
#[test]
fn metrics_are_absent_with_no_labels_and_the_json_still_parses() {
    let run = run_of(&[supp_17()], &supp_config(), &live());
    assert!(run.metrics.is_none());
    let written = serde_json::to_string_pretty(&run).expect("serialises");
    let v: Value = serde_json::from_str(&written).expect("it parses");
    assert_eq!(v["schema"], "tier-b-run/1");
    assert!(v.as_object().expect("an object").get("metrics").is_none());
    let summary = render_summary(&run);
    assert!(summary.contains("No labels yet"), "{summary}");
    assert!(!summary.contains("P x Q"), "{summary}");
}

/// `history.jsonl` beside the fixtures is not a fixture: `load_dir` reads `*.json` only, so a history
/// line (even one that is not a fixture at all) adds no load result and no error.
/// Kills: a loader that reads every file in the directory.
#[test]
fn a_history_jsonl_in_the_fixtures_dir_is_not_loaded() {
    let live = live();
    let dir = std::env::temp_dir().join(format!("tier-b-history-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    std::fs::write(dir.join("2026-10-07-labelled.json"), labelled().to_string())
        .expect("fixture copy");
    let before = TierBFixture::load_dir(&dir, &live).expect("loads");
    std::fs::write(dir.join("history.jsonl"), "{\"not\": \"a fixture\"}\n").expect("history");
    let after = TierBFixture::load_dir(&dir, &live).expect("loads");
    std::fs::remove_dir_all(&dir).expect("clean up");
    assert_eq!(before.len(), 1);
    assert_eq!(after.len(), 1, "the history file is not a position");
    assert!(after[0].is_ok());
}

/// The binary writes `summary.txt` beside the run JSON.
/// Kills: a summary written elsewhere or not at all.
#[test]
fn the_binary_writes_summary_txt_beside_the_run_json() {
    let exe = env!("CARGO_BIN_EXE_tier_b_review");
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/tier-b-review/por-only");
    let dir = std::env::temp_dir().join(format!("tier-b-summary-bin-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let ran = std::process::Command::new(exe)
        .env("TIER_B_JSON", dir.join("run.json"))
        .env("TIER_B_FIXTURES", &fixtures)
        .env("TIER_B_P", "0.1")
        .env("TIER_B_W", "1")
        .env("TIER_B_Q", "0.05")
        .env("TIER_B_WIDTHS", "10,20,30")
        .env("TIER_B_K", "3")
        .env("TIER_B_JOBS", "2")
        .env("TIER_B_RUN_ID", "2026-11-09T00:00:00Z")
        .output()
        .expect("the binary runs");
    assert!(
        ran.status.success(),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
    let summary = std::fs::read_to_string(dir.join("summary.txt")).expect("summary.txt");
    std::fs::remove_dir_all(&dir).expect("clean up");
    assert!(
        summary.starts_with("Tier B review summary: run 2026-11-09T00:00:00Z"),
        "{summary}"
    );
}

/// A constructed run where the rule reads: two positions, arm A (the reference) with the `never` first
/// at one and arm B clean, so B is picked, A's `never@1` is the receipt's `from`, and the table marks
/// the pick and the reference. Pinned, so the readable half of the text (the pick line, the receipt, the
/// sensitivity and second lines) is under test as well as the unread half above.
/// Kills: a summary that prints only the unread case; a receipt printed to-from; a pick unmarked.
#[test]
fn the_summary_of_a_readable_run_is_pinned() {
    let ps = [
        rpos(
            "2026-10-01-a",
            "2026-10-01",
            Side::Blue,
            Some(false),
            &LABELS,
            Some(2),
            &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
        ),
        rpos(
            "2026-10-02-b",
            "2026-10-02",
            Side::Blue,
            None,
            &LABELS,
            Some(2),
            &[(ARM_A, &GOOD_C2_AT_5), (ARM_B, &GOOD_C2_AT_2)],
        ),
    ];
    let inputs = refs(&ps);
    let read = read_run(&inputs, &specs_ab(), ARM_A, 0.01, false);
    assert_eq!(
        read.rule.pick.as_deref(),
        Some(ARM_B),
        "the premise: B is readable and better"
    );
    let header = test_header(&[ARM_A, ARM_B]);
    let text = summary_of(&header, &read, &inputs);
    assert!(
        text.contains("The rule: 2 of 2 arms readable. Pick: roster:0.15:0.05"),
        "{text}"
    );
    assert!(
        text.contains("never@1 1 → 0"),
        "the receipt reads reference then pick\n{text}"
    );
    insta::assert_snapshot!("summary_of_a_readable_run", text);
}

/// A constructed run that reaches every branch the labelled run does not: a near tie (`(+n)`), an arm
/// where a position does not speak (`!`, the count), two arms tied on the three keys with the reference
/// among them (so the pick is the reference: `bad_line@1` prints once), a second line that DIFFERS, floor
/// rows with a non-speaking count and unknown-r placements kept, the grid's bottom edge above zero (bare
/// flag, per the ruling on Task 10's C1), and `≥` cells with their upper bounds. The wire block is
/// compared to the same read field by field, on values that are not all zero.
/// Kills: `(+n)`, `!`, DIFFERS, the ties text, the floor rows' counts, the upper-bound lines or the
/// single bad_line block dropped or changed; a wire field that drifts where the labelled run holds zeros.
#[test]
fn the_summary_reaches_near_ties_silence_differs_ties_floors_and_upper_bounds() {
    // c0 is `never`; p1: the never is first and a play sits within the margin: near at 1 and 3.
    const NEAR: [(u8, f64); 6] = [(0, 1.0), (1, 0.995), (2, 0.9), (3, 0.8), (4, 0.7), (5, 0.6)];
    // c5 first, then the plays, the `never` last.
    const C5_FIRST: [(u8, f64); 6] = [(5, 1.0), (1, 0.9), (2, 0.8), (3, 0.7), (4, 0.6), (0, 0.1)];
    let c = "roster:0.2:0.05";
    let (f1, f2) = ("floor:0.1", "floor:0.25");
    let mut p1 = rpos(
        "2026-10-01-a",
        "2026-10-01",
        Side::Blue,
        Some(true),
        &LABELS,
        Some(2),
        &[
            (ARM_A, &NEAR),
            (ARM_B, &NEAR),
            (c, &NEAR),
            (f1, &NEAR),
            (f2, &NEAR),
        ],
    );
    p1.arms[3].unknown_r_kept = 2;
    let mut p2 = rpos(
        "2026-10-02-b",
        "2026-10-02",
        Side::Blue,
        Some(false),
        &LABELS,
        Some(2),
        &[
            (ARM_A, &C5_FIRST),
            (ARM_B, &GOOD_C2_AT_2),
            (c, &[]),
            (f1, &GOOD_C2_AT_2),
            (f2, &[]),
        ],
    );
    // After the reveal c5 reads `never`: arm A puts it first, B does not, so the current fold prefers B.
    p2.current.labels.insert(opt(5), Label::Never);
    let ps = [p1, p2];
    let inputs = refs(&ps);
    let mut specs = vec![
        roster_spec(0.1, 0.05),
        roster_spec(0.15, 0.05),
        roster_spec(0.2, 0.05),
    ];
    for (id, _) in [(f1, 0), (f2, 1)] {
        specs.push(ArmSpec {
            id: id.to_string(),
            role: ArmRole::Floor,
            p: None,
            q: None,
            w: None,
        });
    }
    let read = read_run(&inputs, &specs, ARM_A, 0.01, false);
    assert_eq!(
        read.rule.pick.as_deref(),
        Some(ARM_A),
        "premise: the tie keeps the reference"
    );
    assert_eq!(read.rule.ties.len(), 2, "premise: A and B tie");
    assert!(
        read.second_line.differs,
        "premise: the current fold picks B"
    );

    let header = test_header(&[ARM_A, ARM_B, c]);
    let text = summary_of(&header, &read, &inputs);
    assert!(text.contains("(+1)"), "{text}");
    assert!(text.contains("! some positions do not speak"), "{text}");
    assert!(text.contains("DIFFERS"), "{text}");
    assert!(text.contains("tied on the three keys"), "{text}");
    assert!(
        text.contains("non-speaking 1 of 2, unknown r kept 0"),
        "{text}"
    );
    assert!(text.contains("unknown r kept 2"), "{text}");
    assert!(
        text.contains("on the grid's edge (P = 0.1)\n"),
        "bare bottom edge\n{text}"
    );
    assert_eq!(
        text.matches("0 bad of 0 judged").count(),
        1,
        "pick = reference prints the line once\n{text}"
    );
    assert!(text.contains("reference = pick, "), "{text}");
    insta::assert_snapshot!("summary_of_every_branch", text);

    let header_run = test_header(&[ARM_A, ARM_B, c]);
    let wire = engine_core::reference::tier_b_summary::metrics_of(&header_run, &read, &inputs)
        .expect("labelled");
    let arms = array(&wire["arms"], "arms");
    assert_eq!(arms.len(), read.arms.len());
    for (w, arm) in arms.iter().zip(&read.arms) {
        let unknown: usize = inputs
            .iter()
            .flat_map(|p| p.arms.iter())
            .filter(|a| a.id == arm.spec.id)
            .map(|a| a.unknown_r_kept)
            .sum();
        assert_wire_arm(w, arm, unknown);
        assert_eq!(arm.unknown_r_kept, unknown, "the ArmScore carries the sum");
    }
    for (kind, got) in [
        ("margins", &read.sensitivity.margins_readable),
        ("leave_out", &read.sensitivity.leave_out_readable),
    ] {
        let wired: Vec<u64> = array(&wire["sensitivity"][kind], kind)
            .iter()
            .map(|e| e["readable"].as_u64().expect("readable"))
            .collect();
        let want: Vec<u64> = got.iter().map(|n| *n as u64).collect();
        assert_eq!(wired, want, "{kind}: readable arms per re-read");
    }
    assert_eq!(wire["rule"]["pick"], ARM_A);
    assert_eq!(wire["second_line"]["differs"], true);
    assert_eq!(
        wire["rule"]["receipt"]["pick"],
        wire["rule"]["receipt"]["reference"]
    );
}

fn top(option: u8, line: &str) -> Option<TopLine> {
    Some(TopLine {
        option: opt(option),
        option_id: format!("c{option}"),
        line: line.to_string(),
    })
}

/// An empty continuation (slot 19) is no line: not unjudged, not in the worklist, counted as "with no
/// line" in `bad_line@1`, and on the wire.
/// Kills: an empty line read as an unjudged line (the page refuses a verdict on it, so it could never
/// clear); the count of no-line #1s dropped.
#[test]
fn an_empty_continuation_is_no_line_not_unjudged() {
    let mut p = rpos(
        "2026-10-01-a",
        "2026-10-01",
        Side::Blue,
        None,
        &LABELS,
        Some(2),
        &[(ARM_A, &GOOD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
    );
    p.arms[0].top_line = top(1, "");
    p.arms[1].top_line = top(1, "");
    let ps = [p];
    let inputs = refs(&ps);
    let read = read_run(&inputs, &specs_ab(), ARM_A, 0.01, false);
    let m = &read.arms[0].all;
    assert_eq!(
        (m.no_line, m.unjudged_line, m.judged_line, m.bad_line),
        (1, 0, 0, 0)
    );
    assert_eq!(read.arms[0].rows[0].line, LineState::None);
    assert!(read.worklist.unjudged_lines.is_empty());
    let text = summary_of(&test_header(&[ARM_A, ARM_B]), &read, &inputs);
    assert!(
        text.contains("0 bad of 0 judged, 0 unjudged, 1 with no line"),
        "{text}"
    );
    let wire = engine_core::reference::tier_b_summary::metrics_of(
        &test_header(&[ARM_A, ARM_B]),
        &read,
        &inputs,
    )
    .expect("labelled");
    assert_eq!(wire["arms"][0]["metrics"]["no_line"], 1);
    assert_eq!(
        wire["arms"][0]["positions"]["no_line_1"],
        json!(["2026-10-01-a"])
    );
}

/// The runner leaves a slot-19 #1 with no line at every arm that speaks.
/// Kills: `top_line_of` returning an empty line.
#[test]
fn the_runner_gives_a_slot_19_number_one_no_line() {
    let run = run_of(&[por_only_fixture()], &supp_config(), &live());
    let arms: Vec<_> = run.positions[0]
        .scoring
        .arms
        .iter()
        .filter(|a| a.speaks)
        .collect();
    assert!(!arms.is_empty());
    for a in arms {
        assert!(a.top_line.is_none(), "{}: {:?}", a.id, a.top_line);
    }
}

/// A pick #1 line the page cannot judge (its option or line differs from the reference arm's at that
/// position) is listed marked, and counted; the same line at both arms is judgeable.
/// Kills: a worklist that lists unclearable lines unmarked; the marker on a judgeable line.
#[test]
fn a_pick_line_the_page_cannot_judge_is_marked() {
    let mk = |id: &str, draft: &str, line_b: &str| {
        let mut p = rpos(
            id,
            draft,
            Side::Blue,
            None,
            &LABELS,
            Some(2),
            &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
        );
        p.arms[0].top_line = top(0, "Zyra");
        p.arms[1].top_line = top(1, line_b);
        p
    };
    // p1: the pick's #1 is another option than the reference's; p2: the same option and line.
    let mut p2 = mk("2026-10-02-b", "2026-10-02", "Zyra");
    p2.arms[1].top_line = top(0, "Zyra");
    let ps = [mk("2026-10-01-a", "2026-10-01", "Karma"), p2];
    let inputs = refs(&ps);
    let read = read_run(&inputs, &specs_ab(), ARM_A, 0.01, false);
    assert_eq!(read.rule.pick.as_deref(), Some(ARM_B), "the premise");
    let lines = &read.worklist.unjudged_lines;
    assert_eq!(lines.len(), 2);
    assert_eq!(
        lines
            .iter()
            .map(|l| (l.position.as_str(), l.judgeable))
            .collect::<Vec<_>>(),
        [("2026-10-01-a", false), ("2026-10-02-b", true)]
    );
    assert_eq!(read.worklist.not_judgeable(), 1);
    let text = summary_of(&test_header(&[ARM_A, ARM_B]), &read, &inputs);
    assert!(
        text.contains("with no line verdict: 2 (1 not judgeable on the page"),
        "{text}"
    );
    assert_eq!(
        text.matches("[not judgeable on the page]").count(),
        1,
        "{text}"
    );
    let wire = engine_core::reference::tier_b_summary::metrics_of(
        &test_header(&[ARM_A, ARM_B]),
        &read,
        &inputs,
    )
    .expect("labelled");
    assert_eq!(wire["worklist"]["not_judgeable"], 1);
    assert_eq!(wire["worklist"]["unjudged_lines"][0]["judgeable"], false);
    assert_eq!(wire["worklist"]["unjudged_lines"][1]["judgeable"], true);
}

/// A floor row's `≥` cell gets its upper bound under the table like an arm's.
/// Kills: floors left out of the upper-bound block.
#[test]
fn a_floor_rows_unjudged_cell_gets_an_upper_bound() {
    // c5 is unlabelled and first: read as `never` it is clear at one, as a play it is not.
    const C5_FIRST: [(u8, f64); 6] = [(5, 1.0), (1, 0.9), (2, 0.8), (3, 0.7), (4, 0.6), (0, 0.1)];
    let labels: Vec<(u8, Label)> = LABELS.iter().copied().filter(|(c, _)| *c != 5).collect();
    let p = rpos(
        "2026-10-01-a",
        "2026-10-01",
        Side::Blue,
        None,
        &labels,
        Some(2),
        &[
            (ARM_A, &GOOD_C2_AT_2),
            (ARM_B, &GOOD_C2_AT_2),
            ("floor:0.1", &C5_FIRST),
        ],
    );
    let mut specs = specs_ab();
    specs.push(ArmSpec {
        id: "floor:0.1".to_string(),
        role: ArmRole::Floor,
        p: None,
        q: None,
        w: None,
    });
    let ps = [p];
    let inputs = refs(&ps);
    let read = read_run(&inputs, &specs, ARM_A, 0.01, false);
    let text = summary_of(&test_header(&[ARM_A, ARM_B]), &read, &inputs);
    assert!(text.contains("floor:0.1  r < 0.1  ≥0/"), "{text}");
    assert!(text.contains("  floor:0.1  ≤1 / "), "{text}");
}

// ---- Slice B, task 2: the runner's weighted arms (engine-synergy-weight-and-floor design § 3, T7-T12) ---

fn weighted_universes(ws: &[f64]) -> Vec<LiveUniverse> {
    let base = live();
    ws.iter()
        .map(|w| weighted_live(*w, &base))
        .collect::<Vec<_>>()
}

/// The shipped FM and meta at synergy weight `w` (the same build as `live()`).
fn weighted_live(w: f64, base: &LiveUniverse) -> LiveUniverse {
    let root = repo_root();
    let fm = FmWeights::from_json_str(
        &std::fs::read_to_string(root.join("data/compiled/fm-weights.json"))
            .expect("fm-weights.json"),
    )
    .expect("fm-weights parses");
    let (_, meta) = load_production_data_from(&root.join("data/compiled/champion-meta.json"));
    LiveUniverse::build_weighted(&fm, &base.meta_version, &meta, w)
        .unwrap_or_else(|e| panic!("{e}"))
}

fn weighted_run(ws: &[f64]) -> ReviewRun {
    let base = live();
    let weighted = weighted_universes(ws);
    let corpus = vec![load(&labelled(), &base)];
    run_review_with(&corpus, &base, &weighted, &review_config())
}

fn arm_ids(run: &ReviewRun) -> Vec<&str> {
    run.run.arms.iter().map(|a| a.id.as_str()).collect()
}

fn weighted_spec(w: f64) -> ArmSpec {
    ArmSpec {
        id: format!("roster:0.1:0.05:w{w}"),
        role: ArmRole::Weight,
        p: Some(0.1),
        q: Some(0.05),
        w: Some(w),
    }
}

/// T7. Universes at 0.5 and 2 add `roster:0.1:0.05:w0.5` and `:w2` after today's arms, in the order
/// given; `w` is in the JSON on those two only; `run_review` gives none; the metrics call them `weight`.
/// Kills: a weighted arm at `w = 1`; `w` serialised everywhere; a weighted arm tagged `roster`.
#[test]
fn weighted_universes_add_weighted_arms_after_the_grid() {
    let plain = base_review();
    let run = weighted_run(&[0.5, 2.0]);
    let mut want: Vec<String> = arm_ids(plain).iter().map(|s| s.to_string()).collect();
    assert!(want.iter().all(|id| !id.contains(":w")));
    want.push("roster:0.1:0.05:w0.5".to_string());
    want.push("roster:0.1:0.05:w2".to_string());
    assert_eq!(arm_ids(&run), want);
    let json = serde_json::to_value(&run).expect("serialises");
    for arm in array(&json["run"]["arms"], "arms") {
        let id = text(&arm["id"], "id");
        let weighted = id.contains(":w");
        assert_eq!(arm.get("w").is_some(), weighted, "{id}");
        if weighted {
            assert_eq!(arm["rule"], "roster");
            assert_eq!(arm["p"], 0.1);
            assert_eq!(arm["q"], 0.05);
        }
    }
    assert_eq!(json["run"]["arms"][want.len() - 2]["w"], 0.5);
    assert_eq!(json["run"]["arms"][want.len() - 1]["w"], 2.0);
    // The summary and the metrics read them without the rule seeing them.
    let metrics = run.metrics.as_ref().expect("the labelled run has metrics");
    for arm in array(&metrics["arms"], "metrics arms") {
        if text(&arm["id"], "id").contains(":w") {
            assert_eq!(arm["role"], "weight");
            assert_eq!(arm["readable"], false);
        }
    }
    let plain_json = serde_json::to_value(plain).expect("serialises");
    assert!(plain_json["run"]["arms"]
        .as_array()
        .expect("arms")
        .iter()
        .all(|a| a.get("w").is_none()));
    // A universe at the base weight adds no arm; `-0.0` reads as 0.
    let base = live();
    let corpus = vec![load(&labelled(), &base)];
    let same = run_review_with(
        &corpus,
        &base,
        &weighted_universes(&[1.0]),
        &review_config(),
    );
    assert_eq!(arm_ids(&same), arm_ids(plain));
    let zero = run_review_with(
        &corpus,
        &base,
        &[weighted_live(-0.0, &base)],
        &review_config(),
    );
    assert_eq!(arm_ids(&zero).last(), Some(&"roster:0.1:0.05:w0"));
}

/// Searches `fixture`'s root at P 0.1, Q 0.05 in `u` with the test config's shortlist and horizon.
fn direct_search(
    fx: &engine_core::reference::tier_b::TierBFixture,
    u: &LiveUniverse,
    cfg: &ReviewConfig,
) -> engine_core::reference::search::SearchOutcome {
    let position = fx.root.position(&u.universe).expect("position builds");
    search(
        &OracleInput {
            position: &position,
            universe: &u.universe,
            pools: &fx.root.pools,
            objective: &u.universe,
            feasibility: FeasibilityRule::Roster,
            mode: Mode::Horizon(cfg.horizon),
            epsilon: 1e-9,
            off_pool_cost: Some(0.1),
            off_role_cost: Some(0.05),
        },
        &SearchParams {
            node_budget: Some(cfg.node_budget),
            wall_budget: std::time::Duration::from_secs(300),
            shortlist: Some(cfg.shortlist),
            ..SearchParams::default()
        },
        &CancelHandle::new(),
        |_| {},
    )
    .expect("the search runs")
}

/// T9. Each weighted arm's ranked values are a direct search's on `build_weighted(w)` at the same P
/// and Q; the top value differs from the reference arm's.
/// Kills: every arm searching the `w = 1` universe.
#[test]
fn each_weighted_arm_searches_its_own_universe() {
    let ws = [0.5, 2.0];
    let run = weighted_run(&ws);
    let base = live();
    let cfg = review_config();
    let fx = loaded(&labelled(), &base).fixture;
    let reading = |id: &str| {
        run.positions[0]
            .readings
            .iter()
            .find(|r| r.arm == id)
            .unwrap_or_else(|| panic!("{id}"))
    };
    let reference_top = reading(REFERENCE_ARM).ranked[0].value;
    let mut differs = false;
    for w in ws {
        let u = weighted_live(w, &base);
        let direct = direct_search(&fx, &u, &cfg);
        let got = reading(&format!("roster:0.1:0.05:w{w}"));
        assert!(!got.ranked.is_empty());
        // Option by option: an option id is the action's spelling, then `|` and the comp.
        let direct_by_action: HashMap<String, u64> = direct
            .ranked
            .iter()
            .map(|r| {
                let key = OptionKey {
                    action: r.action,
                    comp: None,
                };
                (key.id(&u.universe), r.value.to_bits())
            })
            .collect();
        for r in &got.ranked {
            let action = r.option.split('|').next().expect("an option id");
            assert_eq!(
                direct_by_action.get(action),
                Some(&r.value.to_bits()),
                "w {w}: {} at {}",
                r.option,
                r.value
            );
        }
        assert_eq!(
            got.ranked[0].value.to_bits(),
            direct.ranked[0].value.to_bits()
        );
        differs |= got.ranked[0].value.to_bits() != reference_top.to_bits();
    }
    assert!(differs, "no weighted arm differs from the reference arm");
}

/// T10. For every action a weighted arm ranks, the arrangement and the charge read the same in the
/// `w = 1` universe as in the weighted one.
/// Kills: a trace that reads synergy (the claim of design § 3 that lets the catalog use the base).
#[test]
fn traces_do_not_read_the_weight() {
    let base = live();
    let cfg = review_config();
    let fx = loaded(&labelled(), &base).fixture;
    let pools = &fx.root.pools;
    let base_position = fx.root.position(&base.universe).expect("position");
    let root = base_position.next_slot().expect("next slot");
    for w in [0.5, 2.0, 3.0] {
        let u = weighted_live(w, &base);
        let position = fx.root.position(&u.universe).expect("position");
        let direct = direct_search(&fx, &u, &cfg);
        let price = Price::of(0.1, 0.05);
        let (mut m1, mut m2) = (FeasibilityMemo::new(price), FeasibilityMemo::new(price));
        let c1 = action_charge(
            &mut m1,
            FeasibilityRule::Roster,
            root.side,
            &base_position,
            pools,
            &base.universe,
        );
        let c2 = action_charge(
            &mut m2,
            FeasibilityRule::Roster,
            root.side,
            &position,
            pools,
            &u.universe,
        );
        assert!(!direct.ranked.is_empty());
        for r in &direct.ranked {
            let a1 = arrangement(
                &mut m1,
                root.side,
                &base_position,
                pools,
                &base.universe,
                r.action,
            );
            let a2 = arrangement(&mut m2, root.side, &position, pools, &u.universe, r.action);
            assert_eq!(a1, a2, "w {w}");
            assert_eq!(c1.of(r.action), c2.of(r.action), "w {w}");
        }
    }
}

/// T11, catalog. An option that reaches the top K only at a weighted arm is a row (found on the corpus
/// at both w 0.5 (Ahri+Leona) and w 2 (three Katarina/Lulu/Zeri pairs); no construction needed).
/// Kills: `reach`, rows and the margin set over the `w = 1` arms only.
#[test]
fn an_option_reaching_the_top_only_at_a_weighted_arm_is_a_row() {
    let plain = serde_json::to_value(base_review()).expect("serialises");
    let rows = |run: &Value| -> BTreeSet<String> {
        run["positions"][0]["options"]
            .as_object()
            .expect("options")
            .iter()
            .filter(|(_, o)| o["row"] == true)
            .map(|(id, _)| id.clone())
            .collect()
    };
    let plain_rows = rows(&plain);
    let mut found = Vec::new();
    for w in [0.5, 2.0] {
        let run = serde_json::to_value(weighted_run(&[w])).expect("serialises");
        let new: Vec<String> = rows(&run).difference(&plain_rows).cloned().collect();
        assert!(plain_rows.is_subset(&rows(&run)), "w {w} dropped a row");
        found.push((w, new));
    }
    eprintln!("rows brought by a weighted arm: {found:?}");
    assert!(
        found.iter().any(|(_, new)| !new.is_empty()),
        "no weight brings a new row on the corpus: {found:?}"
    );
}

/// T11, the rule, on cached metrics. A weighted arm with the best keys loses to a roster arm and leaves
/// the rule outcome as it was; `readable()` is false and `readable_metrics` true on the same judged
/// metrics; zero positions are never readable. (The axes, `never_everywhere` and the sensitivity line
/// are pinned on real rows in `weighted_arms_leave_the_axes_the_rows_and_the_sensitivity_alone`.)
/// Kills: a weighted arm tagged `Roster`; `readable()` changed instead of split; a vacuous read.
#[test]
fn weighted_arms_feed_the_catalog_not_the_rule() {
    let without = default_grid(|p, q| {
        if (p, q) == (0.1, 0.05) {
            (1, 1, 5)
        } else {
            (2, 2, 2)
        }
    });
    let mut with = without.clone();
    with.push(arm_with(weighted_spec(2.0), 0, 0, 99));
    with.push(arm_with(weighted_spec(0.5), 0, 0, 99));
    let a = choose_arm(&without, REF);
    let b = choose_arm(&with, REF);
    assert_eq!(a, b);
    assert_eq!(b.pick.as_deref(), Some(REF));
    assert_eq!((b.roster_arms, b.readable), (48, 48));
    let weighted = with.last().expect("the weighted arm");
    assert!(!weighted.readable());
    assert!(readable_metrics(&weighted.all));
    assert!(!readable_metrics(&Metrics::default()));
    let mut silent = weighted.all.clone();
    silent.speaking -= 1;
    assert!(!readable_metrics(&silent));
}

/// T12. `run.data.playable_rule` is the config's block verbatim, and the summary header names the floor
/// only when the block carries `minOwnShare`.
/// Kills: a stamp rewritten or dropped; a header that names a floor that is not there.
#[test]
fn the_data_stamp_carries_the_playable_rule() {
    let rule = json!({"minOwnShare": 0.02, "source": "test"});
    let cfg = ReviewConfig {
        playable_rule: Some(rule.clone()),
        ..review_config()
    };
    let run = run_of(&[labelled()], &cfg, &live());
    let json = serde_json::to_value(&run).expect("serialises");
    assert_eq!(json["run"]["data"]["playable_rule"], rule);
    let first = render_summary(&run);
    let header = first.lines().next().expect("header");
    assert!(header.ends_with(", playable floor 2 %"), "{header}");
    // A block without `minOwnShare`: stamped, not named.
    let other = ReviewConfig {
        playable_rule: Some(json!({"source": "test"})),
        ..review_config()
    };
    let run = run_of(&[labelled()], &other, &live());
    assert!(!render_summary(&run).contains("playable floor"));
    assert!(
        serde_json::to_value(&run).expect("serialises")["run"]["data"]["playable_rule"].is_object()
    );
    // None: neither.
    let plain = base_review();
    assert!(!render_summary(plain).contains("playable floor"));
    let json = serde_json::to_value(plain).expect("serialises");
    assert!(json["run"]["data"].get("playable_rule").is_none());
}

/// T7, the binary. `TIER_B_W` drops the default and repeats, reads `-0` as 0 (one arm `w0`, never
/// `w-0`), and refuses what `build_weighted` refuses with exit 2 before any search.
/// Kills: a weighted arm at 1; a repeated arm; an arm id `w-0`; a negative or NaN weight accepted.
#[test]
fn the_binary_reads_the_weights_and_refuses_a_bad_one() {
    let exe = env!("CARGO_BIN_EXE_tier_b_review");
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/tier-b-review/por-only");
    let out = std::env::temp_dir().join(format!("tier-b-review-w-{}.json", std::process::id()));
    let command = |w: &str| {
        let mut c = std::process::Command::new(exe);
        c.env("TIER_B_JSON", &out)
            .env("TIER_B_FIXTURES", &dir)
            .env("TIER_B_P", "0.1")
            .env("TIER_B_Q", "0.05")
            .env("TIER_B_W", w)
            .env("TIER_B_WIDTHS", "10,20,30")
            .env("TIER_B_DEPTH_CHECK", "0")
            .env("TIER_B_JOBS", "2")
            .env("TIER_B_RUN_ID", "2026-11-09T00:00:00Z");
        c
    };
    let ran = command("1,2,2,-0,0,1").output().expect("the binary runs");
    assert!(
        ran.status.success(),
        "{}",
        String::from_utf8_lossy(&ran.stderr)
    );
    let run: Value =
        serde_json::from_str(&std::fs::read_to_string(&out).expect("run.json")).expect("json");
    let ids: Vec<&str> = array(&run["run"]["arms"], "arms")
        .iter()
        .map(|a| text(&a["id"], "id"))
        .collect();
    assert_eq!(
        ids,
        [
            "pool_or_roster",
            "roster:0.1:0.05",
            "roster:0.1:0.05:w2",
            "roster:0.1:0.05:w0"
        ]
    );
    // The stamp is the meta's `sources.positions.playableRule` verbatim, absent where the meta has none.
    let meta: Value = serde_json::from_str(
        &std::fs::read_to_string(repo_root().join("data/compiled/champion-meta.json"))
            .expect("champion-meta.json"),
    )
    .expect("meta parses");
    assert_eq!(
        run["run"]["data"].get("playable_rule"),
        meta["sources"]["positions"].get("playableRule")
    );
    let _ = std::fs::remove_file(&out);
    for bad in ["-0.5", "nan", "inf", "x"] {
        let refused = command(bad).output().expect("the binary runs");
        assert_eq!(refused.status.code(), Some(2), "{bad}");
        assert!(
            String::from_utf8_lossy(&refused.stderr).contains("TIER_B_W"),
            "{bad}"
        );
        assert!(!out.exists(), "{bad}: a search ran");
    }
}

/// T11, through `read_run` on constructed positions with rows. Two positions where the `never` is first
/// at both roster arms; a weighted arm placed OFF the roster grid (P 0.2, Q 0.3) ranks every position
/// well, so counting it would add P 0.2 and Q 0.3 to the axes, clear `never_everywhere`, and move the
/// sensitivity line. With it as `ArmRole::Weight` all three, the rule outcome and the roster arms'
/// scores are those of the run without it.
/// Kills: a weighted arm counted by `grid_axes`, `never_everywhere`, `choose_arm` or the sensitivity.
#[test]
fn weighted_arms_leave_the_axes_the_rows_and_the_sensitivity_alone() {
    const WARM: &str = "roster:0.2:0.3:w2";
    let positions = |with_weighted: bool| -> Vec<PositionInput> {
        ["d1", "d2"]
            .iter()
            .map(|d| {
                let mut arms: Vec<(&str, &[(u8, f64)])> =
                    vec![(ARM_A, &BAD_C2_AT_2), (ARM_B, &BAD_C2_AT_2)];
                if with_weighted {
                    arms.push((WARM, &GOOD_C2_AT_2));
                }
                rpos(d, d, Side::Blue, None, &LABELS, None, &arms)
            })
            .collect()
    };
    let mut specs = specs_ab();
    let plain = positions(false);
    let without = read_run(&refs(&plain), &specs, ARM_A, 0.01, false);
    specs.push(ArmSpec {
        id: WARM.to_string(),
        role: ArmRole::Weight,
        p: Some(0.2),
        q: Some(0.3),
        w: Some(2.0),
    });
    let weighted_inputs = positions(true);
    let with = read_run(&refs(&weighted_inputs), &specs, ARM_A, 0.01, false);
    // The rows bite: both positions are clear nevers at both roster arms, and the weighted arm is not.
    assert_eq!(without.never_everywhere, ["d1", "d2"]);
    assert_eq!(with.never_everywhere, without.never_everywhere);
    assert_eq!(grid_axes(&without.arms), (vec![0.1, 0.15], vec![0.05]));
    assert_eq!(grid_axes(&with.arms), grid_axes(&without.arms));
    assert_eq!(with.rule, without.rule);
    assert_eq!(with.sensitivity, without.sensitivity);
    assert_eq!(with.rule.roster_arms, 2);
    let weighted = with.arms.last().expect("the weighted arm");
    assert_eq!(weighted.spec.id, WARM);
    assert!(!weighted.readable());
    assert!(readable_metrics(&weighted.all));
    assert_eq!(
        weighted.all.never[0], 0,
        "the weighted arm reads on its own rows"
    );
}

// ---- Task 3 (slice B): the `w` read (engine design § 4, T13-T19) -------------------------------------

/// The reference arm of the `w` read: `ARM_A` at `w₀ = 1`.
const W0: f64 = 1.0;

fn weight_spec(w: f64) -> ArmSpec {
    ArmSpec {
        id: format!("roster:0.1:0.05:w{w}"),
        role: ArmRole::Weight,
        p: Some(0.1),
        q: Some(0.05),
        w: Some(w),
    }
}

/// A weighted arm that reads as the metrics say (`arm_with`'s cached metrics).
fn warm(w: f64, never_1: usize, never_3: usize, pick_3: usize) -> ArmScore {
    arm_with(weight_spec(w), never_1, never_3, pick_3)
}

/// The reference arm of the `w` read, reading as the metrics say.
fn wref(never_1: usize, never_3: usize, pick_3: usize) -> ArmScore {
    arm_with(roster_spec(0.1, 0.05), never_1, never_3, pick_3)
}

/// The `w` read on a development-only list (the holdout empty).
fn dev_read(arms: &[ArmScore]) -> engine_core::reference::tier_b_rule::WeightRead {
    weight_read(arms, ARM_A, W0, HoldoutState::Empty).expect("a weighted arm is present")
}

fn dev_pick(arms: &[ArmScore]) -> Option<f64> {
    dev_read(arms).pick
}

/// T13. Each key alone decides between `w = 1` and a weight, in the order `never@1`, `never@3`,
/// `pick@3`, the last by most; another roster arm that would win every key is not on the `w` axis, and
/// the weights are readable (`readable_metrics`, not `readable()`, which is false on every weight).
/// Mutation per key: drop `never@1` (case 1 keeps w = 1), drop `never@3` (case 2), drop `pick@3` (case 3
/// and 4), fewest instead of most `pick@3` (case 4), the keys read in another order (case 1 or 2);
/// reading `readable()` (every weight unreadable: all four cases pick w = 1); reading every arm of the
/// run, not the `w` axis (the roster arm wins).
#[test]
fn each_key_alone_decides_between_one_and_a_weight() {
    let rival = arm_with(roster_spec(0.15, 0.05), 0, 0, 99);
    let cases: [(ArmScore, ArmScore, f64); 4] = [
        // never@1 alone, though the weight is worse on both other keys.
        (wref(1, 0, 9), warm(2.0, 0, 5, 0), 2.0),
        // never@3 alone, among arms tied on never@1.
        (wref(1, 2, 9), warm(2.0, 1, 1, 0), 2.0),
        // pick@3 alone, a larger count wins.
        (wref(1, 1, 4), warm(2.0, 1, 1, 5), 2.0),
        // pick@3 the other way: the weight has fewer, so w = 1 stays.
        (wref(1, 1, 5), warm(2.0, 1, 1, 4), 1.0),
    ];
    for (i, (reference, weight, want)) in cases.into_iter().enumerate() {
        let arms = [rival.clone(), reference, weight];
        assert_eq!(dev_pick(&arms), Some(want), "case {}", i + 1);
    }
}

/// T13. A three-key tie keeps `w = 1`; two tied weights go to the fewest steps from `w = 1` along the
/// sorted `w` axis (`w₀` on it), then the smaller `w`. An unreadable weight is still on the axis, and
/// steps count positions on the axis, not distance in `w`.
/// Mutation: `w₀` missing from the axis
/// or steps in `w` itself (case 3: 1.5 is nearer to 1 in value than 0.1); the smaller `w` before the
/// steps (case 2); the larger `w` on equal steps (case 3); an unreadable weight dropped from the axis
/// (case 4).
#[test]
fn ties_keep_one_then_the_fewest_steps_then_the_smaller_w() {
    // 1: a three-key tie of all three keeps w = 1, though 0.5 is the smaller w.
    let arms = [wref(1, 1, 1), warm(0.5, 1, 1, 1), warm(2.0, 1, 1, 1)];
    assert_eq!(dev_pick(&arms), Some(1.0));
    // 2: axis [0.25, 0.5, 1, 1.5]; 0.25 and 1.5 tie, 1.5 is one step away and 0.25 two.
    let arms = [
        wref(2, 2, 0),
        warm(0.25, 1, 1, 0),
        warm(0.5, 2, 2, 0),
        warm(1.5, 1, 1, 0),
    ];
    assert_eq!(dev_pick(&arms), Some(1.5));
    // 3: axis [0.1, 1, 1.5]; both one step away, the smaller w wins (by value 1.5 would be nearer).
    let arms = [wref(2, 2, 0), warm(0.1, 1, 1, 0), warm(1.5, 1, 1, 0)];
    assert_eq!(dev_pick(&arms), Some(0.1));
    // 4: axis [0.25, 0.5, 1, 2] with 0.5 unreadable: 0.25 is two steps, 2 is one.
    let mut unreadable = warm(0.5, 0, 0, 9);
    unreadable.all.unjudged = [1, 0, 0, 0];
    let arms = [
        wref(2, 2, 0),
        warm(0.25, 1, 1, 0),
        unreadable,
        warm(2.0, 1, 1, 0),
    ];
    assert_eq!(dev_pick(&arms), Some(2.0));
}

/// T14. An unreadable weight is named and left out (its keys are the best; it is not picked); the read
/// still lists it, unreadable. An unreadable reference arm leaves no read (no pick, no recommendation,
/// no reason); a weight that does not speak at every position is unreadable too.
/// Mutation: an unreadable weight picked; unreadable weights dropped from the list; an unreadable
/// reference arm read anyway; `speaking == positions` not required.
#[test]
fn an_unreadable_weight_is_named_and_left_out_and_an_unreadable_reference_gives_no_read() {
    let mut judged = warm(3.0, 0, 0, 9);
    judged.all.unjudged = [0, 1, 0, 0];
    let mut silent = warm(4.0, 0, 0, 9);
    silent.all.speaking = 2;
    let arms = [wref(2, 2, 0), judged, silent, warm(2.0, 1, 1, 0)];
    let read = dev_read(&arms);
    assert_eq!(read.pick, Some(2.0));
    let listed: Vec<(f64, bool)> = read
        .arms
        .iter()
        .map(|a| (a.w, a.development_readable))
        .collect();
    assert_eq!(
        listed,
        [(1.0, true), (3.0, false), (4.0, false), (2.0, true)],
        "the reference first with w₀, then each weight in run order"
    );
    assert_eq!((read.p, read.q), (0.1, 0.05));

    let mut reference = wref(2, 2, 0);
    reference.all.unjudged = [1, 1, 0, 0];
    let read = dev_read(&[reference, warm(2.0, 0, 0, 9)]);
    assert_eq!((read.pick, read.recommend), (None, None));
    assert!(read.reason.is_none());
}

/// No weighted arm in the run: no read at all.
/// Mutation: a read made of the reference arm alone.
#[test]
fn no_weighted_arm_is_no_read() {
    let arms = [wref(1, 1, 1), arm_with(roster_spec(0.15, 0.05), 0, 0, 9)];
    assert!(weight_read(&arms, ARM_A, W0, HoldoutState::Empty).is_none());
}

fn open_read(
    dev: &[ArmScore],
    hold: &[ArmScore],
) -> engine_core::reference::tier_b_rule::WeightRead {
    weight_read(dev, ARM_A, W0, HoldoutState::Open(hold)).expect("a weighted arm is present")
}

/// T15. A pick better on `never@1` and worse on `never@3` on the holdout is blocked, naming `never@3`;
/// each key blocks alone (`never@1` worse, `pick@3` lower); equal on every key is not worse; and a pick
/// that is better everywhere is recommended.
/// Mutation: a lexicographic holdout comparison (case 1 passes); a key dropped (its case passes); `<`
/// where the rule is `<=` (the equal case blocks).
#[test]
fn the_holdout_is_read_per_key_not_lexicographically() {
    // Development: w2 beats w = 1 strictly.
    let dev = [wref(2, 2, 1), warm(2.0, 0, 0, 3)];
    let blocked = |hold_pick: ArmScore| open_read(&dev, &[wref(1, 2, 2), hold_pick]);
    // 1: better on never@1 (0 < 1), worse on never@3 (3 > 2).
    let read = blocked(warm(2.0, 0, 3, 2));
    assert_eq!(read.recommend, None);
    assert_eq!(
        read.reason,
        Some(WeightReason::WorseOnHoldout { key: "never@3" })
    );
    // 2: worse on never@1 alone.
    let read = blocked(warm(2.0, 2, 2, 2));
    assert_eq!(
        read.reason,
        Some(WeightReason::WorseOnHoldout { key: "never@1" })
    );
    // 3: worse on pick@3 alone (a lower count is worse).
    let read = blocked(warm(2.0, 1, 2, 1));
    assert_eq!(
        read.reason,
        Some(WeightReason::WorseOnHoldout { key: "pick@3" })
    );
    // 4: equal on every key is not worse.
    let read = blocked(warm(2.0, 1, 2, 2));
    assert_eq!(read.recommend, Some(2.0));
    assert_eq!(read.reason, None);
    // 5: better everywhere.
    let read = blocked(warm(2.0, 0, 0, 5));
    assert_eq!(read.recommend, Some(2.0));
    // The holdout's own metrics ride along on every arm, readable.
    assert!(read
        .arms
        .iter()
        .all(|a| a.holdout.as_ref().is_some_and(|h| h.1)));
}

/// Three development positions in three drafts, read at the reference arm, `w2` and `w3`. The reference
/// has the `never` first everywhere; `w2` at d1 and d2, `w3` at d1 only. Whole: `w3` wins (1 against 2).
/// Without d1 `w3` wins (0 against 1); without d2 `w2` and `w3` tie at 1 and the nearer `w2` is picked;
/// without d3 `w3` wins again.
fn leave_out_arms() -> Vec<ArmScore> {
    let (w2, w3) = ("roster:0.1:0.05:w2", "roster:0.1:0.05:w3");
    let mk = |id: &str, draft: &str, a: &[(u8, f64)], b: &[(u8, f64)]| {
        rpos(
            id,
            draft,
            Side::Blue,
            None,
            &LABELS,
            None,
            &[(ARM_A, &BAD_C2_AT_2), (w2, a), (w3, b)],
        )
    };
    let (bad, good) = (&BAD_C2_AT_2[..], &GOOD_C2_AT_2[..]);
    let ps = [
        mk("p1", "d1", bad, bad),
        mk("p2", "d2", bad, good),
        mk("p3", "d3", good, good),
    ];
    let specs = [roster_spec(0.1, 0.05), weight_spec(2.0), weight_spec(3.0)];
    read_arms(&refs(&ps), &specs, FoldKind::Rule, 0.01)
}

/// T16. With a draft left out the pick changes: the development pick is `w3` and the read stays at 1,
/// naming d2, the draft whose absence picks `w2`; "the same `w` is picked" is the test, not "still beats
/// `w = 1`" (`w2` does at d2 too); every draft is listed in order with the pick it gives.
/// Mutation: leave-one-draft-out ignored; the draft kept (`without_draft` not applied); the test read as
/// "some weight still beats 1"; the first moving draft not the one named.
#[test]
fn a_pick_that_moves_without_one_draft_stays_at_one() {
    let dev = leave_out_arms();
    let hold = [wref(1, 1, 1), warm(3.0, 0, 0, 2)];
    let read = open_read(&dev, &hold);
    assert_eq!(read.pick, Some(3.0));
    assert_eq!(
        read.leave_out,
        [
            ("d1".to_string(), Some(3.0)),
            ("d2".to_string(), Some(2.0)),
            ("d3".to_string(), Some(3.0)),
        ]
    );
    assert_eq!(read.recommend, None);
    assert_eq!(
        read.reason,
        Some(WeightReason::PickMovesWithout {
            draft: "d2".to_string()
        })
    );
    // The other way round: with the same pick everywhere the weight is recommended. Drop the arm that
    // makes d2 move (w2 never as good) and every leave-out gives w3.
    let steady: Vec<ArmScore> = dev
        .iter()
        .filter(|a| a.spec.id != "roster:0.1:0.05:w2")
        .cloned()
        .collect();
    let read = open_read(&steady, &hold);
    assert_eq!(read.recommend, Some(3.0));
    assert_eq!(read.reason, None);
    assert!(read.leave_out.iter().all(|(_, p)| *p == Some(3.0)));
}

/// T17. A sealed or empty holdout reads "w stays 1" whatever the development read, with its own reason;
/// and the reasons come in design § 4's order: no weight beating 1 comes before the holdout's, and the
/// holdout's own before unreadable, worse and the moving pick.
/// Mutation: the holdout step skipped when there is none; the reasons in another order (each pair here
/// pins one adjacent pair).
#[test]
fn a_sealed_or_empty_holdout_keeps_one_and_the_reasons_come_in_order() {
    let dev = [wref(2, 2, 1), warm(2.0, 0, 0, 3)];
    for (state, want) in [
        (HoldoutState::Sealed, WeightReason::HoldoutSealed),
        (HoldoutState::Empty, WeightReason::HoldoutEmpty),
    ] {
        let read = weight_read(&dev, ARM_A, W0, state).expect("read");
        assert_eq!(read.pick, Some(2.0), "the development read stands");
        assert_eq!(read.recommend, None);
        assert_eq!(read.reason, Some(want));
    }
    // No weight beats 1: the reason is that, not the holdout's.
    let dev_flat = [wref(0, 0, 3), warm(2.0, 1, 1, 0)];
    let read = weight_read(&dev_flat, ARM_A, W0, HoldoutState::Sealed).expect("read");
    assert_eq!(read.pick, Some(1.0));
    assert_eq!(read.reason, Some(WeightReason::NoWeightBeatsOne));
    // Unreadable before worse: the pick is worse on the holdout and also has an unjudged@3.
    let mut unjudged = warm(2.0, 5, 5, 0);
    unjudged.all.unjudged = [0, 1, 0, 0];
    let read = open_read(&dev, &[wref(0, 0, 3), unjudged]);
    assert!(matches!(
        read.reason,
        Some(WeightReason::HoldoutUnreadable { .. })
    ));
    // Worse before the moving pick (the d2 fixture, a holdout where w3 is worse).
    let read = open_read(&leave_out_arms(), &[wref(0, 0, 3), warm(3.0, 1, 0, 3)]);
    assert_eq!(
        read.reason,
        Some(WeightReason::WorseOnHoldout { key: "never@1" })
    );
}

/// T18. An opened holdout with one `unjudged@3` at the pick reads "w stays 1 (the holdout is not
/// readable at <w> ...)" though every key of the pick is better; the reference arm's own unreadability
/// is named first, at `w = 1`; a holdout arm that does not speak counts as `silent`; a pick missing
/// from the holdout arms is unreadable too.
/// Mutation: an unreadable holdout read as not worse; the reference checked after the pick; `silent`
/// not counted; `unjudged` summed over metrics instead of counted as positions (the position unjudged at both k counts twice).
#[test]
fn an_unreadable_opened_holdout_is_a_reason_never_not_worse() {
    let dev = [wref(2, 2, 1), warm(2.0, 0, 0, 3)];
    // Positions, not metric sums: one position unjudged at both k = 1 and k = 3 counts once.
    let (w2, positions) = (weight_spec(2.0), [(0u8, "h1"), (0u8, "h2")]);
    let ps: Vec<PositionInput> = positions
        .iter()
        .map(|(_, id)| {
            rpos(
                id,
                id,
                Side::Blue,
                None,
                &LABELS,
                None,
                &[(ARM_A, &BAD_C2_AT_2), (&w2.id, &GOOD_C2_AT_2)],
            )
        })
        .collect();
    let mut held = read_arms(
        &refs(&ps),
        &[roster_spec(0.1, 0.05), w2],
        FoldKind::Rule,
        0.01,
    );
    let mut rows = held[1].rows.clone();
    rows[0].score.as_mut().expect("speaks").unjudged = [true, true, false, false];
    held[1] = ArmScore::new(held[1].spec.clone(), rows);
    assert_eq!(
        held[1].all.unjudged[..2],
        [1, 1],
        "the premise: the sums say 2"
    );
    let read = open_read(&dev, &held);
    assert_eq!(
        read.reason,
        Some(WeightReason::HoldoutUnreadable {
            at: 2.0,
            unjudged: 1,
            silent: 0
        })
    );
    assert_eq!(
        read.reason.as_ref().map(|r| r.text(W0)).as_deref(),
        Some("the holdout is not readable at w = 2 (1 unjudged at 1 or 3, 0 silent)")
    );
    // The reference unreadable on the holdout, with one silent position: named first, at w = 1.
    let mut reference = wref(1, 1, 1);
    reference.all.speaking = 2;
    let read = open_read(&dev, &[reference, warm(2.0, 0, 0, 9)]);
    assert_eq!(
        read.reason,
        Some(WeightReason::HoldoutUnreadable {
            at: 1.0,
            unjudged: 0,
            silent: 1
        })
    );
    // No holdout positions at all (a read over none is never readable).
    let mut none = wref(0, 0, 0);
    none.all.positions = 0;
    none.all.speaking = 0;
    let read = open_read(&dev, &[none, warm(2.0, 0, 0, 9)]);
    assert!(matches!(
        read.reason,
        Some(WeightReason::HoldoutUnreadable { at, .. }) if at == 1.0
    ));
}

/// The fixture of T19 and the wire tests: two drafts, the reference arm and B at the grid, a weight that
/// ranks every position well (w1.5) and one that does not (w2).
fn weight_fixture() -> (Vec<PositionInput>, Vec<ArmSpec>) {
    let (w15, w2) = ("roster:0.1:0.05:w1.5", "roster:0.1:0.05:w2");
    let ps: Vec<PositionInput> = ["d1", "d2"]
        .iter()
        .map(|d| {
            rpos(
                &format!("{d}-a"),
                d,
                Side::Blue,
                None,
                &LABELS,
                Some(2),
                &[
                    (ARM_A, &BAD_C2_AT_2),
                    (ARM_B, &BAD_C2_AT_2),
                    (w15, &GOOD_C2_AT_2),
                    (w2, &BAD_C2_AT_2),
                ],
            )
        })
        .collect();
    let mut specs = specs_ab();
    specs.push(weight_spec(1.5));
    specs.push(weight_spec(2.0));
    (ps, specs)
}

/// T19. Through `read_run`: the read exists (the development pick is 1.5), the block follows the floor
/// rows and names P and Q on its first line, prints `never@1 / never@3 / pick@3` for every `w` (`pick@3`
/// too: 2 of 2 at each), then the pick, the verdict with its reason (all positions are development
/// until the split, so the holdout is empty), the leave-one-out line and the receipt from `w = 1`. Absent
/// when no weighted arm is in the run.
/// Mutation: the block printed without weighted arms; `pick@3` missing; P and Q not named; the receipt
/// missing; the block before the floor rows.
#[test]
fn the_summary_prints_the_w_block_with_pick_at_3_for_every_w() {
    let (ps, specs) = weight_fixture();
    let inputs = refs(&ps);
    let read = read_run(&inputs, &specs, ARM_A, 0.01, false);
    let weight = read.weight.as_ref().expect("weighted arms are present");
    assert_eq!(weight.pick, Some(1.5));
    assert_eq!(weight.reason, Some(WeightReason::HoldoutEmpty));
    let header = test_header(&[ARM_A, ARM_B, "roster:0.1:0.05:w1.5", "roster:0.1:0.05:w2"]);
    let text = summary_of(&header, &read, &inputs);
    let start = text
        .find("Synergy weight (at P 0.1 Q 0.05)")
        .unwrap_or_else(|| panic!("no block\n{text}"));
    assert!(
        text.find("Floor rows").expect("the floor rows") < start,
        "the block follows the floor rows\n{text}"
    );
    let block: Vec<&str> = text[start..].lines().take(8).collect();
    assert_eq!(
        block,
        [
            "Synergy weight (at P 0.1 Q 0.05): never@1 / never@3 / pick@3 on development",
            "  w = 1 (the reference)  2/2/2  readable",
            "  w = 1.5  0/0/2  readable",
            "  w = 2  2/2/2  readable",
            "  development pick: w = 1.5",
            "  verdict: w stays 1 (the holdout is empty)",
            "  each draft left out: d1 → w = 1.5, d2 → w = 1.5",
            "  Receipt, w = 1 → w = 1.5 (development):",
        ]
    );
    let receipt = text[start..]
        .lines()
        .nth(8)
        .expect("a receipt line follows");
    assert!(receipt.starts_with("    never@1 2 → 0 "), "{receipt}");

    // Without weighted arms there is no block and no key.
    let plain = [rpos(
        "p",
        "d",
        Side::Blue,
        None,
        &LABELS,
        Some(2),
        &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
    )];
    let inputs = refs(&plain);
    let read = read_run(&inputs, &specs_ab(), ARM_A, 0.01, false);
    assert!(read.weight.is_none());
    let header = test_header(&[ARM_A, ARM_B]);
    assert!(!summary_of(&header, &read, &inputs).contains("Synergy weight"));
    let wire = engine_core::reference::tier_b_summary::metrics_of(&header, &read, &inputs)
        .expect("labelled");
    assert!(wire.get("weight").is_none());
}

/// The block names an unreadable weight and why, and prints the holdout beside development when it is
/// open, with a verdict line that recommends.
/// Mutation: an unreadable weight printed as readable; the holdout cell missing when open; a
/// recommendation worded as "stays".
#[test]
fn the_block_names_an_unreadable_weight_and_shows_an_open_holdout() {
    let (ps, specs) = weight_fixture();
    let inputs = refs(&ps);
    let mut read = read_run(&inputs, &specs, ARM_A, 0.01, false);
    let mut judged = warm(2.0, 2, 2, 2);
    judged.all.unjudged = [1, 1, 0, 0];
    let dev = [wref(2, 2, 2), warm(1.5, 0, 0, 2), judged];
    let hold = [wref(1, 1, 1), warm(1.5, 0, 0, 2), warm(2.0, 1, 1, 1)];
    read.weight = weight_read(&dev, ARM_A, W0, HoldoutState::Open(&hold));
    let header = test_header(&[ARM_A, ARM_B]);
    let text = summary_of(&header, &read, &inputs);
    assert!(
        text.contains("  w = 1.5  0/0/2  readable  | holdout 0/0/2  readable\n"),
        "{text}"
    );
    assert!(
        text.contains(
            "  w = 2  ≥2/≥2/2  not readable: 1 unjudged at k = 1, 1 at k = 3  | holdout 1/1/1  readable\n"
        ),
        "{text}"
    );
    assert!(text.contains("  verdict: w = 1.5 recommended\n"), "{text}");
}

/// `metrics.weight`, as design § 4 gives it: `at`, `w0`, `arms` (the reference first with `w₀`, each with
/// `development` and `readable` and the arm's metrics, and `holdout` only when opened), `pick`,
/// `verdict` with `recommend` and the reason text, `leave_out`. Absent without weighted arms.
/// Mutation: a field renamed or missing; `holdout` always written; the reason not text; the reference
/// arm not first.
#[test]
fn metrics_weight_is_the_design_shape_and_the_holdout_only_when_open() {
    let (ps, specs) = weight_fixture();
    let inputs = refs(&ps);
    let header = test_header(&[ARM_A, ARM_B, "roster:0.1:0.05:w1.5", "roster:0.1:0.05:w2"]);
    let mut read = read_run(&inputs, &specs, ARM_A, 0.01, false);
    let wire = engine_core::reference::tier_b_summary::metrics_of(&header, &read, &inputs)
        .expect("labelled");
    let w = &wire["weight"];
    assert_eq!(w["at"], json!({"p": 0.1, "q": 0.05}));
    assert_eq!(w["w0"], json!(1.0));
    assert_eq!(w["pick"], json!(1.5));
    assert_eq!(
        w["verdict"],
        json!({"recommend": null, "reason": "the holdout is empty"})
    );
    assert_eq!(
        w["leave_out"],
        json!([{"draft": "d1", "pick": 1.5}, {"draft": "d2", "pick": 1.5}])
    );
    let arms = array(&w["arms"], "weight arms");
    let ids: Vec<&str> = arms.iter().map(|a| a["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [ARM_A, "roster:0.1:0.05:w1.5", "roster:0.1:0.05:w2"]);
    assert_eq!(arms[0]["w"], json!(1.0));
    assert_eq!(arms[1]["w"], json!(1.5));
    for a in arms {
        assert!(
            a.get("holdout").is_none(),
            "sealed or empty: no holdout key"
        );
        assert_eq!(a["development"]["readable"], json!(true));
        assert_eq!(a["development"]["positions"], json!(2));
    }
    let first_two = |v: &Value| (v[0].clone(), v[1].clone());
    assert_eq!(
        first_two(&arms[1]["development"]["never"]),
        (json!(0), json!(0))
    );
    assert_eq!(
        first_two(&arms[0]["development"]["never"]),
        (json!(2), json!(2))
    );
    assert_eq!(
        first_two(&arms[0]["development"]["pick"]),
        (json!(0), json!(2))
    );

    // Opened: `holdout` rides on every arm, with its own readable.
    let dev: Vec<ArmScore> = read.arms.clone();
    let hold = [wref(1, 1, 1), warm(1.5, 0, 0, 2), warm(2.0, 1, 1, 1)];
    read.weight = weight_read(&dev, ARM_A, W0, HoldoutState::Open(&hold));
    let wire = engine_core::reference::tier_b_summary::metrics_of(&header, &read, &inputs)
        .expect("labelled");
    let w = &wire["weight"];
    assert_eq!(w["verdict"], json!({"recommend": 1.5, "reason": null}));
    for a in array(&w["arms"], "weight arms") {
        assert_eq!(a["holdout"]["readable"], json!(true));
        assert_eq!(a["holdout"]["positions"], json!(3));
    }
}

// ---- Task 4 (slice B): the development / holdout split (engine design § 5, T20-T22) -----------------

fn holdout_data(name: &str) -> Value {
    review_data(&format!("holdout/{name}"))
}

/// The loader's warnings about the split, out of the others (data-version mismatches and the like).
fn split_warnings(l: &Loaded) -> Vec<String> {
    l.warnings
        .iter()
        .filter(|w| w.contains("split"))
        .cloned()
        .collect()
}

/// T20. `split` absent or `"development"` is development; `"holdout"` (on an `ho-` draft) is holdout;
/// `null` is absent. Anything else is refused naming the field `split`, whatever its JSON type.
/// Kills: unknown values accepted (read as development); a case-insensitive match; a non-string value
/// refused by the JSON reader without naming the field.
#[test]
fn a_fixtures_split_is_development_or_holdout_and_anything_else_names_the_field() {
    let live = live();
    assert_eq!(
        loaded(&labelled(), &live).fixture.split,
        CorpusSplit::Development
    );
    for value in [json!("development"), Value::Null] {
        let mut file = labelled();
        file["split"] = value.clone();
        assert_eq!(
            loaded(&file, &live).fixture.split,
            CorpusSplit::Development,
            "{value}"
        );
    }
    let ho = loaded(&holdout_data("ho-blind.json"), &live);
    assert_eq!(ho.fixture.split, CorpusSplit::Holdout);
    assert!(split_warnings(&ho).is_empty(), "{:?}", ho.warnings);
    for bad in [
        json!("Holdout"),
        json!("dev"),
        json!(""),
        json!(1),
        json!(true),
    ] {
        let mut file = labelled();
        file["split"] = bad.clone();
        let (field, reason) = invalid(&file, &live);
        assert_eq!(field, "split", "{bad}");
        assert_eq!(
            reason,
            format!("must be \"development\" or \"holdout\", got {bad}")
        );
    }
}

/// T20, the naming rule from `from_json`, both ways: a holdout whose draft does not start with `ho-`,
/// and a development fixture (absent, explicit or `null` split) whose draft does, are `SplitName`; a bad
/// `split` on an `ho-` draft is `SplitValue`. Both stop the run, an ordinary `Invalid` does not, and the
/// split is checked before anything else the loader refuses.
/// Kills: the rule one way only; a bad value on an `ho-` draft as an ordinary load error (it would
/// shrink the holdout silently); a split error that does not stop the run; the split checked after the
/// format (a holdout fixture with a second mistake would drop out as an ordinary error).
#[test]
fn the_ho_rule_holds_both_ways_and_a_bad_split_on_an_ho_draft_stops_the_run() {
    let live = live();
    let refused = |file: &Value| load(file, &live).expect_err("refused");

    let mut file = labelled();
    file["split"] = json!("holdout");
    let err = refused(&file);
    assert!(err.stops_the_run(), "{err}");
    assert!(
        matches!(&err, TierBError::SplitName { label, id, draft, split }
            if label == "edited" && id == "labelled-position" && draft == "labelled-position"
                && *split == CorpusSplit::Holdout),
        "{err:?}"
    );
    assert!(
        err.to_string().starts_with(
            "edited: labelled-position: split: a holdout fixture's draft must start with \"ho-\""
        ),
        "{err}"
    );

    for value in [None, Some(json!("development")), Some(Value::Null)] {
        let mut file = holdout_data("ho-blind.json");
        match &value {
            None => {
                file.as_object_mut().expect("an object").remove("split");
            }
            Some(v) => file["split"] = v.clone(),
        }
        let err = refused(&file);
        assert!(err.stops_the_run(), "{value:?}: {err}");
        assert!(
            matches!(&err, TierBError::SplitName { draft, split, .. }
                if draft == "ho-blind" && *split == CorpusSplit::Development),
            "{value:?}: {err:?}"
        );
    }

    let mut file = holdout_data("ho-blind.json");
    file["split"] = json!("holdOut");
    let err = refused(&file);
    assert!(err.stops_the_run(), "{err}");
    assert!(
        matches!(&err, TierBError::SplitValue { label, draft, value, .. }
            if label == "edited" && draft == "ho-blind" && value == "\"holdOut\""),
        "{err:?}"
    );
    assert!(err.to_string().contains("split"), "{err}");

    let mut file = labelled();
    file["split"] = json!("holdOut");
    assert!(!refused(&file).stops_the_run());

    let mut file = holdout_data("ho-blind.json");
    file["split"] = json!("development");
    file["format"] = json!("fearless");
    assert!(matches!(refused(&file), TierBError::SplitName { .. }));
}

/// T20, fail closed (review M1): a fixture whose `id` names an `ho-` draft and that fails to load for
/// any other reason (a misspelled key the JSON reader refuses, a position the loader refuses) is
/// `HoldoutUnloadable` and stops the run, naming the file; the same mistakes on a development fixture
/// stay ordinary load errors.
/// Kills: a holdout file that fails the JSON read (or any later check) dropped as an ordinary load
/// error, silently shrinking the holdout; every load error made fatal.
#[test]
fn a_holdout_fixture_that_does_not_load_stops_the_run() {
    let live = live();
    let rename = |mut file: Value, from: &str, to: &str| {
        let o = file.as_object_mut().expect("an object");
        let v = o.remove(from).expect("the key");
        o.insert(to.to_string(), v);
        file
    };
    let bad_position = |mut file: Value| {
        file["position"][0]["champion"] = json!("NotAChampion");
        file
    };
    for (name, file) in [
        (
            "misspelled split",
            rename(holdout_data("ho-blind.json"), "split", "Split"),
        ),
        (
            "misspelled notes",
            rename(holdout_data("ho-blind.json"), "notes", "note"),
        ),
        ("bad position", bad_position(holdout_data("ho-blind.json"))),
    ] {
        let err = load(&file, &live).expect_err("refused");
        assert!(err.stops_the_run(), "{name}: {err}");
        assert!(
            matches!(&err, TierBError::HoldoutUnloadable { label, id, draft, .. }
                if label == "edited" && id == "2026-11-09-ho-blind-pinch-slot-9" && draft == "ho-blind"),
            "{name}: {err:?}"
        );
        assert!(err.to_string().starts_with("edited: "), "{name}: {err}");
    }
    for (name, file) in [
        ("misspelled notes", rename(labelled(), "notes", "note")),
        ("bad position", bad_position(labelled())),
    ] {
        let err = load(&file, &live).expect_err("refused");
        assert!(!err.stops_the_run(), "{name}: {err}");
    }
}

/// T20 through `load_dir` (which `load_file` and the binary go through): the two holdout copies load as
/// holdout, the revealed one with the warning and the blind one without; the misnamed copy's error
/// carries its path. A `SplitName` reaching `run_review` is listed among `load_errors` like any other
/// (only the binary stops on it).
/// Kills: the label taken from the id (it would not name the file); the warning on every holdout, or on
/// none.
#[test]
fn the_holdout_copies_load_and_a_misnamed_one_names_its_file() {
    let live = live();
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/tier-b-review/holdout");
    let results = TierBFixture::load_dir(&dir, &live).expect("the directory reads");
    assert_eq!(results.len(), 3);
    let bad = results[0].as_ref().expect_err("bad-name.json is refused");
    match bad {
        TierBError::SplitName { label, split, .. } => {
            assert_eq!(PathBuf::from(label), dir.join("bad-name.json"));
            assert_eq!(*split, CorpusSplit::Holdout);
        }
        other => panic!("expected SplitName, got {other:?}"),
    }
    assert!(bad.to_string().contains("bad-name.json"), "{bad}");

    let blind = results[1].as_ref().expect("ho-blind loads");
    assert_eq!(blind.fixture.split, CorpusSplit::Holdout);
    assert_eq!(draft_of(&blind.fixture.id), "ho-blind");
    assert!(split_warnings(blind).is_empty(), "{:?}", blind.warnings);
    let scored = results[2].as_ref().expect("ho-scored loads");
    assert_eq!(scored.fixture.split, CorpusSplit::Holdout);
    assert_eq!(
        split_warnings(scored),
        ["2026-11-09-ho-scored-pinch-slot-9: split: a sealed holdout position has been revealed (a scored verdict entry); the run still writes it sealed"]
    );

    let run = run_review(&results[..1], &live, &review_config());
    assert!(run.positions.is_empty());
    assert_eq!(run.load_errors, [bad.to_string()]);
}

/// Every fixture id of the real corpus on 2026-11-12 with its draft as `draft_of` gave it then.
const CORPUS_DRAFTS_2026_11_12: [(&str, &str); 23] = [
    ("2026-09-29-ad-pinch-slot-16-kittens", "ad"),
    ("2026-09-29-ad-pinch-slot-17-dme", "ad"),
    ("2026-09-29-ad-pinch-slot-19-kittens", "ad"),
    ("2026-09-29-mid-pinch-slot-16-kittens", "mid"),
    ("2026-09-29-mid-pinch-slot-17-dme", "mid"),
    ("2026-09-29-mid-pinch-slot-19-kittens", "mid"),
    ("2026-09-29-supp-pinch-slot-16-kittens", "supp"),
    ("2026-09-29-supp-pinch-slot-17-dme", "supp"),
    ("2026-09-29-supp-pinch-slot-19-kittens", "supp"),
    ("2026-09-29-top-pinch-slot-16-kittens", "top"),
    ("2026-09-29-top-pinch-slot-17-dme", "top"),
    ("2026-09-29-top-pinch-slot-19-kittens", "top"),
    ("2026-10-04-ad-pinch-slot-9-dme", "ad"),
    ("2026-10-04-mid-pinch-slot-7-kittens", "mid"),
    ("2026-10-04-supp-pinch-slot-11-kittens", "supp"),
    ("2026-10-04-supp-pinch-slot-17-dme", "supp"),
    ("2026-10-04-supp-pinch-slot-19-kittens", "supp"),
    ("2026-10-04-supp-pinch-slot-9-dme", "supp"),
    ("2026-10-04-top-pinch-slot-11-kittens", "top"),
    ("2026-10-04-top-pinch-slot-19-kittens", "top"),
    ("2026-10-04-top-pinch-slot-7-kittens", "top"),
    ("2026-10-07-synth-dme-adc-pinch-slot-17", "synth-dme-adc"),
    ("2026-10-07-synth-dme-top-pinch-slot-17", "synth-dme-top"),
];

/// T20: `draft_of` is unchanged on every id of the corpus (pinned from 2026-11-12, each a file there),
/// none of them reads as a holdout draft, and an `ho-` id groups as the design's example says.
/// Kills: `draft_of` changed to know the split (stripping `ho-`, say), which would move the
/// pre-registered sensitivity line's drafts.
#[test]
fn draft_of_is_unchanged_on_every_corpus_id() {
    let dir = repo_root().join("packages/engine-core/fixtures/tier-b");
    for (id, draft) in CORPUS_DRAFTS_2026_11_12 {
        assert_eq!(draft_of(id), draft, "{id}");
        assert!(!draft.starts_with("ho-"), "{id}");
        assert!(
            dir.join(format!("{id}.json")).exists(),
            "{id} is in the corpus"
        );
    }
    assert_eq!(
        draft_of("2026-12-02-ho-supp-pinch-slot-9-kittens"),
        "ho-supp"
    );
}

/// T20, the binary: a split error in the corpus (a misnamed holdout, a bad `split` on an `ho-`
/// draft, an `ho-` fixture that does not load) stops the run with exit 2 naming the file, before any
/// search and with nothing written, even with a good position beside it. `TIER_B_HOLDOUT` other than `open` is a usage error; `open` writes
/// `run.holdout_open: true`, and without it the key is absent.
/// Kills: the binary running past a split error (it would list it among the load errors and search the
/// rest); `TIER_B_HOLDOUT` ignored; any value read as open.
#[test]
fn the_binary_stops_on_a_split_error_naming_the_file_before_any_search() {
    let exe = env!("CARGO_BIN_EXE_tier_b_review");
    let base = std::env::temp_dir().join(format!("tier-b-review-split-{}", std::process::id()));
    let out = base.join("run.json");
    let command = |fixtures: &PathBuf| {
        let mut c = std::process::Command::new(exe);
        c.env("TIER_B_JSON", &out)
            .env("TIER_B_FIXTURES", fixtures)
            .env("TIER_B_P", "0.1")
            .env("TIER_B_Q", "0.05")
            .env("TIER_B_W", "1")
            .env("TIER_B_WIDTHS", "10,20,30")
            .env("TIER_B_DEPTH_CHECK", "0")
            .env("TIER_B_JOBS", "2")
            .env("TIER_B_RUN_ID", "2026-11-09T00:00:00Z")
            .env_remove("TIER_B_HOLDOUT");
        c
    };
    let mut bad_value = holdout_data("ho-blind.json");
    bad_value["split"] = json!("holdOut");
    let mut bad_key = holdout_data("ho-blind.json");
    let notes = bad_key
        .as_object_mut()
        .expect("an object")
        .remove("notes")
        .expect("notes");
    bad_key["note"] = notes;
    for (name, file) in [
        ("bad-name", holdout_data("bad-name.json")),
        ("bad-value", bad_value),
        ("bad-key", bad_key),
    ] {
        let dir = base.join(name);
        std::fs::create_dir_all(&dir).expect("a temp directory");
        std::fs::write(dir.join("labelled-position.json"), labelled().to_string()).expect("write");
        let path = dir.join(format!("{name}.json"));
        std::fs::write(&path, file.to_string()).expect("write");
        let ran = command(&dir).output().expect("the binary runs");
        let stderr = String::from_utf8_lossy(&ran.stderr);
        assert_eq!(ran.status.code(), Some(2), "{name}: {stderr}");
        assert!(
            stderr.contains(&path.display().to_string()),
            "{name}: {stderr}"
        );
        assert!(stderr.contains("split"), "{name}: {stderr}");
        assert!(
            !stderr.contains("positions,"),
            "{name}: a run was made: {stderr}"
        );
        assert!(!out.exists(), "{name}: a run was written");
    }

    let por = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/tier-b-review/por-only");
    let refused = command(&por)
        .env("TIER_B_HOLDOUT", "yes")
        .output()
        .expect("the binary runs");
    assert_eq!(refused.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&refused.stderr).contains("TIER_B_HOLDOUT"));
    assert!(!out.exists(), "TIER_B_HOLDOUT=yes: a run was written");
    for (holdout, opened) in [(Some("open"), Some(&json!(true))), (None, None)] {
        let mut c = command(&por);
        if let Some(h) = holdout {
            c.env("TIER_B_HOLDOUT", h);
        }
        let ran = c.output().expect("the binary runs");
        assert!(
            ran.status.success(),
            "{}",
            String::from_utf8_lossy(&ran.stderr)
        );
        let run: Value =
            serde_json::from_str(&std::fs::read_to_string(&out).expect("run.json")).expect("json");
        assert_eq!(run["run"].get("holdout_open"), opened, "{holdout:?}");
        std::fs::remove_file(&out).expect("clean up");
    }
    let _ = std::fs::remove_dir_all(&base);
}

/// T21 on constructed positions. Two development positions where arm B is the pick, and a holdout
/// position with a clear `never@1` at both arms (so at the pick), its own draft, an unlabelled row, an
/// `r` label, fallbacks and a revealed label change. Sealed or opened, the rule's arms, its pick, the
/// sensitivity line, the second line, `never_everywhere`, `r_by_label`, the fallbacks and the worklist
/// are those of the development positions alone. `reveal_changes` reads development while sealed and
/// both once opened. Opened, the holdout's own arms do read its `never@1` (the position bites).
/// Kills: the rule (or any read beside it) over every position; `reveal_changes` naming a sealed
/// holdout draft; an opened holdout read that is not the holdout's.
#[test]
fn a_holdout_position_changes_nothing_the_rule_reads() {
    let dev = |id: &str, draft: &str| {
        rpos(
            id,
            draft,
            Side::Blue,
            None,
            &LABELS,
            Some(2),
            &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &GOOD_C2_AT_2)],
        )
    };
    let only_dev = [dev("p1", "d1"), dev("p2", "d2")];
    let without = read_run(&refs(&only_dev), &specs_ab(), ARM_A, 0.01, false);
    assert_eq!(without.rule.pick.as_deref(), Some(ARM_B));
    assert!(without.holdout.is_none());

    let mut h = rpos(
        "ho-p",
        "ho-h",
        Side::Blue,
        None,
        &LABELS,
        Some(2),
        &[(ARM_A, &BAD_C2_AT_2), (ARM_B, &BAD_C2_AT_2)],
    );
    h.split = CorpusSplit::Holdout;
    h.unlabelled_rows = vec!["u1".to_string()];
    h.r_labels = vec![(RBucket::Below10, Label::Never)];
    h.label_fallbacks = 3;
    h.pick_fallback = true;
    h.reveal = RevealRead {
        revealed: true,
        blind_labels: 6,
        blind_pick: true,
        label_changes: vec![LabelChange {
            option: "c0".to_string(),
            blind: Label::Never,
            current: Label::Play,
        }],
        pick_change: None,
    };
    let mut all = only_dev.to_vec();
    all.push(h);
    for open in [false, true] {
        let with = read_run(&refs(&all), &specs_ab(), ARM_A, 0.01, open);
        assert_eq!(with.arms.len(), without.arms.len());
        for (a, b) in with.arms.iter().zip(&without.arms) {
            assert_eq!(a.spec.id, b.spec.id);
            assert_eq!(a.all, b.all, "{open}: {}", a.spec.id);
            let ids = |s: &ArmScore| s.rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
            assert_eq!(ids(a), ids(b), "{open}");
        }
        assert_eq!(with.rule, without.rule, "{open}");
        assert_eq!(with.sensitivity, without.sensitivity, "{open}");
        assert_eq!(with.second_line.outcome, without.second_line.outcome);
        assert_eq!(with.second_line.differs, without.second_line.differs);
        assert_eq!(with.never_everywhere, without.never_everywhere, "{open}");
        assert_eq!(with.r_by_label, without.r_by_label, "{open}");
        assert_eq!(with.fallbacks, without.fallbacks, "{open}");
        assert_eq!(with.worklist, without.worklist, "{open}");
        if open {
            assert_eq!(with.reveal_changes.drafts_revealed, ["ho-h"]);
            assert_eq!(with.reveal_changes.labels.len(), 1);
            assert_eq!(with.reveal_changes.blind_labels, 6);
        } else {
            assert_eq!(with.reveal_changes, without.reveal_changes);
        }
        let held = with.holdout.as_ref().expect("a holdout position");
        assert_eq!((held.positions, held.open), (1, open));
        assert_eq!(
            held.unlabelled_rows,
            [("ho-p".to_string(), vec!["u1".to_string()])]
        );
        if open {
            let pick = held
                .arms
                .iter()
                .find(|a| a.spec.id == ARM_B)
                .expect("the pick, read over the holdout");
            assert_eq!((pick.all.positions, pick.all.never[0]), (1, 1));
        } else {
            assert!(held.arms.is_empty(), "nothing is read of a sealed holdout");
        }
    }
}

/// The `w` read through `read_run`: its arms are read over the development positions only, and its
/// holdout is `Empty` without a holdout position (opened or not: M3), `Sealed` with one, and `Open` on
/// the holdout's own read once opened (here a copy of a development position, so the pick holds and is
/// recommended). The summary's receipt from `w = 1`, labelled development, reads development only.
/// Kills: the `w` read over every position; `Open(&[])` for an opened run without a holdout; `Sealed`
/// without a holdout position; a receipt from every position.
#[test]
fn read_run_hands_the_w_read_development_arms_and_the_holdout_state() {
    let (ps, specs) = weight_fixture();
    for open in [false, true] {
        let read = read_run(&refs(&ps), &specs, ARM_A, 0.01, open);
        let w = read.weight.expect("weighted arms");
        assert_eq!(w.reason, Some(WeightReason::HoldoutEmpty), "{open}");
        assert!(read.holdout.is_none());
    }
    let mut h = ps[0].clone();
    h.id = "ho-x-a".to_string();
    h.draft = "ho-x".to_string();
    h.split = CorpusSplit::Holdout;
    let mut all = ps.clone();
    all.push(h);
    let inputs = refs(&all);
    let header = test_header(&[ARM_A, ARM_B, "roster:0.1:0.05:w1.5", "roster:0.1:0.05:w2"]);
    for open in [false, true] {
        let read = read_run(&inputs, &specs, ARM_A, 0.01, open);
        let w = read.weight.as_ref().expect("weighted arms");
        for a in &w.arms {
            assert_eq!(a.development.positions, 2, "{open}: {}", a.id);
            assert_eq!(
                a.holdout.as_ref().map(|(m, _)| m.positions),
                open.then_some(1),
                "{open}: {}",
                a.id
            );
        }
        let drafts: Vec<&str> = w.leave_out.iter().map(|(d, _)| d.as_str()).collect();
        assert_eq!(drafts, ["d1", "d2"]);
        if open {
            assert_eq!((w.recommend, &w.reason), (Some(1.5), &None));
        } else {
            assert_eq!(w.reason, Some(WeightReason::HoldoutSealed));
        }
        let text = summary_of(&header, &read, &inputs);
        let at = text
            .find("  Receipt, w = 1 → w = 1.5 (development):\n")
            .unwrap_or_else(|| panic!("{text}"));
        assert!(
            text[at..]
                .lines()
                .nth(1)
                .expect("a receipt line")
                .starts_with("    never@1 2 → 0 "),
            "{text}"
        );
    }
}

/// T22, the summary and `metrics`, constructed. With a holdout position: the corpus line counts every
/// position, the labels line and `metrics.labels` development only, and the holdout line its count and
/// label progress. Sealed, that is all (`metrics.holdout` is `{positions, sealed, labels}`); opened, the
/// holdout's metrics at the reference arm (here also the pick) and at each weighted arm. The worklist
/// lists the holdout's unlabelled rows apart. Without a holdout position none of it appears.
/// Kills: a sealed holdout's metrics printed or written; the label counts over both splits; the
/// holdout's rows mixed into the development worklist; a holdout line without a holdout.
#[test]
fn the_summary_and_metrics_carry_the_holdout_count_sealed_and_its_read_opened() {
    use engine_core::reference::tier_b_summary::metrics_of;
    let (ps, specs) = weight_fixture();
    let header = test_header(&[ARM_A, ARM_B, "roster:0.1:0.05:w1.5", "roster:0.1:0.05:w2"]);
    {
        let inputs = refs(&ps);
        let read = read_run(&inputs, &specs, ARM_A, 0.01, true);
        let text = summary_of(&header, &read, &inputs);
        assert!(!text.contains("holdout:"), "{text}");
        assert!(!text.contains("holdout unlabelled"), "{text}");
        let wire = metrics_of(&header, &read, &inputs).expect("labelled");
        assert!(wire.get("holdout").is_none());
        assert!(wire["worklist"].get("holdout_unlabelled_rows").is_none());
    }
    let mut h = ps[0].clone();
    h.id = "ho-x-a".to_string();
    h.draft = "ho-x".to_string();
    h.split = CorpusSplit::Holdout;
    h.unlabelled_rows = vec!["u1".to_string(), "u2".to_string()];
    h.reveal.blind_labels = 4;
    let mut all = ps.clone();
    all.push(h);
    let inputs = refs(&all);

    let sealed = read_run(&inputs, &specs, ARM_A, 0.01, false);
    let text = summary_of(&header, &sealed, &inputs);
    assert!(text.contains("\n3 positions, 4 arms, "), "{text}");
    assert!(
        text.contains("labels: 12 options over 2 of 2 positions "),
        "{text}"
    );
    assert!(
        text.contains(
            "\nholdout: 1 positions, sealed (blind labels 4, own picks 1, unlabelled rows 2)\n"
        ),
        "{text}"
    );
    assert!(!text.contains("on the holdout"), "{text}");
    assert!(
        text.contains(
            "\n  holdout unlabelled rows: 2 over 1 positions\n    ho-x-a: 2\n      u1\n      u2\n"
        ),
        "{text}"
    );
    let wire = metrics_of(&header, &sealed, &inputs).expect("labelled");
    assert_eq!(wire["labels"]["positions"], json!(2));
    assert_eq!(wire["labels"]["options"], json!(12));
    let held = &wire["holdout"];
    assert_eq!(
        held.as_object()
            .expect("an object")
            .keys()
            .collect::<Vec<_>>(),
        ["labels", "positions", "sealed"]
    );
    assert_eq!(
        (&held["positions"], &held["sealed"]),
        (&json!(1), &json!(true))
    );
    assert_eq!(held["labels"]["positions"], json!(1));
    assert_eq!(held["labels"]["blind_options"], json!(4));
    assert_eq!(held["labels"]["own_picks"], json!(1));
    assert_eq!(
        wire["worklist"]["holdout_unlabelled_rows"],
        json!([{"position": "ho-x-a", "rows": ["u1", "u2"]}])
    );
    assert!(array(&wire["worklist"]["unlabelled_rows"], "rows").is_empty());

    let opened = read_run(&inputs, &specs, ARM_A, 0.01, true);
    let text = summary_of(&header, &opened, &inputs);
    let at = text
        .find("\nholdout: 1 positions, opened (blind labels 4, own picks 1, unlabelled rows 2); never@1 / never@3 / pick@3 over it:\n")
        .unwrap_or_else(|| panic!("{text}"));
    let block: Vec<&str> = text[at + 1..].lines().skip(1).take(3).collect();
    assert_eq!(
        block,
        [
            "  reference = pick, roster:0.1:0.05  1/1/1  readable",
            "  weight, roster:0.1:0.05:w1.5  0/0/1  readable",
            "  weight, roster:0.1:0.05:w2  1/1/1  readable",
        ],
        "{text}"
    );
    let wire = metrics_of(&header, &opened, &inputs).expect("labelled");
    let held = &wire["holdout"];
    assert_eq!(held["sealed"], json!(false));
    assert_eq!(held["reference"]["positions"], json!(1));
    assert_eq!(held["reference"]["never"][0], json!(1));
    assert_eq!(held["pick"], held["reference"]);
}

/// The labelled position under `k` 10 (narrow widths; no depth check, which the pinned run below
/// carries), alone and beside a holdout copy whose blind entry calls the reference arm's #1 (and
/// anything within ε of it) `never` (no rule pick is readable here, so the reference arm is where the
/// worklist reads), the copy sealed and opened: `(alone, sealed, opened)` as normalised JSON and the
/// two summaries.
fn split_runs() -> &'static (Value, Value, Value, String, String) {
    static RUNS: std::sync::OnceLock<(Value, Value, Value, String, String)> =
        std::sync::OnceLock::new();
    RUNS.get_or_init(|| {
        let live = live();
        // `depth_config`'s narrow widths keep the three runs cheap; the grid is `review_config`'s.
        let cfg = ReviewConfig {
            k: 10,
            shortlist: depth_config().shortlist,
            ..review_config()
        };
        let alone = run_of(&[labelled()], &cfg, &live);
        let alone_v = normalised(&alone);
        let reading = array(&alone_v["positions"][0]["readings"], "readings")
            .iter()
            .find(|r| r["arm"] == REFERENCE_ARM)
            .expect("the reference arm's reading");
        // The #1 and everything within ε of it `never`, so the #1 is a clear `never` (not a near tie
        // with an unlabelled #2, which would read unjudged).
        let ranked = array(&reading["ranked"], "ranked");
        let first = number(&ranked[0]["value"], "the #1's value");
        let mut copy = holdout_data("ho-blind.json");
        for r in ranked {
            if (first - number(&r["value"], "value")).abs() <= cfg.margin {
                copy["verdicts"][0]["labels"][text(&r["option"], "option")] = json!("never");
            }
        }
        let files = [labelled(), copy];
        let sealed = run_of(&files, &cfg, &live);
        let opened = run_of(
            &files,
            &ReviewConfig {
                holdout_open: true,
                ..cfg.clone()
            },
            &live,
        );
        (
            alone_v,
            normalised(&sealed),
            normalised(&opened),
            render_summary(&sealed),
            render_summary(&opened),
        )
    })
}

/// T21 in a run: beside the labelled position, a holdout copy with a clear `never@1` at the reference
/// arm changes nothing the rule reads, sealed or opened (the arms, the rule, sensitivity, second line,
/// `never_everywhere`, `r_by_label`, the labels and the worklist of `metrics`, and the development
/// position's own JSON), while the opened holdout read shows the `never@1`; `reveal_changes` takes the
/// holdout in only once opened.
/// Kills: the runner handing the rule every position; a development position written differently
/// because a holdout one is in the run.
#[test]
fn a_holdout_copy_in_a_run_moves_nothing_the_rule_reads() {
    let (alone, sealed, opened, _, _) = split_runs();
    for (name, run) in [("sealed", sealed), ("opened", opened)] {
        for key in [
            "labels",
            "arms",
            "rule",
            "sensitivity",
            "second_line",
            "never_everywhere",
            "r_by_label",
        ] {
            assert_eq!(run["metrics"][key], alone["metrics"][key], "{name}: {key}");
        }
        for key in [
            "unlabelled_rows",
            "lines_at",
            "unjudged_lines",
            "not_judgeable",
        ] {
            assert_eq!(
                run["metrics"]["worklist"][key], alone["metrics"]["worklist"][key],
                "{name}: worklist.{key}"
            );
        }
        assert_eq!(run["positions"][0], alone["positions"][0], "{name}");
    }
    assert_eq!(
        opened["metrics"]["holdout"]["reference"]["never"][0],
        json!(1)
    );
    assert!(sealed["metrics"]["holdout"].get("reference").is_none());
    // `reveal_changes` reads development while sealed, both splits once opened (the copy's blind labels
    // and pick count there; it has no `scored` entry, so no draft of it is revealed).
    let reveal = |run: &Value| run["metrics"]["reveal_changes"].clone();
    assert_eq!(reveal(sealed), reveal(alone));
    let (o, a) = (reveal(opened), reveal(alone));
    assert!(number(&o["blind_labels"], "n") > number(&a["blind_labels"], "n"));
    assert_eq!(
        number(&o["blind_picks"], "n"),
        number(&a["blind_picks"], "n") + 1.0
    );
    assert_eq!(o["drafts_revealed"], a["drafts_revealed"]);
}

/// Every object key anywhere under `v`.
fn keys_under(v: &Value, into: &mut BTreeSet<String>) {
    match v {
        Value::Object(o) => {
            for (k, x) in o {
                into.insert(k.clone());
                keys_under(x, into);
            }
        }
        Value::Array(a) => a.iter().for_each(|x| keys_under(x, into)),
        _ => {}
    }
}

/// T22 in a run. Sealed, the holdout position is written with its ranked keys kept and emptied
/// (`readings`, `reference_ranking`, every `menu` best; `depth_check.top_3` is the pinned run's), no key that carries a rank
/// or a value anywhere in it, and on every row a `band` that is the page's split of the opened run's
/// `reach` and `margin` (both bands occur at `k` 10); no `reach`. Everything else is the opened run's.
/// `split` is written on the holdout position only, `run.holdout_open` on the opened run only, and the
/// summary and `metrics` carry the sealed holdout's count, not its read. Opened, all of it is present.
/// Kills: sealing only the printout; an absent key (the page builder maps them unguarded); `band` from
/// another rule; `reach` left in; `split` on every position.
#[test]
fn a_sealed_holdout_position_is_written_with_nothing_ranked_or_valued() {
    let (_, sealed, opened, sealed_text, opened_text) = split_runs();
    assert!(sealed["run"].get("holdout_open").is_none());
    assert_eq!(opened["run"]["holdout_open"], json!(true));
    for run in [sealed, opened] {
        assert!(run["positions"][0].get("split").is_none());
        assert_eq!(run["positions"][1]["split"], "holdout");
    }
    let (s, o) = (&sealed["positions"][1], &opened["positions"][1]);

    assert_eq!(s["readings"], json!([]));
    assert_eq!(s["reference_ranking"], json!([]));
    assert!(!array(&o["readings"], "readings").is_empty());
    assert!(!array(&o["reference_ranking"], "ranking").is_empty());
    let menu_bests = |p: &Value| -> Vec<Value> {
        p["menu"]
            .as_object()
            .expect("menu")
            .values()
            .flat_map(|entries| {
                array(entries, "menu entries")
                    .iter()
                    .map(|e| e["best"].clone())
            })
            .collect()
    };
    assert!(!menu_bests(s).is_empty());
    assert!(menu_bests(s).iter().all(Value::is_null));
    assert!(menu_bests(o).iter().any(|b| !b.is_null()));

    let mut sealed_keys = BTreeSet::new();
    keys_under(s, &mut sealed_keys);
    let mut opened_keys = BTreeSet::new();
    keys_under(o, &mut opened_keys);
    for key in [
        "rank",
        "value",
        "reach",
        "gain_logit",
        "gain_pp",
        "mover_win_pct",
        "best_in_pool",
    ] {
        assert!(!sealed_keys.contains(key), "sealed: {key}");
        assert!(opened_keys.contains(key), "opened: {key}");
    }

    let (so, oo) = (
        s["options"].as_object().expect("options"),
        o["options"].as_object().expect("options"),
    );
    assert_eq!(so.keys().collect::<Vec<_>>(), oo.keys().collect::<Vec<_>>());
    let mut bands = BTreeSet::new();
    for (id, opt) in so {
        let open = &oo[id];
        let expected = (open["row"] == json!(true)).then(|| {
            let blind =
                open["reach"].as_u64().is_some_and(|r| r <= 5) || open["margin"] == json!(true);
            if blind {
                "blind"
            } else {
                "later"
            }
        });
        assert_eq!(opt.get("band").and_then(Value::as_str), expected, "{id}");
        bands.extend(expected);
        assert!(open.get("band").is_none(), "{id}");
        assert!(open.get("reach").is_some(), "{id}");
        let mut a = opt.clone();
        a.as_object_mut().expect("an option").remove("band");
        let mut b = open.clone();
        b.as_object_mut().expect("an option").remove("reach");
        assert_eq!(a, b, "{id}");
    }
    assert_eq!(bands, BTreeSet::from(["blind", "later"]));

    let strip = |p: &Value| {
        let mut p = p.clone();
        let o = p.as_object_mut().expect("a position");
        for key in ["readings", "reference_ranking", "menu", "options"] {
            o.remove(key);
        }
        p
    };
    assert_eq!(strip(s), strip(o));

    assert!(
        sealed_text.contains("\nholdout: 1 positions, sealed (blind labels "),
        "{sealed_text}"
    );
    assert!(!sealed_text.contains("over it:"), "{sealed_text}");
    assert!(
        opened_text.contains("; never@1 / never@3 / pick@3 over it:\n"),
        "{opened_text}"
    );
    assert_eq!(sealed["metrics"]["holdout"]["sealed"], json!(true));
    assert_eq!(opened["metrics"]["holdout"]["sealed"], json!(false));
}

/// The sealed run of the two holdout copies alone (`ho-blind.json`, `ho-scored.json`; `k` 10, one arm,
/// the depth check), pinned in `runs/sealed-run.json` for the page's test (Task 5; Node never runs
/// Rust). Holdout positions only, so every ranked key is emptied and nothing the floor's data moves is
/// written. `UPDATE_SEALED_RUN=1` rewrites the file.
/// Kills: any drift in the sealed write the page reads (a key renamed, added or dropped).
#[test]
fn the_sealed_run_of_the_holdout_copies_is_pinned_for_the_page() {
    let cfg = ReviewConfig {
        k: 10,
        ..depth_config()
    };
    let run = run_value(
        &[
            holdout_data("ho-blind.json"),
            holdout_data("ho-scored.json"),
        ],
        &cfg,
        &live(),
    );
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data/tier-b-review/runs/sealed-run.json");
    if std::env::var("UPDATE_SEALED_RUN").as_deref() == Ok("1") {
        let text = serde_json::to_string_pretty(&run).expect("serialises") + "\n";
        std::fs::write(&path, text).expect("write the pinned run");
    }
    let pinned: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .expect("the pinned run is JSON");
    assert_eq!(
        run, pinned,
        "re-pin with UPDATE_SEALED_RUN=1 if the change is meant"
    );

    assert!(run["run"].get("holdout_open").is_none());
    let positions = array(&run["positions"], "positions");
    assert_eq!(positions.len(), 2);
    let mut bands = BTreeSet::new();
    for p in positions {
        assert_eq!(p["split"], "holdout");
        assert_eq!(p["readings"], json!([]));
        assert_eq!(p["reference_ranking"], json!([]));
        // The depth check keeps its verdicts (no rank or value) and empties its top three.
        assert_eq!(p["depth_check"]["top_3"], json!([]));
        assert!(p["depth_check"]["stable"].is_boolean());
        for opt in p["options"].as_object().expect("options").values() {
            assert!(opt.get("reach").is_none());
            bands.extend(opt.get("band").and_then(Value::as_str).map(String::from));
        }
    }
    assert_eq!(
        bands,
        BTreeSet::from(["blind".to_string(), "later".to_string()])
    );
}
