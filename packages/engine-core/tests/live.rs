//! The live universe and the converter (slice-5 design § 9): parity with the FM's structural logit
//! against the Python-exported fixtures, the marginal identity, the set widening, canonical order,
//! the converter on a real session state, and the live-side pruning-soundness check.

mod common;

use common::{load_production_data, repo_root};
use engine_core::draft_state::Side;
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::live::{DropReason, Dropped, LiveUniverse};
use engine_core::reference::objective::{Leaf, Objective};
use engine_core::reference::state::{Entry, Pools, Position};
use engine_core::reference::universe::{
    Champion, ChampionIdx, ChampionSet, Universe, UniverseError, MAX_CHAMPIONS,
};
use proptest::prelude::*;
use serde::Deserialize;
use std::collections::HashSet;

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

fn fm() -> FmWeights {
    let raw = std::fs::read_to_string(repo_root().join("data/compiled/fm-weights.json"))
        .expect("data/compiled/fm-weights.json");
    FmWeights::from_json_str(&raw).expect("fm-weights parses")
}

fn meta_version() -> String {
    #[derive(Deserialize)]
    struct MetaVersion {
        version: String,
    }
    let raw = std::fs::read_to_string(repo_root().join("data/compiled/champion-meta.json"))
        .expect("data/compiled/champion-meta.json");
    serde_json::from_str::<MetaVersion>(&raw)
        .expect("champion-meta version")
        .version
}

fn live_universe() -> LiveUniverse {
    let (_, meta) = load_production_data();
    LiveUniverse::build(&fm(), &meta_version(), &meta).unwrap_or_else(|e| panic!("{e}"))
}

/// Ids → index-sorted indices (what `Position` hands `board_value`).
fn sorted(u: &Universe, ids: &[String]) -> Vec<ChampionIdx> {
    let mut v: Vec<ChampionIdx> = ids
        .iter()
        .map(|id| {
            u.index(id)
                .unwrap_or_else(|| panic!("{id} not in the live universe"))
        })
        .collect();
    v.sort();
    v
}

#[derive(Deserialize)]
struct Parity {
    version: String,
    tolerance: f64,
    fixtures: Vec<ParityFixture>,
}

#[derive(Deserialize)]
struct ParityFixture {
    blue: Vec<String>,
    red: Vec<String>,
    logit: f64,
}

fn parity() -> Parity {
    let raw = std::fs::read_to_string(repo_root().join("data/compiled/fm-parity.json"))
        .expect("data/compiled/fm-parity.json");
    serde_json::from_str(&raw).expect("fm-parity parses")
}

// ---------------------------------------------------------------------------------------------
// 1–3: the live universe IS the FM
// ---------------------------------------------------------------------------------------------

#[test]
fn board_value_equals_the_python_structural_logit_on_every_parity_fixture() {
    let live = live_universe();
    let parity = parity();
    assert_eq!(
        parity.version, live.fm_version,
        "parity fixtures and weights must come from the same export"
    );
    assert!(
        parity.fixtures.len() >= 40,
        "the parity file must not silently shrink"
    );
    let mut partial = 0;
    for (i, f) in parity.fixtures.iter().enumerate() {
        let blue = sorted(&live.universe, &f.blue);
        let red = sorted(&live.universe, &f.red);
        if blue.len() < 5 || red.len() < 5 {
            partial += 1;
        }
        let value = live.universe.board_value(&blue, &red);
        assert!(
            (value - f.logit).abs() < parity.tolerance,
            "fixture {i}: reference {value} vs python logit {}",
            f.logit
        );
    }
    assert!(partial > 0, "the parity file must include partial boards");
}

/// Deterministic boards without a `rand` dependency; printable on failure.
struct Lcg(u64);

impl Lcg {
    fn below(&mut self, n: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        let n = u64::try_from(n).expect("usize fits u64");
        usize::try_from((self.0 >> 33) % n).expect("below n")
    }

