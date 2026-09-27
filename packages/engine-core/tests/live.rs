//! The live universe and the converter (slice-5 design § 9): parity with the FM's structural logit
//! against the Python-exported fixtures, the marginal identity, the set widening, canonical order,
//! the converter on a real session state, and the live-side pruning-soundness check.

mod common;

use common::{load_production_data, repo_root};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side};
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::feasibility::FeasibilityRule;
use engine_core::reference::live::{
    entries_from_draft_state, pools_from_search, DropReason, Dropped, LiveError, LiveRoot,
    LiveUniverse, UnknownId, UnknownList,
};
use engine_core::reference::objective::{Leaf, Objective};
use engine_core::reference::oracle::{Mode, OracleInput};
use engine_core::reference::search::{search, SearchOutcome, SearchParams};
use engine_core::reference::state::{Entry, Pools, Position};
use engine_core::reference::universe::{
    Champion, ChampionIdx, ChampionSet, Universe, UniverseError, MAX_CHAMPIONS,
};
use proptest::prelude::*;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

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

// ---------------------------------------------------------------------------------------------
// 6: the converter on a real session state (U9)
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Sample {
    events: Vec<SampleEvent>,
    pools: SamplePools,
}

#[derive(Deserialize)]
struct SampleEvent {
    slot: usize,
    side: String,
    kind: String,
    champion: String,
}

#[derive(Deserialize)]
struct SamplePools {
    blue: Vec<String>,
    red: Vec<String>,
}

fn sample() -> Sample {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/live/session-fce65eb1.json");
    serde_json::from_str(&std::fs::read_to_string(&path).expect("sample state"))
        .expect("sample parses")
}

/// The state after the first `events` recorded events (the incumbent's count-positional shape).
fn state_at(sample: &Sample, events: usize) -> DraftState {
    let mut state = DraftState::default();
    for (i, e) in sample.events.iter().take(events).enumerate() {
        assert_eq!(e.slot, i, "sample events are in slot order");
        let list = match (e.side.as_str(), e.kind.as_str()) {
            ("blue", "ban") => &mut state.blue_bans,
            ("red", "ban") => &mut state.red_bans,
            ("blue", "pick") => &mut state.blue_picks,
            ("red", "pick") => &mut state.red_picks,
            other => panic!("sample event {other:?}"),
        };
        list.push(e.champion.clone());
    }
    state
}

fn params(node_budget: Option<u64>) -> SearchParams {
    SearchParams {
        node_budget,
        prune: true,
        transposition: true,
        wall_budget: Duration::from_secs(86_400),
        min_completed_depth: 1,
    }
}

fn run(
    root: &LiveRoot,
    u: &Universe,
    mode: Mode,
    params: &SearchParams,
    feasibility: FeasibilityRule,
) -> SearchOutcome {
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    search(
        &OracleInput {
            position: &position,
            universe: u,
            pools: &root.pools,
            objective: u,
            feasibility,
            mode,
            epsilon: 1e-9,
        },
        params,
        &CancelHandle::new(),
        |_| {},
    )
    .unwrap_or_else(|e| panic!("{e}"))
}

