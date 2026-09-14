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

use engine_core::reference::objective::{Leaf, Objective};

// ------------------------------------------------------------------ objective

#[test]
fn board_value_is_the_d3_formula() {
    // A (lin 2, Top), B (lin 1), C (lin 0.5); syn(A,B)=3; ctr(C over A)=4
    let u = Universe::new(spec(TINY)).expect("valid");
    let (a, b, c) = (
        u.index("A").unwrap(),
        u.index("B").unwrap(),
        u.index("C").unwrap(),
    );
    // Blue {A,B}, Red {C}: 2 + 1 + 3 − 0.5 + ctr(A,C) + ctr(B,C) = 5.5 − 4 + 0 = 1.5
    assert_eq!(u.board_value(&[a, b], &[c]), 1.5);
    // Red {A,B}, Blue {C}: −(2+1+3) + 0.5 + ctr(C,A) + ctr(C,B) = −5.5 + 4 = −1.5 (antisymmetric)
    assert_eq!(u.board_value(&[c], &[a, b]), -1.5);
    assert_eq!(u.board_value(&[], &[]), 0.0);
}

#[test]
fn terminal_rule_orders_infeasibility_above_any_logit() {
    let u = Universe::new(spec(TINY)).expect("valid");
    let (a, b) = (u.index("A").unwrap(), u.index("B").unwrap());
    let (blue, red) = ([a], [b]);
    let leaf = |bf, rf| Leaf {
        blue: &blue,
        red: &red,
        blue_feasible: bf,
        red_feasible: rf,
    };
    assert_eq!(u.value(&leaf(true, true)), u.board_value(&[a], &[b]));
    assert_eq!(
        u.value(&leaf(true, false)),
        u.loss(),
        "Red cannot complete → +L"
    );
    assert_eq!(
        u.value(&leaf(false, true)),
        -u.loss(),
        "Blue cannot complete → −L"
    );
    assert_eq!(u.value(&leaf(false, false)), 0.0, "neither can → 0");
    assert!(u.loss() > u.board_value(&[a, b], &[]).abs());
}

use engine_core::reference::state::{Action, Entry, Pools, Position, PositionError};

// ------------------------------------------------------------------ state

