//! Invariants of `engine_core::reference` (design docs/designs/engine-tier-a-fixtures-design.md § 7).
//! Probe positions are loaded from tests/data/reference-probes/ (dry-run JSON); the property each
//! row asserts lives here, not in the file.

use engine_core::draft_state::{ActionType, Side, TURN_SEQUENCE};
use engine_core::reference::format::{Format, Kind, Turn, STANDARD_TURNS};

// ------------------------------------------------------------------ format

#[test]
fn standard_format_expands_to_the_incumbent_turn_sequence() {
    let format = Format::standard();
    assert_eq!(format.slots().len(), TURN_SEQUENCE.len());
    for (i, (slot, incumbent)) in format.slots().iter().zip(TURN_SEQUENCE.iter()).enumerate() {
        assert_eq!(slot.side, incumbent.side, "slot {i} side");
        assert_eq!(slot.action, incumbent.action_type, "slot {i} action");
        assert_eq!(slot.pair_start, incumbent.pair_start, "slot {i} pair_start");
        assert_eq!(slot.pair_end, incumbent.pair_end, "slot {i} pair_end");
    }
    assert_eq!(format.turns().len(), 17);
    assert_eq!(format.turns(), &STANDARD_TURNS);
}

#[test]
fn standard_format_counts() {
    let f = Format::standard();
    assert_eq!(f.picks_per_side(Side::Blue), 5);
    assert_eq!(f.picks_per_side(Side::Red), 5);
    // design § 2: slot 12 → 7, 13 → 6, 16 → 3, 17 → 2, 18 (mid-pair) → 2, 19 → 1, 4 → 13, 0 → 17
    for (slot, turns) in [
        (0, 17),
        (4, 13),
        (12, 7),
        (13, 6),
        (16, 3),
        (17, 2),
        (18, 2),
        (19, 1),
        (20, 0),
    ] {
        assert_eq!(
            f.turns_remaining(slot),
            turns,
            "turns remaining from slot {slot}"
        );
    }
    assert_eq!(f.picks_remaining(Side::Blue, 17), 2);
    assert_eq!(f.picks_remaining(Side::Red, 17), 1);
    assert_eq!(f.picks_remaining(Side::Blue, 0), 5);
}

#[test]
fn explicit_format_expands_pairs_to_two_slots() {
    let f = Format::explicit(vec![
        Turn {
            side: Side::Blue,
            kind: Kind::Pick,
        },
        Turn {
            side: Side::Red,
            kind: Kind::Pair,
        },
        Turn {
            side: Side::Blue,
            kind: Kind::Ban,
        },
    ]);
    let s = f.slots();
    assert_eq!(s.len(), 4);
    assert_eq!(
        (s[0].side, s[0].action, s[0].pair_start, s[0].pair_end),
        (Side::Blue, ActionType::Pick, false, false)
    );
    assert_eq!(
        (s[1].side, s[1].action, s[1].pair_start, s[1].pair_end),
        (Side::Red, ActionType::Pick, true, false)
    );
    assert_eq!(
        (s[2].side, s[2].action, s[2].pair_start, s[2].pair_end),
        (Side::Red, ActionType::Pick, false, true)
    );
    assert_eq!(
        (s[3].side, s[3].action, s[3].pair_start, s[3].pair_end),
        (Side::Blue, ActionType::Ban, false, false)
    );
    assert_eq!(f.picks_per_side(Side::Red), 2);
    assert_eq!(f.turns_remaining(0), 3);
    assert_eq!(
        f.turns_remaining(2),
        2,
        "from a pair's second half: that half plus the ban"
    );
    assert_eq!(f.slot(4), None);
}