#[test]
fn the_sample_state_converts_at_every_root_shape() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));

    // Slot 11: Red single pick after Blue Pantheon / Red Gwen + Heimerdinger / Blue Tristana + Veigar.
    let state = state_at(&s, 11);
    let root = LiveRoot::from_draft_state(&state, &s.pools.blue, &s.pools.red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(root.entries.len(), 11);
    assert!(root.unknown.is_empty());
    assert!(root.excluded.is_empty());
    assert_eq!(
        &root.entries[..6],
        &["Aatrox", "Ahri", "Thresh", "Ivern", "Nidalee", "Blitzcrank"]
            .map(|id| Entry::Ban(idx(id)))
    );
    assert_eq!(
        &root.entries[6..],
        &["Pantheon", "Gwen", "Heimerdinger", "Tristana", "Veigar"].map(|id| Entry::Pick(idx(id)))
    );
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.mover(), Some(Side::Red));
    assert!(!position.is_mid_pair());
    assert_eq!(position.picks(Side::Blue).len(), 3);
    assert_eq!(position.picks(Side::Red).len(), 2);
    assert_eq!(
        root.pools.blue.len(),
        85,
        "every sample Blue pick is already in its pool"
    );
    assert_eq!(root.pools.red.len(), 102);
    assert_eq!(position.available(u).len(), 173 - 11);

    // U5: a past pick outside the recorded pool loads as a fact.
    let blue_without_veigar: Vec<String> = s
        .pools
        .blue
        .iter()
        .filter(|id| *id != "Veigar")
        .cloned()
        .collect();
    let root = LiveRoot::from_draft_state(&state, &blue_without_veigar, &s.pools.red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    assert!(root.pools.blue.contains(idx("Veigar")));
    assert_eq!(root.pools.blue.len(), 85);

    // Slot 7: Red pair start.
    let root = LiveRoot::from_draft_state(&state_at(&s, 7), &s.pools.blue, &s.pools.red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.mover(), Some(Side::Red));
    assert!(position.next_slot().is_some_and(|slot| slot.pair_start));

    // Slot 2: Blue ban (slot 3 belongs to Red).
    let root = LiveRoot::from_draft_state(&state_at(&s, 2), &s.pools.blue, &s.pools.red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.mover(), Some(Side::Blue));
    assert_eq!(
        position.next_slot().map(|slot| slot.action),
        Some(ActionType::Ban)
    );

    // Slot 8: a mid-pair root (Red's first pick of the pair is on the board, D8 2) — the completing
    // pick is a single action.
    let root = LiveRoot::from_draft_state(&state_at(&s, 8), &s.pools.blue, &s.pools.red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.mover(), Some(Side::Red));
    assert!(position.is_mid_pair());
    let legal = position.legal_actions(u, &root.pools);
    assert!(!legal.is_empty());
    assert!(legal
        .iter()
        .all(|a| matches!(a, engine_core::reference::state::Action::Pick(_))));

    // A completed draft converts (twenty entries) and the search refuses it at the root.
    let mut complete = state_at(&s, 11);
    complete.red_picks.push("Jinx".into());
    complete.red_bans.push("Zed".into());
    complete.blue_bans.push("Syndra".into());
    complete.red_bans.push("Lulu".into());
    complete.blue_bans.push("Ornn".into());
    complete.red_picks.push("Kaisa".into());
    complete.blue_picks.push("Leona".into());
    complete.blue_picks.push("Garen".into());
    complete.red_picks.push("Sion".into());
    assert_eq!(complete.turn_index(), 20);
    let root = LiveRoot::from_draft_state(&complete, &s.pools.blue, &s.pools.red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert!(position.is_complete());
    assert_eq!(position.picks(Side::Blue).len(), 5);
    let refused = search(
        &OracleInput {
            position: &position,
            universe: u,
            pools: &root.pools,
            objective: u,
            feasibility: FeasibilityRule::On,
            mode: Mode::Horizon(1),
            epsilon: 1e-9,
        },
        &params(None),
        &CancelHandle::new(),
        |_| {},
    );
    assert!(
        matches!(
            refused,
            Err(engine_core::engine::EngineError::InvalidInput { .. })
        ),
        "{refused:?}"
    );
}

#[test]
fn the_converter_names_every_inconsistency() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();

    let lopsided = DraftState {
        blue_bans: vec!["Aatrox".into(), "Thresh".into()],
        ..Default::default()
    };
    assert_eq!(
        entries_from_draft_state(&lopsided, u).err(),
        Some(LiveError::Inconsistent {
            slot: 1,
            side: Side::Red,
            kind: ActionType::Ban
        })
    );

    let mut unknown = state_at(&s, 2);
    unknown.blue_bans[0] = "Nobody".into();
    assert_eq!(
        entries_from_draft_state(&unknown, u).err(),
        Some(LiveError::UnknownChampion {
            field: "position[0]".into(),
            id: "Nobody".into()
        })
    );

    // U5: a stale POOL or EXCLUSION id is reported, never refused (the incumbent tolerates it too).
    let state = state_at(&s, 11);
    let entries = entries_from_draft_state(&state, u).unwrap_or_else(|e| panic!("{e}"));
    let mut red = s.pools.red.clone();
    red.push("FiddleSticks".into());
    let resolved = pools_from_search(
        &s.pools.blue,
        &red,
        &["Nobody".into()],
        &entries,
        &engine_core::reference::format::Format::standard(),
        u,
    );
    assert_eq!(
        resolved.unknown,
        vec![
            UnknownId {
                list: UnknownList::PoolsRed,
                id: "FiddleSticks".into()
            },
            UnknownId {
                list: UnknownList::Exclusions,
                id: "Nobody".into()
            }
        ]
    );
    assert_eq!(resolved.unknown[0].list.to_string(), "pools.red");
    assert_eq!(resolved.pools.red.len(), 102);
    assert!(resolved.excluded.is_empty());
    let root = LiveRoot::from_draft_state(&state, &s.pools.blue, &red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(root.unknown.len(), 1);
    assert_eq!(root.unknown[0].id, "FiddleSticks");

    let overrun = DraftState {
        blue_bans: vec!["Aatrox".into(); 5],
        red_bans: vec!["Ahri".into(); 5],
        blue_picks: vec!["Zed".into(); 6],
        red_picks: vec!["Jinx".into(); 5],
    };
    assert_eq!(
        entries_from_draft_state(&overrun, u).err(),
        Some(LiveError::TooManyEntries {
            count: 21,
            slots: 20
        })
    );
}

/// Cross-game exclusions (target note § 2): never a ban, never a pick, never a feasibility option.
#[test]
fn excluded_champions_are_never_generated_and_do_not_count_for_feasibility() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let exclusions = ["Hwei".to_string(), "Akali".to_string()];

    // Slot 11, Red pick: Hwei was the unexcluded top pick (§ 8); now it is not even legal.
    let root = LiveRoot::from_draft_state(
        &state_at(&s, 11),
        &s.pools.blue,
        &s.pools.red,
        &exclusions,
        u,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        root.excluded,
        [idx("Hwei"), idx("Akali")].into_iter().collect()
    );
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert!(position.taken().contains(idx("Hwei")), "folded into taken");
    assert_eq!(position.available(u).len(), 173 - 11 - 2);
    let legal = position.legal_actions(u, &root.pools);
    assert!(!legal.contains(&engine_core::reference::state::Action::Pick(idx("Hwei"))));
    assert_eq!(legal.len(), 91, "93 legal picks minus the two excluded");
    let out = run(
        &root,
        u,
        Mode::Horizon(1),
        &params(None),
        FeasibilityRule::On,
    );
    assert!(out
        .ranked
        .iter()
        .all(|r| r.action != engine_core::reference::state::Action::Pick(idx("Hwei"))));

    // Slot 2, Blue ban: an excluded champion is not offered as a ban either.
    let root = LiveRoot::from_draft_state(
        &state_at(&s, 2),
        &s.pools.blue,
        &s.pools.red,
        &exclusions,
        u,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    let legal = position.legal_actions(u, &root.pools);
    assert_eq!(legal.len(), 171 - 2);
    assert!(!legal.contains(&engine_core::reference::state::Action::Ban(idx("Hwei"))));
}

/// A pool that cannot cover five roles (a partial scouting pool) makes the root infeasible: the
/// search refuses with `InvalidInput`, it does not rank (slice-4 R3 root check; named for 5b).
#[test]
fn a_pool_without_a_role_is_refused_at_the_root_not_ranked() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let (_, meta) = load_production_data();
    let no_support: Vec<String> = s
        .pools
        .red
        .iter()
        .filter(|id| !meta[*id].positions.contains(&Role::Support))
        .take(12)
        .cloned()
        .collect();
    assert_eq!(no_support.len(), 12);
    // Slot 2: Red has no picks yet (at slot 11 Red's Heimerdinger already covers support).
    let root = LiveRoot::from_draft_state(&state_at(&s, 2), &s.pools.blue, &no_support, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    let refused = search(
        &OracleInput {
            position: &position,
            universe: u,
            pools: &root.pools,
            objective: u,
            feasibility: FeasibilityRule::On,
            mode: Mode::Horizon(1),
            epsilon: 1e-9,
        },
        &params(None),
        &CancelHandle::new(),
        |_| {},
    );
    match refused {
        Err(engine_core::engine::EngineError::InvalidInput { path }) => {
            assert!(path[0].contains("infeasible"), "{path:?}")
        }
        other => panic!("expected InvalidInput(RootInfeasible), got {other:?}"),
    }
}

#[test]
fn the_reference_search_runs_on_every_sample_root_under_a_node_budget() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    // (events, label, depth the 400 000-node budget allows, partial): the pair root's depth-2
    // iteration (≈ 1.5 × 10⁷ nodes) is cut and depth 1 is returned partial; the others complete.
    for (events, label, depth, partial) in [
        (2usize, "slot 2 Blue ban", 2, false),
        (7, "slot 7 Red pair", 1, true),
        (11, "slot 11 Red pick", 2, false),
    ] {
        let root =
            LiveRoot::from_draft_state(&state_at(&s, events), &s.pools.blue, &s.pools.red, &[], u)
                .unwrap_or_else(|e| panic!("{e}"));
        let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
        let legal = position.legal_actions(u, &root.pools).len();
        let out = run(
            &root,
            u,
            Mode::Horizon(2),
            &params(Some(400_000)),
            FeasibilityRule::On,
        );
        assert_eq!(
            out.ranked.len(),
            legal,
            "{label}: every legal root action is ranked"
        );
        assert!(!out.top_set.is_empty(), "{label}");
        assert_eq!((out.depth, out.partial), (depth, partial), "{label}");
        assert!(out.value.is_finite(), "{label}");
        println!(
            "{label}: {legal} root actions, depth {} (partial {}), value {:.4}, nodes {} / leaves {} / cutoffs {} / hits {}, {:?}",
            out.depth, out.partial, out.value, out.nodes, out.leaves, out.cutoffs, out.table_hits, out.elapsed
        );
    }
}