/// Ten single-role champions in index order T1 T2 J1 J2 M1 M2 A1 A2 S1 S2, all linear 1.
fn ten() -> Universe {
    let mut champs = Vec::new();
    for (i, role) in ["Top", "Jungle", "Middle", "Adc", "Support"]
        .iter()
        .enumerate()
    {
        for n in 1..=2 {
            let letter = ["T", "J", "M", "A", "S"][i];
            champs.push(format!(
                r#"{{"id": "{letter}{n}", "positions": ["{role}"], "linear": 1}}"#
            ));
        }
    }
    let json = format!(r#"{{"champions": [{}]}}"#, champs.join(","));
    Universe::new(spec(&json)).expect("valid")
}

fn ids(u: &Universe, names: &[&str]) -> ChampionSet {
    names
        .iter()
        .map(|n| u.index(n).unwrap_or_else(|| panic!("no champion {n}")))
        .collect()
}

#[test]
fn action_pair_is_canonical_and_ordered() {
    let (a, b) = (ChampionIdx(3), ChampionIdx(1));
    assert_eq!(Action::pair(a, b), Action::Pair(b, a));
    assert_eq!(Action::pair(b, a), Action::Pair(b, a));
    assert!(Action::Ban(ChampionIdx(9)) < Action::Pick(ChampionIdx(0)));
    assert!(Action::Pick(ChampionIdx(9)) < Action::Pair(ChampionIdx(0), ChampionIdx(1)));
    assert_eq!(
        Action::pair(a, b).champions().collect::<Vec<_>>(),
        vec![b, a]
    );
}

#[test]
fn legal_actions_follow_d4_d5_d8() {
    let u = ten();
    let f = Format::standard();
    let pools = Pools {
        blue: ids(&u, &["T1", "J1", "M1", "A1", "S1"]),
        red: ids(&u, &["T2", "J2", "M2", "A2", "S2"]),
    };
    let t1 = u.index("T1").unwrap();

    // slot 0, Blue ban: every available champion, pools ignored; Skip never generated (D4, D5)
    let root = Position::new(&f, &[], &pools, &u).expect("empty position");
    let bans = root.legal_actions(&u, &pools);
    assert_eq!(bans.len(), 10);
    assert!(bans.iter().all(|a| matches!(a, Action::Ban(_))));

    // after one ban, Red bans from nine
    let after = root.apply(Action::Ban(t1));
    assert_eq!(after.slot_index(), 1);
    assert_eq!(after.mover(), Some(Side::Red));
    assert_eq!(after.legal_actions(&u, &pools).len(), 9);
    assert!(after.taken().contains(t1));

    // slot 7, Red pair: C(5,2) = 10 canonical pairs from Red's pool only (D8 1)
    let mut entries = vec![Entry::Skip; 6];
    entries.push(Entry::Pick(t1));
    let pos = Position::new(&f, &entries, &pools, &u).expect("blue picked T1");
    assert_eq!(pos.next_slot().map(|s| s.pair_start), Some(true));
    let pairs = pos.legal_actions(&u, &pools);
    assert_eq!(pairs.len(), 10);
    assert!(pairs.iter().all(|a| matches!(a, Action::Pair(x, y) if x < y && pools.red.contains(*x) && pools.red.contains(*y))));

    // apply a pair: two Pick entries, slot index advances by two, both in Red's picks
    let (j2, s2) = (u.index("J2").unwrap(), u.index("S2").unwrap());
    let next = pos.apply(Action::pair(s2, j2));
    assert_eq!(next.slot_index(), 9);
    assert_eq!(next.entries()[7..9], [Entry::Pick(j2), Entry::Pick(s2)]);
    assert_eq!(next.picks(Side::Red), &[j2, s2]);
    assert_eq!(next.picks(Side::Blue), &[t1]);
    assert_eq!(next.available(&u).len(), 7);

    // mid-pair root (D8 2): slot 8 with slot 7 filled → single completing picks, four Red champions left
    let mut mid = entries.clone();
    mid.push(Entry::Pick(j2));
    let mid = Position::new(&f, &mid, &pools, &u).expect("mid-pair");
    assert!(mid.is_mid_pair());
    let singles = mid.legal_actions(&u, &pools);
    assert_eq!(singles.len(), 4);
    assert!(singles.iter().all(|a| matches!(a, Action::Pick(_))));
    assert_eq!(mid.apply(Action::Pick(s2)).slot_index(), 9);

    // a pick outside the mover's pool is never offered
    assert!(!pos
        .legal_actions(&u, &pools)
        .iter()
        .any(|a| a.champions().any(|c| pools.blue.contains(c))));
}

#[test]
fn position_validation_names_the_slot() {
    let u = ten();
    let f = Format::standard();
    let pools = Pools {
        blue: ids(&u, &["T1", "J1", "M1", "A1", "S1"]),
        red: ids(&u, &["T2", "J2", "M2", "A2", "S2"]),
    };
    let (t1, t2) = (u.index("T1").unwrap(), u.index("T2").unwrap());
    let mut six = vec![Entry::Skip; 6];
    six.push(Entry::Skip);
    assert_eq!(
        Position::new(&f, &six, &pools, &u).err(),
        Some(PositionError::SkipOnPickSlot { slot: 6 })
    );
    let mut six = vec![Entry::Skip; 6];
    six.push(Entry::Ban(t1));
    assert_eq!(
        Position::new(&f, &six, &pools, &u).err(),
        Some(PositionError::KindMismatch { slot: 6 })
    );
    let mut six = vec![Entry::Skip; 6];
    six.push(Entry::Pick(t2));
    assert_eq!(
        Position::new(&f, &six, &pools, &u).err(),
        Some(PositionError::PickOutsidePool {
            slot: 6,
            id: "T2".into()
        })
    );
    let dup = [Entry::Ban(t1), Entry::Ban(t1)];
    assert_eq!(
        Position::new(&f, &dup, &pools, &u).err(),
        Some(PositionError::DuplicateChampion {
            slot: 1,
            id: "T1".into()
        })
    );
    let one = Format::explicit(vec![Turn {
        side: Side::Blue,
        kind: Kind::Ban,
    }]);
    assert_eq!(
        Position::new(&one, &[Entry::Skip, Entry::Skip], &pools, &u).err(),
        Some(PositionError::SlotOutOfRange { slot: 1, len: 1 })
    );
    let full = Position::new(&f, &[Entry::Skip; 6], &pools, &u).expect("six skips");
    assert!(!full.is_complete());
    assert_eq!(full.mover(), Some(Side::Blue));
}

use engine_core::reference::feasibility::{side_feasible, FeasibilityMemo, FeasibilityRule};

// ------------------------------------------------------------------ feasibility

#[test]
fn two_locked_top_only_champions_are_infeasible_even_with_a_full_pool() {
    // D3 ii invariant: locked picks must first form a perfect matching among themselves.
    let json = r#"{"champions": [
      {"id": "T1", "positions": ["Top"], "linear": 1}, {"id": "T2", "positions": ["Top"], "linear": 1},
      {"id": "J", "positions": ["Jungle"], "linear": 1}, {"id": "M", "positions": ["Middle"], "linear": 1},
      {"id": "A", "positions": ["Adc"], "linear": 1}, {"id": "S", "positions": ["Support"], "linear": 1},
      {"id": "T3", "positions": ["Top"], "linear": 1}
    ]}"#;
    let u = Universe::new(spec(json)).expect("valid");
    let all = u.all();
    let pools = Pools {
        blue: all,
        red: all,
    };
    // explicit format: Blue picks twice, then three more Blue picks (five per side is what the predicate needs)
    let f = Format::explicit(vec![
        Turn {
            side: Side::Blue,
            kind: Kind::Pick,
        },
        Turn {
            side: Side::Blue,
            kind: Kind::Pick,
        },
        Turn {
            side: Side::Blue,
            kind: Kind::Pair,
        },
        Turn {
            side: Side::Blue,
            kind: Kind::Pick,
        },
        Turn {
            side: Side::Red,
            kind: Kind::Pair,
        },
        Turn {
            side: Side::Red,
            kind: Kind::Pair,
        },
        Turn {
            side: Side::Red,
            kind: Kind::Pick,
        },
    ]);
    let (t1, t2, j) = (
        u.index("T1").unwrap(),
        u.index("T2").unwrap(),
        u.index("J").unwrap(),
    );
    let mut memo = FeasibilityMemo::default();

    let two_tops =
        Position::new(&f, &[Entry::Pick(t1), Entry::Pick(t2)], &pools, &u).expect("position");
    assert!(
        !side_feasible(
            &mut memo,
            FeasibilityRule::On,
            Side::Blue,
            &two_tops,
            &pools,
            &u
        ),
        "two locked Tops cannot both play"
    );
    assert!(
        side_feasible(
            &mut memo,
            FeasibilityRule::On,
            Side::Red,
            &two_tops,
            &pools,
            &u
        ),
        "Red still has a full pool net of the two Tops"
    );

    let top_jungle =
        Position::new(&f, &[Entry::Pick(t1), Entry::Pick(j)], &pools, &u).expect("position");
    assert!(side_feasible(
        &mut memo,
        FeasibilityRule::On,
        Side::Blue,
        &top_jungle,
        &pools,
        &u
    ));

    // Off: always feasible, and the predicate is never consulted
    let before = memo.calls;
    assert!(side_feasible(
        &mut memo,
        FeasibilityRule::Off,
        Side::Blue,
        &two_tops,
        &pools,
        &u
    ));
    assert_eq!(memo.calls, before);
}