#[test]
fn turn_kind_deserialises_lowercase() {
    let t: Turn = serde_json::from_str(r#"{"side":"Red","kind":"pair"}"#).expect("parses");
    assert_eq!(
        t,
        Turn {
            side: Side::Red,
            kind: Kind::Pair
        }
    );
    assert!(
        serde_json::from_str::<Turn>(r#"{"side":"Red","kind":"Pair"}"#).is_err(),
        "kinds are lowercase"
    );
}

use engine_core::pools::Role;
use engine_core::reference::universe::{
    ChampionIdx, ChampionSet, Universe, UniverseError, UniverseSpec,
};

// ------------------------------------------------------------------ universe

fn spec(json: &str) -> UniverseSpec {
    serde_json::from_str(json).expect("universe spec parses")
}

const TINY: &str = r#"{
  "champions": [
    {"id": "A", "positions": ["Top"], "linear": 2},
    {"id": "B", "positions": ["Jungle", "Top"], "linear": 1},
    {"id": "C", "positions": ["Support"], "linear": 0.5}
  ],
  "synergy": [{"pair": ["A", "B"], "value": 3}],
  "counter": [{"of": "C", "over": "A", "value": 4}]
}"#;

#[test]
fn universe_interns_ids_and_stores_symmetric_and_antisymmetric_tables() {
    let u = Universe::new(spec(TINY)).expect("valid");
    let (a, b, c) = (
        u.index("A").unwrap(),
        u.index("B").unwrap(),
        u.index("C").unwrap(),
    );
    assert_eq!((a, b, c), (ChampionIdx(0), ChampionIdx(1), ChampionIdx(2)));
    assert_eq!(u.index("Z"), None);
    assert_eq!(u.id(b), "B");
    assert_eq!(u.linear(c), 0.5);
    assert_eq!(u.synergy(a, b), 3.0);
    assert_eq!(u.synergy(b, a), 3.0);
    assert_eq!(u.synergy(a, c), 0.0);
    assert_eq!(
        u.counter(c, a),
        4.0,
        "C over A: +4 when C is Blue and A is Red"
    );
    assert_eq!(
        u.counter(a, c),
        -4.0,
        "the reverse direction is the negation"
    );
    assert_eq!(u.counter(a, a), 0.0);
    // L = 1 + Σ|lin| + Σ|syn| + Σ|ctr| = 1 + 3.5 + 3 + 4
    assert_eq!(u.loss(), 11.5);
    assert_eq!(u.all().len(), 3);
    let meta = u.champion_meta();
    assert_eq!(meta["B"].positions, vec![Role::Jungle, Role::Top]);
    assert_eq!(meta["B"].id, "B");
    assert_eq!(u.names(&[c, a]), vec!["C".to_string(), "A".to_string()]);
}

#[test]
fn universe_rejects_bad_tables() {
    let dup = TINY.replace(
        r#"{"id": "C", "positions": ["Support"], "linear": 0.5}"#,
        r#"{"id": "A", "positions": ["Support"], "linear": 0.5}"#,
    );
    assert!(
        matches!(Universe::new(spec(&dup)), Err(UniverseError::DuplicateChampion(id)) if id == "A")
    );
    let unknown = TINY.replace(r#"["A", "B"]"#, r#"["A", "Q"]"#);
    assert!(
        matches!(Universe::new(spec(&unknown)), Err(UniverseError::UnknownChampion(id)) if id == "Q")
    );
    let self_pair = TINY.replace(r#"["A", "B"]"#, r#"["A", "A"]"#);
    assert!(
        matches!(Universe::new(spec(&self_pair)), Err(UniverseError::SelfPair(id)) if id == "A")
    );
    let dup_syn = TINY.replace(
        r#"[{"pair": ["A", "B"], "value": 3}]"#,
        r#"[{"pair": ["A", "B"], "value": 3}, {"pair": ["B", "A"], "value": 1}]"#,
    );
    assert!(matches!(
        Universe::new(spec(&dup_syn)),
        Err(UniverseError::DuplicateEntry(_, _))
    ));
    let dup_ctr = TINY.replace(
        r#"[{"of": "C", "over": "A", "value": 4}]"#,
        r#"[{"of": "C", "over": "A", "value": 4}, {"of": "A", "over": "C", "value": -4}]"#,
    );
    assert!(
        matches!(
            Universe::new(spec(&dup_ctr)),
            Err(UniverseError::DuplicateEntry(_, _))
        ),
        "both directions listed is a duplicate even when consistent"
    );
    let no_pos = TINY.replace(r#""positions": ["Support"]"#, r#""positions": []"#);
    assert!(
        matches!(Universe::new(spec(&no_pos)), Err(UniverseError::NoPositions(id)) if id == "C")
    );
}

#[test]
fn champion_set_is_a_bitmask() {
    let (a, b, c) = (ChampionIdx(0), ChampionIdx(5), ChampionIdx(31));
    let s = ChampionSet::EMPTY.with(a).with(c);
    assert!(s.contains(a) && s.contains(c) && !s.contains(b));
    assert_eq!(s.len(), 2);
    assert_eq!(s.without(a).len(), 1);
    assert_eq!(
        s.iter().collect::<Vec<_>>(),
        vec![a, c],
        "iterates in index order"
    );
    let t: ChampionSet = [b, c].into_iter().collect();
    assert_eq!(s.union(t).len(), 3);
    assert_eq!(s.intersect(t), ChampionSet::EMPTY.with(c));
    assert_eq!(s.minus(t), ChampionSet::EMPTY.with(a));
    assert!(ChampionSet::EMPTY.is_empty());
}