    /// `k` distinct indices below `n`.
    fn distinct(&mut self, k: usize, n: usize) -> Vec<usize> {
        let mut out = Vec::with_capacity(k);
        while out.len() < k {
            let i = self.below(n);
            if !out.contains(&i) {
                out.push(i);
            }
        }
        out
    }
}

#[test]
fn adding_a_champion_moves_board_value_by_the_fm_marginal_on_both_sides() {
    let live = live_universe();
    let fm = fm();
    let u = &live.universe;
    let ids: Vec<String> = (0..u.len())
        .map(|i| {
            u.id(ChampionIdx(u8::try_from(i).expect("< 256")))
                .to_string()
        })
        .collect();
    let mut lcg = Lcg(0x5eed);
    for trial in 0..200 {
        let draw = lcg.distinct(10, ids.len());
        let nb = lcg.below(5); // 0..=4 Blue picks
        let nr = lcg.below(5); // 0..=4 Red picks
        let blue_ids: Vec<String> = draw[..nb].iter().map(|&i| ids[i].clone()).collect();
        let red_ids: Vec<String> = draw[nb..nb + nr].iter().map(|&i| ids[i].clone()).collect();
        let candidate = ids[draw[9]].clone();
        let c = fm
            .champion(&candidate)
            .expect("live universe id is an FM alias");
        let base = u.board_value(&sorted(u, &blue_ids), &sorted(u, &red_ids));

        let mut blue_plus = blue_ids.clone();
        blue_plus.push(candidate.clone());
        let with_blue = u.board_value(&sorted(u, &blue_plus), &sorted(u, &red_ids));
        let expected = fm.marginal(c, &fm.perspective(&blue_ids, &red_ids), false);
        assert!(
            (with_blue - base - expected).abs() < 1e-9,
            "trial {trial}: Blue adds {candidate}: {} vs marginal {expected}",
            with_blue - base
        );

        let mut red_plus = red_ids.clone();
        red_plus.push(candidate.clone());
        let with_red = u.board_value(&sorted(u, &blue_ids), &sorted(u, &red_plus));
        let expected = -fm.marginal(c, &fm.perspective(&red_ids, &blue_ids), false);
        assert!(
            (with_red - base - expected).abs() < 1e-9,
            "trial {trial}: Red adds {candidate}: {} vs -marginal {expected}",
            with_red - base
        );
    }
}

#[test]
fn live_tables_are_antisymmetric_bit_for_bit_and_the_id_order_is_deterministic() {
    let live = live_universe();
    let again = live_universe();
    let u = &live.universe;
    assert_eq!(u.len(), 173, "the shipped FM has 173 champions");
    for a in 0..u.len() {
        for b in (a + 1)..u.len() {
            let (a, b) = (
                ChampionIdx(u8::try_from(a).expect("< 256")),
                ChampionIdx(u8::try_from(b).expect("< 256")),
            );
            assert_eq!(
                u.counter(a, b).to_bits(),
                (-u.counter(b, a)).to_bits(),
                "ctr({}, {})",
                u.id(a),
                u.id(b)
            );
            assert_eq!(u.synergy(a, b).to_bits(), u.synergy(b, a).to_bits());
        }
        let a = ChampionIdx(u8::try_from(a).expect("< 256"));
        assert_eq!(
            u.id(a),
            again.universe.id(a),
            "id order must not depend on HashMap iteration"
        );
    }
    assert_eq!(live.fm_version, "fm-2026-09-01-6880daa");
    assert_eq!(live.meta_version, meta_version());
    // U4: reported, not asserted — a champion-meta refresh may land before the FM retrain.
    println!(
        "padded (champion-meta champions the FM does not know): {:?}",
        live.padded
    );
    println!(
        "dropped (left out of the universe, with reasons): {:?}",
        live.dropped
    );
    println!("L = {}", u.loss());
    assert!(u.loss().is_finite());
}

