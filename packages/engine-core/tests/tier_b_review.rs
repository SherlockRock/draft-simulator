//! The Tier B review tool (design docs/designs/tier-b-review-tool-design.md). Task 1: the whole side an
//! action makes, and the roles a side's locked picks leave open. Constructed band universes, with
//! shares so an off-role placement reads a real grade.

mod common;

use common::{load_production_data_from, repo_root};
use engine_core::draft_state::{ActionType, Side};
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::entries::SpecError;
use engine_core::reference::feasibility::{
    arrangement, open_roles, placements, FeasibilityMemo, Price, SidePlacement,
};
use engine_core::reference::format::{Format, Slot};
use engine_core::reference::live::LiveUniverse;
use engine_core::reference::search::Shortlist;
use engine_core::reference::state::{Action, Entry, Pools, Position, RoleSets};
use engine_core::reference::tier_b::{
    Label, Loaded, OptionKey, TierBError, TierBFixture, VerdictMode,
};
use engine_core::reference::tier_b_review::{run_review, EngineStamp, ReviewConfig, ReviewRun};
use engine_core::reference::universe::{ChampionIdx, ChampionSet, Universe, UniverseSpec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
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
