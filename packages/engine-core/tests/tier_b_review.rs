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
use engine_core::reference::state::{Action, Entry, Pools, Position, RoleSets};
use engine_core::reference::tier_b::{
    Label, Loaded, OptionKey, TierBError, TierBFixture, VerdictMode,
};
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