/// U4 both ways, on a two-champion FM and a three-champion meta.
#[test]
fn a_meta_only_champion_is_padded_with_a_zero_row_and_an_fm_only_champion_is_dropped() {
    use engine_core::role_solver::ChampionMeta;
    let row = |v: f64| -> String {
        let vec = format!("[{}]", vec![v.to_string(); 16].join(", "));
        format!(
            "{{\"linear_expected\": {v}, \"synergy\": {vec}, \"counter_a\": {vec}, \"counter_b\": {vec}}}"
        )
    };
    let raw = format!(
        "{{\"version\": \"fm-test\", \"format\": 1, \"rank\": 16, \"scale\": 1.0, \"champions\": {{\"A\": {}, \"B\": {}}}}}",
        row(0.5),
        row(0.25)
    );
    let fm = FmWeights::from_json_str(&raw).expect("tiny FM parses");
    let meta_for = |ids: &[&str]| -> std::collections::HashMap<String, ChampionMeta> {
        ids.iter()
            .map(|id| {
                (
                    id.to_string(),
                    ChampionMeta {
                        id: id.to_string(),
                        positions: vec![Role::Top],
                        ..Default::default()
                    },
                )
            })
            .collect()
    };

    let live = LiveUniverse::build(&fm, "meta-test", &meta_for(&["A", "B", "C"]))
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(live.padded, vec!["C".to_string()]);
    assert!(live.dropped.is_empty());
    assert_eq!(live.universe.len(), 3);
    let (a, b, c) = (
        live.universe.index("A").expect("A"),
        live.universe.index("B").expect("B"),
        live.universe.index("C").expect("C"),
    );
    assert_eq!(live.universe.linear(c), 0.0);
    assert_eq!(live.universe.synergy(a, c), 0.0);
    assert_eq!(live.universe.counter(c, b), 0.0);
    assert_eq!(live.universe.synergy(a, b), 16.0 * 0.5 * 0.25, "s_a · s_b");
    assert_eq!(
        live.universe.counter(a, b),
        0.0,
        "a_a · b_b − b_a · a_b with equal vectors"
    );
    assert_eq!(
        live.universe.board_value(&[a], &[c]),
        0.5,
        "C contributes nothing"
    );

    // FM-only: the champion is left out and named; the universe still builds (U4).
    let live =
        LiveUniverse::build(&fm, "meta-test", &meta_for(&["A"])).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        live.dropped,
        vec![Dropped {
            id: "B".into(),
            reason: DropReason::NotInChampionMeta
        }]
    );
    assert!(live.padded.is_empty());
    assert_eq!(live.universe.len(), 1);
    assert_eq!(live.universe.index("B"), None);

    // A champion-meta entry with NO positions (a floored refresh) is dropped too, never a build error.
    let mut meta = meta_for(&["A", "B", "C"]);
    meta.get_mut("C").expect("C").positions.clear();
    let live = LiveUniverse::build(&fm, "meta-test", &meta).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        live.dropped,
        vec![Dropped {
            id: "C".into(),
            reason: DropReason::NoPositions
        }]
    );
    assert!(live.padded.is_empty(), "a dropped champion is not padded");
    assert_eq!(live.universe.len(), 2);
    assert_eq!(live.universe.index("C"), None);
}

// ---------------------------------------------------------------------------------------------
// 4: the 256-champion set
// ---------------------------------------------------------------------------------------------

fn set_of(ids: &HashSet<u8>) -> ChampionSet {
    ids.iter().map(|&i| ChampionIdx(i)).collect()
}

