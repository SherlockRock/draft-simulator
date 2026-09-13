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
