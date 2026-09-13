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