#[test]
fn feasibility_memo_hits_on_repeated_keys() {
    let u = ten();
    let f = Format::standard();
    let pools = Pools {
        blue: u.all(),
        red: u.all(),
    };
    let pos = Position::new(&f, &[], &pools, &u).expect("empty");
    let mut memo = FeasibilityMemo::default();
    assert!(side_feasible(
        &mut memo,
        FeasibilityRule::On,
        Side::Blue,
        &pos,
        &pools,
        &u
    ));
    assert!(side_feasible(
        &mut memo,
        FeasibilityRule::On,
        Side::Blue,
        &pos,
        &pools,
        &u
    ));
    assert_eq!((memo.calls, memo.misses), (2, 1));
    // a different side is a different key
    assert!(side_feasible(
        &mut memo,
        FeasibilityRule::On,
        Side::Red,
        &pos,
        &pools,
        &u
    ));
    assert_eq!((memo.calls, memo.misses), (3, 2));
}

#[test]
fn feasibility_rule_deserialises_lowercase() {
    assert_eq!(
        serde_json::from_str::<FeasibilityRule>(r#""on""#).expect("on"),
        FeasibilityRule::On
    );
    assert_eq!(
        serde_json::from_str::<FeasibilityRule>(r#""off""#).expect("off"),
        FeasibilityRule::Off
    );
    assert!(serde_json::from_str::<FeasibilityRule>(r#""On""#).is_err());
}

use engine_core::reference::fixture::{DryRun, Fixture, FixtureError, Mode};
use std::path::PathBuf;

// ------------------------------------------------------------------ fixture loader

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/tier-a")
}

fn probes_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/reference-probes")
}

#[test]
fn load_dir_reads_the_eight_fixtures_in_name_order() {
    let all = Fixture::load_dir(&fixtures_dir()).unwrap_or_else(|e| panic!("{e}"));
    let ids: Vec<&str> = all.iter().map(|f| f.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "01-pair-completion",
            "02-profitable-denial",
            "03-declining-denial",
            "04-partner-protection",
            "05-comp-breaking-pair",
            "06a-ban-truncated",
            "06b-ban-horizon",
            "07-slot6-bound",
        ]
    );
    assert_eq!(
        Fixture::load_dir(&probes_dir())
            .unwrap_or_else(|e| panic!("{e}"))
            .len(),
        10
    );
}

#[test]
fn fixture_06b_loads_with_skips_horizon_and_ban_expectations() {
    let fx = Fixture::load_file(&fixtures_dir().join("06b-ban-horizon.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(fx.tactic, 6);
    assert_eq!(fx.format, Format::standard());
    assert_eq!(fx.feasibility, FeasibilityRule::Off);
    assert_eq!(fx.mode, Mode::Horizon(4));
    assert_eq!(fx.entries, vec![Entry::Skip; 4]);
    let (p1, p2) = (
        fx.universe.index("P1").unwrap(),
        fx.universe.index("P2").unwrap(),
    );
    assert_eq!(fx.expected_top, vec![Action::Ban(p1), Action::Ban(p2)]);
    assert_eq!(fx.epsilon, 1e-9);
    assert_eq!(
        fx.dry_run,
        DryRun {
            value: -1.0,
            leaves: 2100,
            nodes: 2560
        }
    );
    assert_eq!(fx.pools.blue.len(), 5);
    assert!(!fx.pools.blue.contains(p1) && fx.pools.red.contains(p1));
    let pos = fx.position();
    assert_eq!(pos.slot_index(), 4);
    assert_eq!(pos.mover(), Some(Side::Blue));
}

#[test]
fn fixture_04_has_explicit_format_and_two_swappable_pairs() {
    let fx = Fixture::load_file(&fixtures_dir().join("04-partner-protection.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(fx.format.turns().len(), 9);
    assert_eq!(fx.format.picks_per_side(Side::Blue), 5);
    assert_eq!(fx.mode, Mode::FullRemainder);
    let swaps = fx.swapped_pairs();
    assert_eq!(
        swaps.iter().map(|(slot, _)| *slot).collect::<Vec<_>>(),
        vec![1, 3]
    );
    let (slot, entries) = &swaps[0];
    assert_eq!(entries[*slot], fx.entries[slot + 1]);
    assert_eq!(entries[slot + 1], fx.entries[*slot]);
    assert_eq!(entries.len(), fx.entries.len());
    // fixture 05 has a pair expectation
    let fx5 = Fixture::load_file(&fixtures_dir().join("05-comp-breaking-pair.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    let (a1, s1) = (
        fx5.universe.index("A1").unwrap(),
        fx5.universe.index("S1").unwrap(),
    );
    assert_eq!(fx5.expected_top, vec![Action::pair(a1, s1)]);
    // fixture 01 is a mid-pair root
    let fx1 = Fixture::load_file(&fixtures_dir().join("01-pair-completion.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(fx1.position().is_mid_pair());
    assert_eq!(
        fx1.swapped_pairs().len(),
        2,
        "the two completed pairs at slots 7 and 9; the half-filled pair at 17 is not swappable"
    );
}

const MINIMAL: &str = r#"{
  "id": "minimal", "tactic": 0, "notes": "",
  "format": {"turns": [{"side": "Blue", "kind": "ban"}, {"side": "Red", "kind": "pick"}]},
  "feasibility": "off",
  "universe": {"champions": [{"id": "A", "positions": ["Top"], "linear": 1}, {"id": "B", "positions": ["Top"], "linear": 2}]},
  "pools": {"blue": ["A"], "red": ["B"]},
  "position": [],
  "oracle": "full_remainder",
  "expected_top": ["B"],
  "dry_run": {"value": 0, "leaves": 0, "nodes": 0}
}"#;

fn invalid(json: &str) -> (String, String) {
    match Fixture::from_json(json, "inline") {
        Err(FixtureError::Invalid { field, reason, .. }) => (field, reason),
        other => panic!("expected Invalid, got {other:?}"),
    }
}

#[test]
fn loader_rejects_mis_authored_fixtures_naming_the_field() {
    assert!(
        Fixture::from_json(MINIMAL, "inline").is_ok(),
        "the minimal fixture is valid"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(r#""feasibility": "off""#, r#""feasibility": "on""#)).0,
        "feasibility"
    );
    assert_eq!(invalid(&MINIMAL.replace(r#""format": {"turns": [{"side": "Blue", "kind": "ban"}, {"side": "Red", "kind": "pick"}]}"#, r#""format": "custom""#)).0, "format");
    assert_eq!(
        invalid(&MINIMAL.replace(r#""oracle": "full_remainder""#, r#""oracle": "exhaustive""#)).0,
        "oracle"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""pools": {"blue": ["A"], "red": ["B"]}"#,
            r#""pools": {"blue": ["A"], "red": ["Q"]}"#
        ))
        .0,
        "pools.red"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""position": []"#,
            r#""position": [{"slot": 1, "side": "Blue", "kind": "ban", "champion": "A"}]"#
        ))
        .0,
        "position[0].slot"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""position": []"#,
            r#""position": [{"slot": 0, "side": "Red", "kind": "ban", "champion": "A"}]"#
        ))
        .0,
        "position[0].side"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""position": []"#,
            r#""position": [{"slot": 0, "side": "Blue", "kind": "pick", "champion": "A"}]"#
        ))
        .0,
        "position[0].kind"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""position": []"#,
            r#""position": [{"slot": 0, "side": "Blue", "kind": "ban"}]"#
        ))
        .0,
        "position[0].champion"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""position": []"#,
            r#""position": [{"slot": 0, "side": "Blue", "kind": "ban", "champion": "Q"}]"#
        ))
        .0,
        "position[0].champion"
    );
    // a pick outside the mover's pool: Blue ban A, then Red picks A (Red's pool is {B})
    assert_eq!(invalid(&MINIMAL.replace(r#""position": []"#, r#""position": [{"slot": 0, "side": "Blue", "kind": "skip"}, {"slot": 1, "side": "Red", "kind": "pick", "champion": "A"}]"#)).0, "position");
    assert_eq!(
        invalid(&MINIMAL.replace(r#""expected_top": ["B"]"#, r#""expected_top": ["Q"]"#)).0,
        "expected_top[0]"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""expected_top": ["B"]"#,
            r#""expected_top": [["A", "B"]]"#
        ))
        .0,
        "expected_top[0]"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(r#""expected_top": ["B"]"#, r#""expected_top": ["B", "B"]"#)).0,
        "expected_top[1]"
    );
    assert_eq!(
        invalid(&MINIMAL.replace(r#""expected_top": ["B"]"#, r#""expected_top": []"#)).0,
        "expected_top"
    );
    // draft complete: two entries fill the two-slot format
    assert_eq!(invalid(&MINIMAL.replace(r#""position": []"#, r#""position": [{"slot": 0, "side": "Blue", "kind": "skip"}, {"slot": 1, "side": "Red", "kind": "pick", "champion": "B"}]"#)).0, "position");
    // missing dry_run or missing feasibility is a JSON (schema) error, not a silent default
    assert!(matches!(
        Fixture::from_json(
            &MINIMAL.replace(
                r#""dry_run": {"value": 0, "leaves": 0, "nodes": 0}"#,
                r#""unused": 0"#
            ),
            "inline"
        ),
        Err(FixtureError::Json { .. })
    ));
    match Fixture::from_json(&MINIMAL.replace(r#""feasibility": "off","#, ""), "inline") {
        Err(FixtureError::Json { source, .. }) => assert!(
            source.to_string().contains("feasibility"),
            "serde names the missing field: {source}"
        ),
        other => panic!("expected a Json error naming feasibility, got {other:?}"),
    }
    // a zero horizon has nothing to decide
    assert_eq!(
        invalid(&MINIMAL.replace(
            r#""oracle": "full_remainder""#,
            r#""oracle": {"horizon": 0}"#
        ))
        .0,
        "oracle"
    );
    // expected ban vs pick follows the root slot: at a pick root a plain id is a Pick
    let pick_root = MINIMAL.replace(
        r#""position": []"#,
        r#""position": [{"slot": 0, "side": "Blue", "kind": "skip"}]"#,
    );
    let fx = Fixture::from_json(&pick_root, "inline").unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        fx.expected_top,
        vec![Action::Pick(fx.universe.index("B").unwrap())]
    );
}

use engine_core::reference::oracle::{
    evaluate, Evaluation, OracleError, OracleInput, MAX_AVAILABLE, MAX_TURNS,
};

// ------------------------------------------------------------------ oracle: probes (design § 7)

fn probe(name: &str) -> Fixture {
    Fixture::load_file(&probes_dir().join(format!("{name}.json"))).unwrap_or_else(|e| panic!("{e}"))
}

fn assert_dry_run(fx: &Fixture, eval: &Evaluation) {
    assert_eq!(eval.value, fx.dry_run.value, "{}: value", fx.id);
    assert_eq!(eval.leaves, fx.dry_run.leaves, "{}: leaves", fx.id);
    assert_eq!(eval.nodes, fx.dry_run.nodes, "{}: nodes", fx.id);
}

/// A strictly increasing map over the leaf value, applied after the terminal rule (D3 ii).
struct Transformed<'a, F: Fn(f64) -> f64>(&'a Universe, F);

impl<F: Fn(f64) -> f64> Objective for Transformed<'_, F> {
    fn value(&self, leaf: &Leaf<'_>) -> f64 {
        (self.1)(self.0.value(leaf))
    }
}

#[test]
fn red_double_turn_is_two_consecutive_min_nodes() {
    // explicit R pick, R ban, B pick. Mover-explicit: Red picks X (5), bans B1 (6), Blue takes B2 (2) → −3.
    // A per-ply sign flip treats the Red ban as a max node, keeps B1 (which also counters X by 4) and answers Y at +3.
    let fx = probe("probe-red-double-turn");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(eval.mover, Side::Red);
    assert_eq!(
        eval.top_set,
        vec![Action::Pick(fx.universe.index("X").unwrap())]
    );
    assert_eq!(eval.value, -3.0);
    assert_dry_run(&fx, &eval);
    let y = eval
        .ranked
        .iter()
        .find(|av| av.action == Action::Pick(fx.universe.index("Y").unwrap()))
        .expect("Y ranked");
    assert_eq!(
        y.value, -1.0,
        "Red picks Y (3), bans B1, Blue takes B2: −3 + 2"
    );
}

#[test]
fn red_double_turn_on_the_standard_sequence_slots_11_and_12() {
    // D3 i / D9: Red owns slot 11 (pick) AND slot 12 (ban). Standard format, horizon 6 through Red's pick at 16.
    // M2 (7) is the unique prize Blue would ban at 13, so Red takes it first and still ends on one of three equal
    // 6-Adcs after Blue's two bans: 3 − (2 + 7 + 6) = −12. An Adc first lets Blue ban M2: −11.
    // STRUCTURAL coverage of the real sequence's double turn only: a per-ply sign flip gives the same answer here
    // (Blue picks nothing inside the horizon, so the flipped Red-ban and Blue-ban errors cancel — measured).
    // The discriminating test of the mover-explicit convention is red_double_turn_is_two_consecutive_min_nodes.
    let fx = probe("probe-red-double-turn-standard");
    assert_eq!(fx.position().slot_index(), 11);
    assert_eq!(fx.position().mover(), Some(Side::Red));
    assert_eq!(
        fx.format.slot(12).map(|s| (s.side, s.action)),
        Some((Side::Red, ActionType::Ban))
    );
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        eval.top_set,
        vec![Action::Pick(fx.universe.index("M2").unwrap())]
    );
    assert_eq!(eval.value, -12.0);
    let a2 = eval
        .ranked
        .iter()
        .find(|av| av.action == Action::Pick(fx.universe.index("A2").unwrap()))
        .expect("A2 ranked");
    assert_eq!(a2.value, -11.0, "an Adc first lets Blue ban M2");
    assert_dry_run(&fx, &eval);
}

#[test]
fn immediate_strength_beats_delayed_synergy_until_the_horizon_reaches_the_partner() {
    // D3 v: A2 (7 now) vs A3 (1 now, +9 with S2 at slot 19)
    for (name, expect) in [
        ("probe-immediate-vs-delayed-h1", "A2"),
        ("probe-immediate-vs-delayed-h2", "A2"),
        ("probe-immediate-vs-delayed-h3", "A3"),
    ] {
        let fx = probe(name);
        let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            eval.top_set,
            vec![Action::Pick(fx.universe.index(expect).unwrap())],
            "{name}"
        );
        assert_dry_run(&fx, &eval);
    }
    assert_eq!(
        probe("probe-immediate-vs-delayed-h3").mode,
        Mode::FullRemainder
    );
}

#[test]
fn ban_only_horizon_ties_every_ban_and_a_pick_inside_the_horizon_breaks_the_tie() {
    // D3 iii: no picks inside the horizon → every leaf 0 → every ban ties. Feasibility is off so roles play no part.
    // The file's expected_top lists all eight bans by name — an answer stated independently of legal_actions().
    for name in ["probe-ban-only-tie-h3", "probe-ban-only-tie-h6"] {
        let fx = probe(name);
        let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            fx.expected_top.len(),
            8,
            "{name}: the file names all eight bans"
        );
        assert_eq!(
            eval.top_set, fx.expected_top,
            "{name}: every ban is in the top set"
        );
        assert_eq!(eval.ranked.len(), 8, "{name}: eight legal bans");
        assert!(
            eval.ranked.iter().all(|av| av.value == 0.0),
            "{name}: every ban is worth exactly 0"
        );
        assert_dry_run(&fx, &eval);
    }
    let fx = probe("probe-ban-only-tie-h7");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    let first = eval.ranked[0].value;
    assert!(
        eval.ranked.iter().any(|av| av.value != first),
        "h = 7 reaches Blue's pick: values are not all equal"
    );
    assert_eq!(
        eval.top_set, fx.expected_top,
        "{{C1..C4}} at 5; C5..C8 at 4"
    );
    assert_eq!(eval.top_set.len(), 4);
    assert_dry_run(&fx, &eval);
}

#[test]
fn a_ban_that_removes_the_last_champion_for_a_role_is_worth_l() {
    let fx = probe("probe-ban-breaks-role");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        eval.top_set,
        vec![Action::Ban(fx.universe.index("S1").unwrap())]
    );
    assert_eq!(eval.value, fx.universe.loss());
    assert_dry_run(&fx, &eval);
}

#[test]
fn mutual_infeasibility_ties_the_honest_line_at_zero() {
    // design S11: both pools cover the universe and each role has two champions; Red at 0 can also
    // reach 0 by taking both Middles or both Adcs (both sides infeasible → 0).
    let fx = probe("probe-mutual-infeasibility");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    let idx = |n: &str| fx.universe.index(n).unwrap();
    let mut expected = vec![
        Action::pair(idx("A2"), idx("A3")),
        Action::pair(idx("J1"), idx("S1")),
        Action::pair(idx("M2"), idx("M3")),
    ];
    expected.sort();
    assert_eq!(eval.top_set, expected);
    assert_eq!(eval.value, 0.0);
    assert_dry_run(&fx, &eval);
}

#[test]
fn ranking_is_invariant_under_a_strictly_increasing_transform_including_terminals() {
    // D3 ii: any transform applied to U must preserve terminal ordering. Fixture 05 has a −L branch.
    for name in ["02-profitable-denial", "05-comp-breaking-pair"] {
        let fx = Fixture::load_file(&fixtures_dir().join(format!("{name}.json")))
            .unwrap_or_else(|e| panic!("{e}"));
        let base = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
        let order = |e: &Evaluation| e.ranked.iter().map(|av| av.action).collect::<Vec<_>>();
        let affine = fx
            .evaluate_with(&Transformed(&fx.universe, |x| 3.0 * x + 1.0), fx.mode)
            .unwrap_or_else(|e| panic!("{e}"));
        let cubic = fx
            .evaluate_with(&Transformed(&fx.universe, |x| x * x * x + x), fx.mode)
            .unwrap_or_else(|e| panic!("{e}"));
        // The hazard D3 ii names: a saturating map narrowing gaps toward an artificial tie. ε (1e-9) lives in the
        // objective's output scale; x/(1+|x|) keeps every gap above 1e-4 at |x| ≤ 60, so ties stay exact and distinct stay distinct.
        let saturating = fx
            .evaluate_with(&Transformed(&fx.universe, |x| x / (1.0 + x.abs())), fx.mode)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            order(&affine),
            order(&base),
            "{name}: 3x+1 keeps the ranking"
        );
        assert_eq!(
            order(&cubic),
            order(&base),
            "{name}: x³+x keeps the ranking"
        );
        assert_eq!(
            order(&saturating),
            order(&base),
            "{name}: x/(1+|x|) keeps the ranking"
        );
        assert_eq!(affine.top_set, base.top_set);
        assert_eq!(cubic.top_set, base.top_set);
        assert_eq!(saturating.top_set, base.top_set);
        assert_eq!(affine.value, 3.0 * base.value + 1.0);
    }
}

#[test]
fn hand_derived_root_values_independent_of_both_oracles() {
    // Derived from the JSON by hand (design § 7): a shared misreading of D3 by the author of both oracles would not survive these.
    let load = |name: &str| {
        Fixture::load_file(&fixtures_dir().join(format!("{name}.json")))
            .unwrap_or_else(|e| panic!("{e}"))
    };
    let value_of =
        |e: &Evaluation, a: Action| e.ranked.iter().find(|av| av.action == a).map(|av| av.value);
    // 01: Blue T1 J1 M1 A1 (2 each) + S1 (1) + syn(A1,S1) 6 = 15; Red T2 J2 M2 A2 (2 each) + S3 (1) = 9 → +6
    let fx = load("01-pair-completion");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(eval.value, 6.0);
    assert_eq!(
        value_of(&eval, Action::Pick(fx.universe.index("S2").unwrap())),
        Some(2.0),
        "S2: 8 + 3 = 11 vs 9"
    );
    assert_eq!(
        value_of(&eval, Action::Pick(fx.universe.index("T3").unwrap())),
        Some(-fx.universe.loss()),
        "a fourth Top: Blue infeasible"
    );
    // 02: ban S1 → boards tie at 0; any other ban → Red completes J1+S1 for +8 → −8
    let fx = load("02-profitable-denial");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    let s1 = Action::Ban(fx.universe.index("S1").unwrap());
    assert_eq!(value_of(&eval, s1), Some(0.0));
    assert!(
        eval.ranked
            .iter()
            .filter(|av| av.action != s1)
            .all(|av| av.value == -8.0),
        "every other ban is worth −8"
    );
    // 05: (A1, S1) → Blue 2+2+2+2+1 = 9 vs Red 2+2+2+2+1 = 9 → 0; (M3, M4) → three Middles → −L
    let fx = load("05-comp-breaking-pair");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    let idx = |n: &str| fx.universe.index(n).unwrap();
    assert_eq!(
        value_of(&eval, Action::pair(idx("A1"), idx("S1"))),
        Some(0.0)
    );
    assert_eq!(
        value_of(&eval, Action::pair(idx("M3"), idx("M4"))),
        Some(-fx.universe.loss())
    );
}

#[test]
fn oracle_bounds_are_asserted_at_the_root() {
    let u = ten();
    let f = Format::standard();
    let pools = Pools {
        blue: u.all(),
        red: u.all(),
    };
    let input = |position: &Position<'_>, mode| -> Result<Evaluation, OracleError> {
        evaluate(&OracleInput {
            position,
            universe: &u,
            pools: &pools,
            objective: &u,
            feasibility: FeasibilityRule::Off,
            mode,
            epsilon: 1e-9,
        })
    };
    let root = Position::new(&f, &[], &pools, &u).expect("empty");
    assert_eq!(
        input(&root, Mode::FullRemainder).err(),
        Some(OracleError::TurnsExceedBound {
            explored: 17,
            max: MAX_TURNS
        })
    );
    assert_eq!(
        input(&root, Mode::Horizon(8)).err(),
        Some(OracleError::TurnsExceedBound {
            explored: 8,
            max: MAX_TURNS
        })
    );
    // seven explored turns being inside the bound is proved by probe-ban-only-tie-h7 (explored 7, passes)
    // thirteen available
    let mut champs: Vec<String> = (0..13)
        .map(|i| format!(r#"{{"id": "C{i}", "positions": ["Top"], "linear": 1}}"#))
        .collect();
    champs.sort();
    let wide =
        Universe::new(spec(&format!(r#"{{"champions": [{}]}}"#, champs.join(",")))).expect("valid");
    let wide_pools = Pools {
        blue: wide.all(),
        red: wide.all(),
    };
    let wide_root = Position::new(&f, &[], &wide_pools, &wide).expect("empty");
    let err = evaluate(&OracleInput {
        position: &wide_root,
        universe: &wide,
        pools: &wide_pools,
        objective: &wide,
        feasibility: FeasibilityRule::Off,
        mode: Mode::Horizon(1),
        epsilon: 1e-9,
    })
    .err();
    assert_eq!(
        err,
        Some(OracleError::AvailableExceedsBound {
            available: 13,
            max: MAX_AVAILABLE
        })
    );
    // a complete draft: a two-ban format with both bans recorded as skips
    let two_bans = Format::explicit(vec![
        Turn {
            side: Side::Blue,
            kind: Kind::Ban,
        },
        Turn {
            side: Side::Red,
            kind: Kind::Ban,
        },
    ]);
    let done =
        Position::new(&two_bans, &[Entry::Skip, Entry::Skip], &pools, &u).expect("two skips");
    assert!(done.is_complete());
    let err = evaluate(&OracleInput {
        position: &done,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: FeasibilityRule::Off,
        mode: Mode::FullRemainder,
        epsilon: 1e-9,
    })
    .err();
    assert_eq!(err, Some(OracleError::DraftComplete));
    // a pool exhausted with feasibility off: Blue's pool is one champion, Blue must pick twice
    let two = Format::explicit(vec![
        Turn {
            side: Side::Blue,
            kind: Kind::Pick,
        },
        Turn {
            side: Side::Blue,
            kind: Kind::Pick,
        },
    ]);
    let t1 = u.index("T1").unwrap();
    let tiny_pools = Pools {
        blue: ChampionSet::EMPTY.with(t1),
        red: u.all(),
    };
    let start = Position::new(&two, &[], &tiny_pools, &u).expect("empty");
    let err = evaluate(&OracleInput {
        position: &start,
        universe: &u,
        pools: &tiny_pools,
        objective: &u,
        feasibility: FeasibilityRule::Off,
        mode: Mode::FullRemainder,
        epsilon: 1e-9,
    })
    .err();
    assert_eq!(err, Some(OracleError::NoLegalAction { slot: 1 }));
    // Horizon(0) at the root decides nothing
    assert_eq!(
        input(&root, Mode::Horizon(0)).err(),
        Some(OracleError::HorizonZero)
    );
    // an already-infeasible root is terminal, not a decision: fixture 02 with Blue's supports removed from its pool
    let fx = Fixture::load_file(&fixtures_dir().join("02-profitable-denial.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    let (s4, s5) = (
        fx.universe.index("S4").unwrap(),
        fx.universe.index("S5").unwrap(),
    );
    let starved = Pools {
        blue: fx.pools.blue.without(s4).without(s5),
        red: fx.pools.red,
    };
    let root02 = Position::new(&fx.format, &fx.entries, &starved, &fx.universe).expect("position");
    let err = evaluate(&OracleInput {
        position: &root02,
        universe: &fx.universe,
        pools: &starved,
        objective: &fx.universe,
        feasibility: FeasibilityRule::On,
        mode: Mode::FullRemainder,
        epsilon: 1e-9,
    })
    .err();
    assert_eq!(
        err,
        Some(OracleError::RootTerminal {
            blue_feasible: false,
            red_feasible: true
        })
    );
    // the terminal check precedes action generation at the root too: fixture 01's mid-pair root with Blue's
    // remaining options (S1, S2, T3) removed from its pool has no legal action AND is infeasible — infeasible wins
    let fx = Fixture::load_file(&fixtures_dir().join("01-pair-completion.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    let gone = ["S1", "S2", "T3"].map(|n| fx.universe.index(n).unwrap());
    let starved = Pools {
        blue: gone.iter().fold(fx.pools.blue, |p, c| p.without(*c)),
        red: fx.pools.red,
    };
    let root01 = Position::new(&fx.format, &fx.entries, &starved, &fx.universe)
        .expect("board picks are still in the pool");
    let err = evaluate(&OracleInput {
        position: &root01,
        universe: &fx.universe,
        pools: &starved,
        objective: &fx.universe,
        feasibility: FeasibilityRule::On,
        mode: Mode::FullRemainder,
        epsilon: 1e-9,
    })
    .err();
    assert_eq!(
        err,
        Some(OracleError::RootTerminal {
            blue_feasible: false,
            red_feasible: true
        }),
        "not NoLegalAction"
    );
}

#[test]
fn swapping_both_completed_pairs_at_once_changes_nothing() {
    // design § 7: independently AND together; tier_a.rs covers one at a time
    let fx = Fixture::load_file(&fixtures_dir().join("04-partner-protection.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    let base = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    let mut entries = fx.entries.clone();
    for (slot, _) in fx.swapped_pairs() {
        entries.swap(slot, slot + 1);
    }
    assert_ne!(entries, fx.entries);
    let both = Position::new(&fx.format, &entries, &fx.pools, &fx.universe).expect("position");
    let again = evaluate(&OracleInput {
        position: &both,
        universe: &fx.universe,
        pools: &fx.pools,
        objective: &fx.universe,
        feasibility: fx.feasibility,
        mode: fx.mode,
        epsilon: fx.epsilon,
    })
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (again.value, again.top_set, again.leaves, again.nodes),
        (base.value, base.top_set, base.leaves, base.nodes)
    );
}

#[test]
fn evaluation_ranks_best_first_for_the_mover_and_reports_counts() {
    let fx = probe("probe-red-double-turn");
    let eval = fx.evaluate().unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(eval.ranked.len(), 2);
    assert!(
        eval.ranked[0].value <= eval.ranked[1].value,
        "Red: ascending"
    );
    assert_eq!(eval.ranked[0].value, eval.value);
    assert!(eval.leaves > 0 && eval.nodes >= eval.leaves);
    // 2 Red picks + 2×3 Red bans + 8 Blue picks (banning the other Red champion leaves two Blue choices, banning B1 or B2 leaves one) = 16
    assert_eq!(eval.nodes, 16);
    assert_eq!(eval.leaves, 8);
}