// ---------------------------------------------------------------------------------------------
// 7: the search agrees with itself on the live universe (pruning soundness without the oracle)
// ---------------------------------------------------------------------------------------------

fn bits(o: &SearchOutcome) -> Vec<(engine_core::reference::state::Action, u64)> {
    o.ranked
        .iter()
        .map(|r| (r.action, r.value.to_bits()))
        .collect()
}

/// R3 pins this shape: every root child has a full window, and a horizon inside the ban phase ties
/// every leaf under a root child, so nothing can cut and nothing is stored. The four configurations
/// must still agree bit for bit.
#[test]
fn prune_and_table_change_no_live_value_at_the_real_pick_root() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let root = LiveRoot::from_draft_state(&state_at(&s, 11), &s.pools.blue, &s.pools.red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let mut outcomes = Vec::new();
    for (prune, transposition) in [(false, false), (true, false), (false, true), (true, true)] {
        let p = SearchParams {
            prune,
            transposition,
            ..params(None)
        };
        let out = run(&root, u, Mode::Horizon(2), &p, FeasibilityRule::On);
        assert_eq!(out.depth, 2);
        assert!(!out.partial);
        assert_eq!(
            out.cutoffs, 0,
            "a full window per root child + a ban ply below it cannot cut"
        );
        assert_eq!(
            out.table_hits, 0,
            "no interior node repeats inside two plies from a pick root"
        );
        println!(
            "slot 11 prune {prune} table {transposition}: nodes {} leaves {} {:?}",
            out.nodes, out.leaves, out.elapsed
        );
        outcomes.push(out);
    }
    for o in &outcomes[1..] {
        assert_eq!(bits(o), bits(&outcomes[0]), "ranked lists differ");
        assert_eq!(o.top_set, outcomes[0].top_set);
    }
}