proptest! {
    #[test]
    fn set_ops_agree_with_hashset(
        a in prop::collection::hash_set(0u8..=255, 0..40),
        b in prop::collection::hash_set(0u8..=255, 0..40),
    ) {
        let (sa, sb) = (set_of(&a), set_of(&b));
        prop_assert_eq!(sa.len(), a.len());
        prop_assert_eq!(sa.is_empty(), a.is_empty());
        let mut expected: Vec<u8> = a.iter().copied().collect();
        expected.sort();
        let iterated: Vec<u8> = sa.iter().map(|c| c.0).collect();
        prop_assert_eq!(iterated, expected, "iter is ascending, set bits only");
        for i in 0u8..=255 {
            prop_assert_eq!(sa.contains(ChampionIdx(i)), a.contains(&i));
        }
        let union: HashSet<u8> = a.union(&b).copied().collect();
        let inter: HashSet<u8> = a.intersection(&b).copied().collect();
        let minus: HashSet<u8> = a.difference(&b).copied().collect();
        prop_assert_eq!(sa.union(sb), set_of(&union));
        prop_assert_eq!(sa.intersect(sb), set_of(&inter));
        prop_assert_eq!(sa.minus(sb), set_of(&minus));
        if let Some(&x) = a.iter().next() {
            let c = ChampionIdx(x);
            prop_assert!(!sa.without(c).contains(c));
            prop_assert_eq!(sa.without(c).with(c), sa);
        }
    }
}

fn synthetic(n: usize) -> Result<Universe, UniverseError> {
    let champions: Vec<Champion> = (0..n)
        .map(|i| Champion {
            id: format!("C{i}"),
            positions: vec![Role::Top],
            linear: 0.0,
        })
        .collect();
    let zero = vec![vec![0.0; n]; n];
    Universe::from_tables(champions, &zero, &zero)
}

#[test]
fn a_universe_holds_256_champions_and_refuses_257() {
    let u = synthetic(MAX_CHAMPIONS).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(u.len(), 256);
    assert_eq!(u.all().len(), 256);
    assert!(u.all().contains(ChampionIdx(255)));
    assert_eq!(u.id(ChampionIdx(255)), "C255");
    assert_eq!(synthetic(257).err(), Some(UniverseError::TooMany));
}

#[test]
fn from_tables_names_a_wrong_shape_and_a_non_finite_entry() {
    let champions = |n: usize| -> Vec<Champion> {
        (0..n)
            .map(|i| Champion {
                id: format!("C{i}"),
                positions: vec![Role::Top],
                linear: 0.0,
            })
            .collect()
    };
    let two = vec![vec![0.0; 2]; 2];
    let three = vec![vec![0.0; 3]; 3];
    assert_eq!(
        Universe::from_tables(champions(2), &three, &two).err(),
        Some(UniverseError::Shape("synergy", 2))
    );
    assert_eq!(
        Universe::from_tables(champions(2), &two, &three).err(),
        Some(UniverseError::Shape("counter", 2))
    );
    let mut nan = two.clone();
    nan[0][1] = f64::NAN;
    assert_eq!(
        Universe::from_tables(champions(2), &two, &nan).err(),
        Some(UniverseError::NonFinite("ctr(C0 over C1)".into()))
    );
    // Only the upper triangle is read: a garbage lower triangle is ignored.
    let mut lower = two.clone();
    lower[1][0] = f64::INFINITY;
    assert!(Universe::from_tables(champions(2), &lower, &two).is_ok());
}

// ---------------------------------------------------------------------------------------------
// 5: canonical order (U3)
// ---------------------------------------------------------------------------------------------

/// `board_value`'s loops on picks in the ORDER GIVEN — what a slot-ordered pick list would sum.
fn unsorted_value(u: &Universe, blue: &[ChampionIdx]) -> f64 {
    let mut v = 0.0;
    for &b in blue {
        v += u.linear(b);
    }
    for (i, &b) in blue.iter().enumerate() {
        for &b2 in &blue[i + 1..] {
            v += u.synergy(b, b2);
        }
    }
    v
}

