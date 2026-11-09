//! The Tier B review tool (design docs/designs/tier-b-review-tool-design.md). Task 1: the whole side an
//! action makes, and the roles a side's locked picks leave open. Constructed band universes, with
//! shares so an off-role placement reads a real grade.

use engine_core::draft_state::{ActionType, Side};
use engine_core::pools::Role;
use engine_core::reference::feasibility::{
    arrangement, open_roles, placements, FeasibilityMemo, Price, SidePlacement,
};
use engine_core::reference::format::Format;
use engine_core::reference::state::{Action, Entry, Pools, Position, RoleSets};
use engine_core::reference::universe::{ChampionIdx, ChampionSet, Universe, UniverseSpec};

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