/// A root where both mechanisms fire on the live universe: slot 14 (Red ban) at horizon 3 — Red ban,
/// Blue ban, Red pick. The two bans commute (S12), so every Red-pick node is reached twice and the
/// second visit is a table hit; the Red-pick layer under a max node is where alpha-beta cuts. The
/// state is the sample extended by three synthetic events (Red pick Jinx at 11, Red ban Zed at 12,
/// Blue ban Syndra at 13) and the pools are cut to six champions each so the test stays inside a
/// debug-build budget; feasibility is off because six-champion pools are not the point here.
#[test]
fn prune_and_table_change_no_live_value_where_both_can_fire() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let mut state = state_at(&s, 11);
    state.red_picks.push("Jinx".into());
    state.red_bans.push("Zed".into());
    state.blue_bans.push("Syndra".into());
    assert_eq!(state.turn_index(), 14);
    let cut = |ids: &[String]| -> Vec<String> {
        ids.iter()
            .filter(|id| !["Jinx", "Zed", "Syndra"].contains(&id.as_str()))
            .take(6)
            .cloned()
            .collect()
    };
    let root = LiveRoot::from_draft_state(&state, &cut(&s.pools.blue), &cut(&s.pools.red), &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.mover(), Some(Side::Red));
    assert_eq!(
        position.next_slot().map(|slot| slot.action),
        Some(ActionType::Ban)
    );

    let plain = run(
        &root,
        u,
        Mode::Horizon(3),
        &SearchParams {
            prune: false,
            transposition: false,
            ..params(None)
        },
        FeasibilityRule::Off,
    );
    let full = run(
        &root,
        u,
        Mode::Horizon(3),
        &SearchParams {
            prune: true,
            transposition: true,
            ..params(None)
        },
        FeasibilityRule::Off,
    );
    for o in [&plain, &full] {
        assert_eq!(o.depth, 3);
        assert!(!o.partial);
        println!(
            "slot 14 prune+table {}: nodes {} leaves {} cutoffs {} hits {} {:?}",
            o.cutoffs > 0 || o.table_hits > 0,
            o.nodes,
            o.leaves,
            o.cutoffs,
            o.table_hits,
            o.elapsed
        );
    }
    assert_eq!(plain.cutoffs, 0);
    assert_eq!(plain.table_hits, 0);
    assert!(
        full.cutoffs > 0,
        "alpha-beta cuts under a max node with distinct leaves"
    );
    assert!(full.table_hits > 0, "commuting bans transpose (S12)");
    assert!(full.leaves < plain.leaves);
    assert_eq!(bits(&full), bits(&plain), "ranked lists differ");
    assert_eq!(full.top_set, plain.top_set);
}