#[test]
fn two_paths_to_the_same_blue_set_give_equal_picks_and_bit_equal_values() {
    let live = live_universe();
    let u = &live.universe;
    // Find a live triple (a < b < c) where summing as [a, b, c] and as [b, a, c] differs in rounding —
    // the case a slot-ordered pick list would expose. The search proves the sort is load-bearing.
    let n = u8::try_from(u.len()).expect("< 256");
    let mut found = None;
    'outer: for a in 0..n {
        for b in (a + 1)..n {
            for c in (b + 1)..n {
                let (a, b, c) = (ChampionIdx(a), ChampionIdx(b), ChampionIdx(c));
                if unsorted_value(u, &[a, b, c]).to_bits()
                    != unsorted_value(u, &[b, a, c]).to_bits()
                {
                    found = Some((a, b, c));
                    break 'outer;
                }
            }
        }
    }
    let (a, b, c) = found.expect("some live triple sums differently in a different order");
    println!(
        "order-sensitive triple: {} {} {}",
        u.id(a),
        u.id(b),
        u.id(c)
    );

    // Slots 0–5 bans, 6 Blue pick, 7–8 Red pair, 9–10 Blue pair. Path 1: Blue a, then pair (b, c).
    // Path 2: Blue b, then pair (a, c). Same Blue set, different slot order.
    // Six bans and two Red picks from indices outside the triple.
    let others: Vec<ChampionIdx> = (0..n)
        .map(ChampionIdx)
        .filter(|i| ![a, b, c].contains(i))
        .take(9)
        .collect();
    let (bans, rest) = others.split_at(6);
    let (reds, next_red) = (&rest[..2], rest[2]);
    let entries = |first: ChampionIdx, pair: [ChampionIdx; 2]| -> Vec<Entry> {
        let mut e: Vec<Entry> = bans.iter().map(|&x| Entry::Ban(x)).collect();
        e.push(Entry::Pick(first));
        e.push(Entry::Pick(reds[0]));
        e.push(Entry::Pick(reds[1]));
        e.push(Entry::Pick(pair[0]));
        e.push(Entry::Pick(pair[1]));
        e
    };
    let format = engine_core::reference::format::Format::standard();
    let pools = Pools {
        blue: [a, b, c].into_iter().collect(),
        red: reds.iter().copied().collect(),
    };
    let p1 =
        Position::new(&format, &entries(a, [b, c]), &pools, u).unwrap_or_else(|e| panic!("{e}"));
    let p2 =
        Position::new(&format, &entries(b, [a, c]), &pools, u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        p1.picks(Side::Blue),
        p2.picks(Side::Blue),
        "index-sorted, not slot-ordered"
    );
    assert_eq!(p1.picks(Side::Blue), &[a, b, c]);
    let value = |p: &Position<'_>| {
        u.value(&Leaf {
            blue: p.picks(Side::Blue),
            red: p.picks(Side::Red),
            blue_feasible: true,
            red_feasible: true,
        })
    };
    assert_eq!(value(&p1).to_bits(), value(&p2).to_bits());
    // And `apply` keeps the invariant on the way down a line.
    let p3 = p2.apply(engine_core::reference::state::Action::Pick(next_red));
    assert_eq!(p3.picks(Side::Red).len(), 3);
    assert!(p3.picks(Side::Red).windows(2).all(|w| w[0] < w[1]));
}

/// R1 on floats (slice-5 review): a both-broken leaf is the board EXACTLY, not `(board − L) + L`.
#[test]
fn a_both_broken_leaf_is_the_board_bit_for_bit_on_live_floats() {
    let live = live_universe();
    let u = &live.universe;
    let blue = sorted(u, &["Pantheon".into(), "Tristana".into(), "Veigar".into()]);
    let red = sorted(u, &["Gwen".into(), "Heimerdinger".into()]);
    let board = u.board_value(&blue, &red);
    let leaf = |blue_feasible: bool, red_feasible: bool| {
        u.value(&Leaf {
            blue: &blue,
            red: &red,
            blue_feasible,
            red_feasible,
        })
    };
    assert_eq!(leaf(false, false).to_bits(), board.to_bits());
    assert_eq!(leaf(true, true).to_bits(), board.to_bits());
    assert_eq!(leaf(false, true), board - u.loss());
    assert_eq!(leaf(true, false), board + u.loss());
    // The identity the old two-step form broke: with L ≈ 1026 the round trip lands an ulp of L away,
    // which is hundreds of ulps of the board.
    assert_ne!(
        ((board - u.loss()) + u.loss()).to_bits(),
        board.to_bits(),
        "the test must sit on a board where (b − L) + L ≠ b, or it proves nothing"
    );
}