/// § 8 of the design: the unbudgeted depth-2 numbers on the three roots.
/// `cargo test --release -p engine-core --test live -- --ignored --nocapture measure`
#[test]
#[ignore = "measurement, not a gate: cargo test --release --test live -- --ignored --nocapture"]
fn measure_depth_two_on_every_sample_root() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    for (events, label) in [
        (2usize, "slot 2 Blue ban"),
        (7, "slot 7 Red pair"),
        (11, "slot 11 Red pick"),
    ] {
        let root =
            LiveRoot::from_draft_state(&state_at(&s, events), &s.pools.blue, &s.pools.red, &[], u)
                .unwrap_or_else(|e| panic!("{e}"));
        for depth in 1..=2 {
            // The live rule; the gate's counts and top sets on this sample (the pools suffice), see § 8.
            let out = run(
                &root,
                u,
                Mode::Horizon(depth),
                &params(None),
                FeasibilityRule::On,
            );
            println!(
                "{label} | depth {depth} | root actions {} | nodes {} | leaves {} | cutoffs {} | table hits {} | {:?} | top {:?}",
                out.ranked.len(), out.nodes, out.leaves, out.cutoffs, out.table_hits, out.elapsed,
                out.top_set.iter().map(|a| a.champions().map(|c| u.id(c)).collect::<Vec<_>>()).collect::<Vec<_>>()
            );
        }
    }
}
