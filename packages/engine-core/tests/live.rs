//! The live universe and the converter (slice-5 design § 9): parity with the FM's structural logit
//! against the Python-exported fixtures, the marginal identity, the set widening, canonical order,
//! the converter on a real session state, and the live-side pruning-soundness check.

mod common;

use common::{load_production_data, repo_root};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side};
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::feasibility::{off_pool_count, FeasibilityMemo, FeasibilityRule};
use engine_core::reference::fixture::{Fixture, FixtureError};
use engine_core::reference::live::{
    entries_from_draft_state, pools_from_search, DropReason, Dropped, LiveError, LiveRoot,
    LiveUniverse, UnknownId, UnknownList,
};
use engine_core::reference::node::legal_actions_under;
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
            off_pool_cost: None,
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
            off_pool_cost: None,
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
            off_pool_cost: None,
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
                FeasibilityRule::PoolOrRoster,
            );
            println!(
                "{label} | depth {depth} | root actions {} | nodes {} | leaves {} | cutoffs {} | table hits {} | {:?} | top {:?}",
                out.ranked.len(), out.nodes, out.leaves, out.cutoffs, out.table_hits, out.elapsed,
                out.top_set.iter().map(|a| a.champions().map(|c| u.id(c)).collect::<Vec<_>>()).collect::<Vec<_>>()
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// 8: pool or roster (U10) — an exhausted pool draws from the roster instead of refusing
// ---------------------------------------------------------------------------------------------

/// The user's case (2026-09-26): a small pool that bans and picks have used up. Under the hard gate
/// the root is infeasible and the search refuses; under `PoolOrRoster` the side picks from the roster.
#[test]
fn an_exhausted_pool_draws_from_the_roster_under_pool_or_roster() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    // Slot 11: Red holds Gwen + Heimerdinger and needs three more picks; its pool has two left.
    let tiny_red: Vec<String> = ["Gwen", "Heimerdinger", "Hwei", "Zed"]
        .map(String::from)
        .to_vec();
    let root = LiveRoot::from_draft_state(&state_at(&s, 11), &s.pools.blue, &tiny_red, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    let mut memo = FeasibilityMemo::default();

    // The gate: two legal picks, and the side cannot finish — the search refuses at the root.
    assert_eq!(position.legal_actions(u, &root.pools).len(), 2);
    assert_eq!(
        legal_actions_under(&position, u, &root.pools, FeasibilityRule::On, &mut memo).len(),
        2
    );
    let refused = search(
        &OracleInput {
            position: &position,
            universe: u,
            pools: &root.pools,
            objective: u,
            feasibility: FeasibilityRule::On,
            mode: Mode::Horizon(1),
            epsilon: 1e-9,
            off_pool_cost: None,
        },
        &params(None),
        &CancelHandle::new(),
        |_| {},
    );
    assert!(matches!(
        refused,
        Err(engine_core::engine::EngineError::InvalidInput { .. })
    ));

    // The live rule: every available champion is a legal pick, the root is feasible, the search ranks.
    let widened = legal_actions_under(
        &position,
        u,
        &root.pools,
        FeasibilityRule::PoolOrRoster,
        &mut memo,
    );
    assert_eq!(widened.len(), 173 - 11, "the whole roster net of the board");
    assert!(widened.contains(&engine_core::reference::state::Action::Pick(idx("Hwei"))));
    assert!(widened.contains(&engine_core::reference::state::Action::Pick(idx("Jinx"))));
    let out = run(
        &root,
        u,
        Mode::Horizon(2),
        &params(None),
        FeasibilityRule::PoolOrRoster,
    );
    assert_eq!(out.ranked.len(), 173 - 11);
    assert_eq!(out.depth, 2);
    assert!(
        out.ranked.iter().all(|r| r.ends.red_feasible),
        "Red can finish from the roster"
    );
    // The off-pool band: Red needs three picks and has two in-pool, so EVERY line carries exactly
    // one forced off-pool pick (made now, or still to come) — the band ties, and the board decides
    // which pick is the off-pool one. Nothing is charged twice and no line escapes the charge.
    assert!(out
        .ranked
        .iter()
        .all(|r| r.ends.red_off_pool == 1 && r.ends.blue_off_pool == 0));
    println!(
        "exhausted Red pool: top {:?} ({} legal picks, of which 2 in-pool; one forced off-pool pick on every line)",
        out.top_set
            .iter()
            .map(|a| a.champions().map(|c| u.id(c)).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        out.ranked.len()
    );

    // An EMPTY pool is the same case: it cannot complete, so it draws from the roster.
    let root = LiveRoot::from_draft_state(&state_at(&s, 11), &s.pools.blue, &[], &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let out = run(
        &root,
        u,
        Mode::Horizon(1),
        &params(None),
        FeasibilityRule::PoolOrRoster,
    );
    assert_eq!(out.ranked.len(), 173 - 11);
    // Three picks to come, none of them from a pool: one made now, two forecast, on every line.
    assert!(out
        .ranked
        .iter()
        .all(|r| r.ends.red_off_pool == 3 && r.ends.blue_off_pool == 0));
}

/// A pool that cannot cover five roles (the earlier refusal case) ranks under the live rule.
#[test]
fn a_pool_without_a_role_ranks_under_pool_or_roster() {
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
    let root = LiveRoot::from_draft_state(&state_at(&s, 2), &s.pools.blue, &no_support, &[], u)
        .unwrap_or_else(|e| panic!("{e}"));
    let out = run(
        &root,
        u,
        Mode::Horizon(1),
        &params(None),
        FeasibilityRule::PoolOrRoster,
    );
    assert_eq!(
        out.ranked.len(),
        171,
        "a Blue ban root: every available champion"
    );
    assert!(out.ranked.iter().all(|r| r.ends.red_feasible));
}

/// While the pools suffice, `PoolOrRoster` is the gate: the same ranked order, top sets and counts
/// on every sample root, bit-equal values on every line that leaves both sides feasible, and the
/// lines that break a side shifted by the band difference L' − L (within rounding).
#[test]
fn pool_or_roster_is_the_gate_while_the_pools_suffice() {
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
        let gate = run(
            &root,
            u,
            Mode::Horizon(1),
            &params(None),
            FeasibilityRule::On,
        );
        let live_rule = run(
            &root,
            u,
            Mode::Horizon(1),
            &params(None),
            FeasibilityRule::PoolOrRoster,
        );
        // Same order, same top set, same counts; every line ends the same way and carries no off-pool
        // count (the pools suffice); bit-equal values on every line that leaves both sides feasible.
        // A line that breaks a side (a Red pair of two sole-ADCs, say) is priced at L under the gate
        // and at L' under the live rule (U10), so those values differ by exactly the band difference.
        let actions = |o: &SearchOutcome| o.ranked.iter().map(|r| r.action).collect::<Vec<_>>();
        assert_eq!(actions(&gate), actions(&live_rule), "{label}");
        assert_eq!(gate.top_set, live_rule.top_set, "{label}");
        assert_eq!(
            (gate.nodes, gate.leaves),
            (live_rule.nodes, live_rule.leaves),
            "{label}"
        );
        let shift = u.live_loss() - u.loss();
        for (g, l) in gate.ranked.iter().zip(&live_rule.ranked) {
            assert_eq!(
                (g.ends.kind, g.ends.blue_feasible, g.ends.red_feasible),
                (l.ends.kind, l.ends.blue_feasible, l.ends.red_feasible),
                "{label} {:?}",
                g.action
            );
            assert_eq!(
                (l.ends.blue_off_pool, l.ends.red_off_pool),
                (0, 0),
                "{label} {:?}: the pools suffice",
                g.action
            );
            if g.ends.blue_feasible && g.ends.red_feasible {
                assert_eq!(
                    g.value.to_bits(),
                    l.value.to_bits(),
                    "{label} {:?}",
                    g.action
                );
            } else {
                assert!(
                    ((l.value - g.value).abs() - shift).abs() <= 1e-9 * shift,
                    "{label} {:?}: gate {} live {}",
                    g.action,
                    g.value,
                    l.value
                );
            }
        }
    }
}

/// The incentive the cost exists for (review round 3), on a universe small enough for the ORACLE:
/// sixteen champions, one per role in each pool, one spare support and one spare top in neither pool,
/// four junk champions banned at slots 0–3. Root: Blue's ban at slot 4, horizon 3 (Blue ban, Red ban,
/// Blue pick), every table zero so only the bands speak (L = P = 1, L' = 11). Denying a Red champion
/// of a role the roster can still refill (T2, S2: a spare top and support exist) is worth +P — Red
/// bans Blue's champion of the OTHER refillable role and Blue takes Red's, so Red is forced off-pool
/// twice against Blue's once; those two form the top set. Self-banning such a role (T1, S1) is −P
/// and ranks last. The spares (S3, X1) are harmless, 0. Jungle, mid and ADC have two champions
/// each, so banning either one (own or Red's) invites the other ban and the mutual break: both
/// sides broken, R1 values the leaf at the board, 0 — the S11 residual on a two-per-role universe.
/// What the cost exists for: no self-ban is positive, no denial is below a harmless ban — measured
/// on this probe; it holds while P > 2Σ (a flat P is lexicographic), not as a theorem. The oracle
/// and the search agree bit for bit. (Every value here is the engine's: two hand derivations were
/// wrong before the lines were printed.)
#[test]
fn self_break_is_the_worst_action_and_denial_is_a_top_action_under_the_cost() {
    use engine_core::reference::oracle::evaluate;
    let mk = |id: &str, role: Role| Champion {
        id: id.into(),
        positions: vec![role],
        linear: 0.0,
    };
    let champions = vec![
        mk("T1", Role::Top),
        mk("J1", Role::Jungle),
        mk("M1", Role::Middle),
        mk("A1", Role::Adc),
        mk("S1", Role::Support),
        mk("T2", Role::Top),
        mk("J2", Role::Jungle),
        mk("M2", Role::Middle),
        mk("A2", Role::Adc),
        mk("S2", Role::Support),
        mk("S3", Role::Support),
        mk("X1", Role::Top),
        mk("B1", Role::Top),
        mk("B2", Role::Top),
        mk("B3", Role::Top),
        mk("B4", Role::Top),
    ];
    let n = champions.len();
    let zero = vec![vec![0.0; n]; n];
    let u = Universe::from_tables(champions, &zero, &zero).unwrap_or_else(|e| panic!("{e}"));
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let set = |ids: &[&str]| -> ChampionSet { ids.iter().map(|id| idx(id)).collect() };
    let pools = Pools {
        blue: set(&["T1", "J1", "M1", "A1", "S1"]),
        red: set(&["T2", "J2", "M2", "A2", "S2"]),
    };
    let format = engine_core::reference::format::Format::standard();
    let entries: Vec<Entry> = ["B1", "B2", "B3", "B4"]
        .iter()
        .map(|id| Entry::Ban(idx(id)))
        .collect();
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(position.mover(), Some(Side::Blue));
    assert_eq!(
        position.available(&u).len(),
        12,
        "inside the oracle's bound"
    );
    let input = OracleInput {
        position: &position,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: FeasibilityRule::PoolOrRoster,
        mode: Mode::Horizon(3),
        epsilon: 1e-9,
        off_pool_cost: None,
    };
    let oracle = evaluate(&input).unwrap_or_else(|e| panic!("{e}"));
    let engine = search(&input, &params(None), &CancelHandle::new(), |_| {})
        .unwrap_or_else(|e| panic!("{e}"));
    let oracle_ranked: Vec<(engine_core::reference::state::Action, u64)> = oracle
        .ranked
        .iter()
        .map(|r| (r.action, r.value.to_bits()))
        .collect();
    assert_eq!(
        bits(&engine),
        oracle_ranked,
        "the search must agree with the oracle under the rule"
    );
    assert_eq!(engine.top_set, oracle.top_set);
    for r in &engine.ranked {
        println!(
            "incentive probe: {:>3} {:+.1}  ends {:?} blue {} red {} off-pool {}/{}  line {:?}",
            r.action
                .champions()
                .map(|c| u.id(c))
                .collect::<Vec<_>>()
                .join("+"),
            r.value,
            r.ends.kind,
            r.ends.blue_feasible,
            r.ends.red_feasible,
            r.ends.blue_off_pool,
            r.ends.red_off_pool,
            r.continuation
                .iter()
                .map(|a| a.champions().map(|c| u.id(c)).collect::<Vec<_>>().join("+"))
                .collect::<Vec<_>>()
        );
    }

    let ban = |id: &str| engine_core::reference::state::Action::Ban(idx(id));
    let value_of = |id: &str| -> f64 {
        engine
            .ranked
            .iter()
            .find(|r| r.action == ban(id))
            .map(|r| r.value)
            .unwrap_or_else(|| panic!("{id} not ranked"))
    };
    // Denial of a role the roster can still refill (a spare top or support exists): Red is forced
    // off-pool for the spare and cannot punish in kind — worth +P, and the top set.
    assert_eq!(
        engine.top_set,
        [ban("T2"), ban("S2")].to_vec(),
        "denial where the roster has a spare"
    );
    for deny in ["T2", "S2"] {
        assert_eq!(
            value_of(deny),
            1.0,
            "{deny}: Red goes off-pool for the spare"
        );
    }
    // Self-banning a role with a spare: Red bans the other and Blue must fetch the spare — two
    // forced picks against one, −P, and the two rank last.
    for own in ["T1", "S1"] {
        assert_eq!(value_of(own), -1.0, "self-break {own}");
    }
    let last_two: Vec<_> = engine.ranked[engine.ranked.len() - 2..]
        .iter()
        .map(|r| r.action)
        .collect();
    assert_eq!(last_two, [ban("T1"), ban("S1")].to_vec());
    // The spares themselves: harmless, 0.
    for spare in ["S3", "X1"] {
        assert_eq!(value_of(spare), 0.0, "{spare}: harmless");
    }
    // Jungle, mid and ADC have exactly two champions here, so banning EITHER one lets the opponent
    // ban the other and exhaust the role for both sides: the leaf is both-broken and R1 values it at
    // the board (the S11 residual — antisymmetry forces the mutual break to 0). Those six bans
    // therefore tie the harmless bans; a probe artefact of a two-per-role universe (a 173-champion
    // roster cannot lose a role to two bans), recorded so nobody reads it as "self-break is free".
    for two_deep in ["J1", "M1", "A1", "J2", "M2", "A2"] {
        let line = engine
            .ranked
            .iter()
            .find(|r| r.action == ban(two_deep))
            .unwrap_or_else(|| panic!("{two_deep}"));
        assert_eq!(line.value, 0.0, "{two_deep}: the mutual break");
        assert!(
            !line.ends.blue_feasible && !line.ends.red_feasible,
            "{two_deep}: both sides broken"
        );
    }
    // What the cost exists for (review round 3): no self-ban is positive, and no denial is below a
    // harmless ban.
    for own in ["T1", "J1", "M1", "A1", "S1"] {
        assert!(value_of(own) <= 0.0, "self-break {own} never pays");
    }
    for deny in ["T2", "J2", "M2", "A2", "S2"] {
        assert!(
            value_of(deny) >= 0.0,
            "denial {deny} is never worse than a harmless ban"
        );
    }
    // The literals above are ±P: zero tables give L = P = 1 and L' = 11 (asserted last, so a
    // mutation of the cost fails on a value, not on this line).
    assert_eq!(
        (u.off_pool_cost(), u.loss(), u.live_loss()),
        (1.0, 1.0, 11.0)
    );
    println!(
        "incentive probe: top set {:?}, nodes {} leaves {}",
        engine
            .top_set
            .iter()
            .map(|a| a.champions().map(|c| u.id(c)).collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        engine.nodes,
        engine.leaves
    );
}

/// A universe for the band tests: bans `K1..K10` (junk tops), the named champions with the linear
/// term given, every pairwise table zero — so Σ is the sum of the linear terms and L, P, L' are
/// small integers the assertions can name.
fn band_universe(named: &[(&str, Role, f64)]) -> Universe {
    let mk = |id: &str, role: Role, linear: f64| Champion {
        id: id.into(),
        positions: vec![role],
        linear,
    };
    let mut champions: Vec<Champion> = named
        .iter()
        .map(|(id, role, linear)| mk(id, *role, *linear))
        .collect();
    for i in 1..=10 {
        champions.push(mk(&format!("K{i}"), Role::Top, 0.0));
    }
    let n = champions.len();
    let zero = vec![vec![0.0; n]; n];
    Universe::from_tables(champions, &zero, &zero).unwrap_or_else(|e| panic!("{e}"))
}

/// Review round 4's reachable defect (the user's small-pool case at the last pick): five locked
/// champions that cannot fill five roles are infeasible on ANY roster, so a side whose pool has no
/// support chooses at its final pick between the honest off-pool support (−P) and a suicide fifth
/// pick from its own pool (−L'). With L' = L = P the board decided and a strong in-pool champion won;
/// L' = L + 10P makes the off-pool pick win whatever the board says. Red's last pick (slot 19): four
/// non-supports locked, two non-supports left in the pool (the top is worth 0.5 to Red), one support
/// on the roster. Oracle-checked.
#[test]
fn an_off_pool_support_beats_every_in_pool_suicide_fifth_pick() {
    use engine_core::reference::oracle::evaluate;
    use engine_core::reference::state::Action;
    let u = band_universe(&[
        ("BT", Role::Top, 0.0),
        ("BJ", Role::Jungle, 0.0),
        ("BM", Role::Middle, 0.0),
        ("BA", Role::Adc, 0.0),
        ("BS", Role::Support, 0.0),
        ("RT", Role::Top, 0.0),
        ("RJ", Role::Jungle, 0.0),
        ("RM", Role::Middle, 0.0),
        ("RA", Role::Adc, 0.0),
        ("X1", Role::Top, 0.5),
        ("X2", Role::Middle, 0.0),
        ("S", Role::Support, 0.0),
    ]);
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let set = |ids: &[&str]| -> ChampionSet { ids.iter().map(|id| idx(id)).collect() };
    assert_eq!(
        (u.loss(), u.off_pool_cost(), u.live_loss()),
        (2.0, 2.0, 22.0)
    );
    let pools = Pools {
        blue: set(&["BT", "BJ", "BM", "BA", "BS"]),
        red: set(&["RT", "RJ", "RM", "RA", "X1", "X2"]),
    };
    let format = engine_core::reference::format::Format::standard();
    // Slots 0–18 in order: six bans, B pick, R pair, B pair, R pick, four bans, R pick, B pair.
    let entries: Vec<Entry> = [
        ("K1", true),
        ("K2", true),
        ("K3", true),
        ("K4", true),
        ("K5", true),
        ("K6", true),
        ("BT", false),
        ("RT", false),
        ("RJ", false),
        ("BJ", false),
        ("BM", false),
        ("RM", false),
        ("K7", true),
        ("K8", true),
        ("K9", true),
        ("K10", true),
        ("RA", false),
        ("BA", false),
        ("BS", false),
    ]
    .iter()
    .map(|(id, ban)| {
        if *ban {
            Entry::Ban(idx(id))
        } else {
            Entry::Pick(idx(id))
        }
    })
    .collect();
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (position.mover(), position.slot_index()),
        (Some(Side::Red), 19)
    );
    let mut memo = FeasibilityMemo::default();
    // The gate refuses (two in-pool non-supports cannot finish); the live rule widens to X1, X2, S.
    let widened = legal_actions_under(
        &position,
        &u,
        &pools,
        FeasibilityRule::PoolOrRoster,
        &mut memo,
    );
    assert_eq!(widened.len(), 3);
    let input = OracleInput {
        position: &position,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: FeasibilityRule::PoolOrRoster,
        mode: Mode::Horizon(1),
        epsilon: 1e-9,
        off_pool_cost: None,
    };
    let oracle = evaluate(&input).unwrap_or_else(|e| panic!("{e}"));
    let engine = search(&input, &params(None), &CancelHandle::new(), |_| {})
        .unwrap_or_else(|e| panic!("{e}"));
    let oracle_ranked: Vec<(Action, u64)> = oracle
        .ranked
        .iter()
        .map(|r| (r.action, r.value.to_bits()))
        .collect();
    assert_eq!(bits(&engine), oracle_ranked);
    let line = |id: &str| {
        engine
            .ranked
            .iter()
            .find(|r| r.action == Action::Pick(idx(id)))
            .unwrap_or_else(|| panic!("{id} not ranked"))
    };
    // Honest: the roster support, one off-pool pick made, Red still feasible → board + P.
    assert_eq!(line("S").value, u.off_pool_cost());
    assert!(line("S").ends.red_feasible && line("S").ends.red_off_pool == 1);
    // Suicide: five non-supports, infeasible on any roster, no off-pool pick → board + L'.
    assert_eq!(line("X1").value, -0.5 + u.live_loss());
    assert!(!line("X1").ends.red_feasible && line("X1").ends.red_off_pool == 0);
    assert_eq!(engine.top_set, vec![Action::Pick(idx("S"))]);
    assert_eq!(
        engine.ranked.last().map(|r| r.action),
        Some(Action::Pick(idx("X2")))
    );
    // The fixture is not vacuous: priced at L instead of L' the suicide top would have ranked FIRST.
    assert!(-0.5 + u.loss() < u.off_pool_cost());
}

/// The same collision two roles deep (review round 4: "with two roles missing, suicide at −L beats
/// honest at −2P outright"). Blue's pair at slots 17–18 with top, jungle and mid locked and only a
/// top and a jungle left in its pool (each worth 0.5 to Blue): the honest pair takes an ADC and a
/// support from the roster (two forced picks, −2P), the suicide pair keeps the pool and breaks the
/// comp (−L'). With L' = L the suicide pair would have won by the board. The best honest pair takes
/// Red's only support, forcing Red off-pool in turn — the live form of denial, worth +P. Oracle-checked.
#[test]
fn two_forced_off_pool_picks_beat_a_suicide_pair() {
    use engine_core::reference::oracle::evaluate;
    use engine_core::reference::state::Action;
    let u = band_universe(&[
        ("BT", Role::Top, 0.0),
        ("BJ", Role::Jungle, 0.0),
        ("BM", Role::Middle, 0.0),
        ("Y1", Role::Top, 0.5),
        ("Y2", Role::Jungle, 0.5),
        ("RT", Role::Top, 0.0),
        ("RJ", Role::Jungle, 0.0),
        ("RM", Role::Middle, 0.0),
        ("RA", Role::Adc, 0.0),
        ("RS", Role::Support, 0.0),
        ("A", Role::Adc, 0.0),
        ("S", Role::Support, 0.0),
    ]);
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let set = |ids: &[&str]| -> ChampionSet { ids.iter().map(|id| idx(id)).collect() };
    assert_eq!(
        (u.loss(), u.off_pool_cost(), u.live_loss()),
        (3.0, 3.0, 33.0)
    );
    let pools = Pools {
        blue: set(&["BT", "BJ", "BM", "Y1", "Y2"]),
        red: set(&["RT", "RJ", "RM", "RA", "RS"]),
    };
    let format = engine_core::reference::format::Format::standard();
    // Slots 0–16: six bans, B pick, R pair, B pair, R pick, four bans, R pick — Blue's pair is next.
    let entries: Vec<Entry> = [
        ("K1", true),
        ("K2", true),
        ("K3", true),
        ("K4", true),
        ("K5", true),
        ("K6", true),
        ("BT", false),
        ("RT", false),
        ("RJ", false),
        ("BJ", false),
        ("BM", false),
        ("RM", false),
        ("K7", true),
        ("K8", true),
        ("K9", true),
        ("K10", true),
        ("RA", false),
    ]
    .iter()
    .map(|(id, ban)| {
        if *ban {
            Entry::Ban(idx(id))
        } else {
            Entry::Pick(idx(id))
        }
    })
    .collect();
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (position.mover(), position.slot_index()),
        (Some(Side::Blue), 17)
    );
    let input = OracleInput {
        position: &position,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: FeasibilityRule::PoolOrRoster,
        mode: Mode::Horizon(1),
        epsilon: 1e-9,
        off_pool_cost: None,
    };
    let oracle = evaluate(&input).unwrap_or_else(|e| panic!("{e}"));
    let engine = search(&input, &params(None), &CancelHandle::new(), |_| {})
        .unwrap_or_else(|e| panic!("{e}"));
    let oracle_ranked: Vec<(Action, u64)> = oracle
        .ranked
        .iter()
        .map(|r| (r.action, r.value.to_bits()))
        .collect();
    assert_eq!(bits(&engine), oracle_ranked);
    assert_eq!(engine.ranked.len(), 10, "every pair of the five available");
    let pair = |a: &str, b: &str| Action::pair(idx(a), idx(b));
    let line = |action: Action| {
        engine
            .ranked
            .iter()
            .find(|r| r.action == action)
            .unwrap_or_else(|| panic!("{action:?} not ranked"))
    };
    let p = u.off_pool_cost();
    // Honest, and Red keeps its support: two forced picks → −2P.
    assert_eq!(line(pair("A", "S")).value, -2.0 * p);
    assert_eq!(line(pair("A", "S")).ends.blue_off_pool, 2);
    // Honest and denying: Red's pool can no longer finish, so Red is charged one forced pick → −P.
    assert_eq!(line(pair("A", "RS")).value, -p);
    assert_eq!(
        (
            line(pair("A", "RS")).ends.blue_off_pool,
            line(pair("A", "RS")).ends.red_off_pool
        ),
        (2, 1)
    );
    assert_eq!(engine.top_set, vec![pair("A", "RS")]);
    // Suicide: Blue infeasible on any roster, nothing off-pool → board − L'.
    assert_eq!(line(pair("Y1", "Y2")).value, 1.0 - u.live_loss());
    assert!(!line(pair("Y1", "Y2")).ends.blue_feasible);
    // Every line that breaks Blue ALONE ranks below both honest lines. The pair that takes both
    // supports (RS + S) breaks Red too, and R1 values a both-broken leaf at the board — here the
    // board net of Blue's two off-pool picks, −2P, tying the honest (A, S): the S11 residual
    // (target note § 6), reachable when the mover can exhaust a role for both sides; unchanged here.
    let honest_floor = line(pair("A", "S")).value;
    for r in &engine.ranked {
        if !r.ends.blue_feasible && r.ends.red_feasible {
            assert!(r.value < honest_floor, "{:?} breaks Blue alone", r.action);
        }
    }
    assert_eq!(line(pair("RS", "S")).value, -2.0 * p);
    assert!(!line(pair("RS", "S")).ends.blue_feasible && !line(pair("RS", "S")).ends.red_feasible);
    // The fixture is not vacuous: priced at L the suicide pair would have beaten both honest pairs.
    assert!(1.0 - u.loss() > -p);
}

/// Review round 4, defect 3: the forced-pick bound is a role count, not a champion count. Red has
/// top, jungle and mid locked and two picks to come; its pool still holds three champions, but all
/// of them are tops or junglers — the pool is short by two ROLES with champions to spare. The old
/// bound (`max(1, remaining − |pool net|)`) charged 1; the matching bound charges 2, at every leaf
/// of a Blue-ban root inside the horizon (so the charge is a forecast, not a pick already made).
/// Oracle-checked.
#[test]
fn a_pool_short_by_two_roles_is_charged_two_forced_picks() {
    use engine_core::reference::oracle::evaluate;
    use engine_core::reference::state::Action;
    let u = band_universe(&[
        ("BT", Role::Top, 0.0),
        ("BJ", Role::Jungle, 0.0),
        ("BM", Role::Middle, 0.0),
        ("BA", Role::Adc, 0.0),
        ("BS", Role::Support, 0.0),
        ("RT", Role::Top, 0.0),
        ("RJ", Role::Jungle, 0.0),
        ("RM", Role::Middle, 0.0),
        ("X1", Role::Top, 0.0),
        ("X2", Role::Top, 0.0),
        ("X3", Role::Jungle, 0.0),
        ("A1", Role::Adc, 0.0),
        ("A2", Role::Adc, 0.0),
        ("S1", Role::Support, 0.0),
        ("S2", Role::Support, 0.0),
    ]);
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let set = |ids: &[&str]| -> ChampionSet { ids.iter().map(|id| idx(id)).collect() };
    let pools = Pools {
        blue: set(&["BT", "BJ", "BM", "BA", "BS"]),
        red: set(&["RT", "RJ", "RM", "X1", "X2", "X3"]),
    };
    let format = engine_core::reference::format::Format::standard();
    // Slots 0–12: six bans, B pick, R pair, B pair, R pick, R ban — Blue's ban at slot 13 is next.
    let entries: Vec<Entry> = [
        ("K1", true),
        ("K2", true),
        ("K3", true),
        ("K4", true),
        ("K5", true),
        ("K6", true),
        ("BT", false),
        ("RT", false),
        ("RJ", false),
        ("BJ", false),
        ("BM", false),
        ("RM", false),
        ("K7", true),
    ]
    .iter()
    .map(|(id, ban)| {
        if *ban {
            Entry::Ban(idx(id))
        } else {
            Entry::Pick(idx(id))
        }
    })
    .collect();
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (position.mover(), position.slot_index()),
        (Some(Side::Blue), 13)
    );
    let mut memo = FeasibilityMemo::default();
    assert_eq!(
        off_pool_count(
            &mut memo,
            FeasibilityRule::PoolOrRoster,
            Side::Red,
            &position,
            &pools,
            &u
        ),
        2,
        "two roles the pool cannot cover, whatever its size"
    );
    assert_eq!(
        off_pool_count(
            &mut memo,
            FeasibilityRule::PoolOrRoster,
            Side::Blue,
            &position,
            &pools,
            &u
        ),
        0
    );
    let input = OracleInput {
        position: &position,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: FeasibilityRule::PoolOrRoster,
        mode: Mode::Horizon(1),
        epsilon: 1e-9,
        off_pool_cost: None,
    };
    let oracle = evaluate(&input).unwrap_or_else(|e| panic!("{e}"));
    let engine = search(&input, &params(None), &CancelHandle::new(), |_| {})
        .unwrap_or_else(|e| panic!("{e}"));
    let oracle_ranked: Vec<(Action, u64)> = oracle
        .ranked
        .iter()
        .map(|r| (r.action, r.value.to_bits()))
        .collect();
    assert_eq!(bits(&engine), oracle_ranked);
    // Twelve bans (25 champions, 13 on the board). No single ban can take a role from the roster
    // (two ADCs, two supports), so every leaf forecasts Red's two forced picks: ten bans tie at +2P.
    // The two that ban Blue's OWN ADC or support leave Blue's pool short by one role — one forced
    // pick for Blue, +P — and rank below them (self-break by a ban, priced by the same bound).
    assert_eq!(engine.ranked.len(), 12);
    assert_eq!(engine.top_set.len(), 10);
    assert_eq!(engine.value, 2.0 * u.off_pool_cost());
    for r in &engine.ranked {
        let own = r.action == Action::Ban(idx("BA")) || r.action == Action::Ban(idx("BS"));
        assert!(
            r.ends.red_feasible && r.ends.blue_feasible,
            "{:?}",
            r.action
        );
        assert_eq!(
            (r.ends.red_off_pool, r.ends.blue_off_pool),
            (2, usize::from(own)),
            "{:?}",
            r.action
        );
        assert_eq!(
            r.value,
            if own { 1.0 } else { 2.0 } * u.off_pool_cost(),
            "{:?}",
            r.action
        );
    }
}

/// Review round 4, defect 5 (round 1's shape in a new place): equal off-pool counts must leave the
/// board bit for bit. On the sample board `(board − P) + P ≠ board`, so the counts are netted as
/// integers before the one multiply; the gate rules ignore the counts and are `value` itself.
#[test]
fn equal_off_pool_counts_leave_the_board_bit_for_bit() {
    let live = live_universe();
    let u = &live.universe;
    let blue = sorted(u, &["Pantheon".into(), "Tristana".into(), "Veigar".into()]);
    let red = sorted(u, &["Gwen".into(), "Heimerdinger".into()]);
    let board = u.board_value(&blue, &red);
    let leaf = Leaf {
        blue: &blue,
        red: &red,
        blue_feasible: true,
        red_feasible: true,
    };
    let p = u.off_pool_cost();
    assert_ne!(
        ((board - p) + p).to_bits(),
        board.to_bits(),
        "the test must sit on a board where (b − P) + P ≠ b, or it proves nothing"
    );
    for k in 0..=5 {
        assert_eq!(
            u.value_under(&leaf, FeasibilityRule::PoolOrRoster, p, k, k)
                .to_bits(),
            board.to_bits(),
            "{k} off-pool picks each"
        );
    }
    assert_eq!(
        u.value_under(&leaf, FeasibilityRule::PoolOrRoster, p, 0, 2),
        board + 2.0 * p
    );
    assert_eq!(
        u.value_under(&leaf, FeasibilityRule::PoolOrRoster, p, 3, 1),
        board - 2.0 * p
    );
    for rule in [FeasibilityRule::On, FeasibilityRule::Off] {
        assert_eq!(
            u.value_under(&leaf, rule, 0.0, 0, 0).to_bits(),
            u.value(&leaf).to_bits()
        );
    }
    // The live band: L' = L + 10P, and a side broken on any roster sits at it.
    assert_eq!(u.live_loss(), u.loss() + 10.0 * p);
    let broken = Leaf {
        blue: &blue,
        red: &red,
        blue_feasible: false,
        red_feasible: true,
    };
    assert_eq!(
        u.value_under(&broken, FeasibilityRule::PoolOrRoster, p, 0, 0),
        board - u.live_loss()
    );
    assert_eq!(u.value(&broken), board - u.loss());
}

/// Review round 4's verification reproduced the collision on LIVE data: slot 7 with Red's pool cut
/// to Aphelios and Ashe (both ADC-only), horizon 1. The pair (Aphelios, Ashe) breaks Red on any
/// roster and, priced at L = P, beat every feasible line — each of which carries at least four
/// off-pool picks, because only one of the two ADCs can ever be used. Under L' the top line is
/// Red-feasible. The
/// roster is cut by exclusions to twenty-two champions (four of each primary role from Blue's own
/// pool, so Blue never widens, plus the two ADCs): the widened pair fan is then 231, not 13 695 —
/// the collision lives in the pool's shape, not the roster's size.
#[test]
fn a_two_adc_pool_at_the_pair_root_does_not_pick_the_suicide_pair() {
    use engine_core::reference::state::Action;
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let on_board: Vec<String> = s
        .events
        .iter()
        .take(7)
        .map(|e| e.champion.clone())
        .collect();
    let exclusions = cut_roster(&s, &on_board, &["Aphelios".into(), "Ashe".into()]);
    let tiny_red: Vec<String> = ["Aphelios", "Ashe"].map(String::from).to_vec();
    let root =
        LiveRoot::from_draft_state(&state_at(&s, 7), &s.pools.blue, &tiny_red, &exclusions, u)
            .unwrap_or_else(|e| panic!("{e}"));
    assert!(root.unknown.is_empty());
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (position.mover(), position.available(u).len()),
        (Some(Side::Red), 22)
    );
    let out = run(
        &root,
        u,
        Mode::Horizon(1),
        &params(None),
        FeasibilityRule::PoolOrRoster,
    );
    assert_eq!(out.ranked.len(), 231, "every pair of the 22 available");
    let suicide = out
        .ranked
        .iter()
        .find(|r| r.action == Action::pair(idx("Aphelios"), idx("Ashe")))
        .unwrap_or_else(|| panic!("the suicide pair is legal"));
    assert!(!suicide.ends.red_feasible && suicide.ends.red_off_pool == 0);
    let top = &out.ranked[0];
    assert!(top.ends.red_feasible, "the top line must not break Red");
    // Every feasible line: Red uses at most one of its two ADCs, so at least four picks come from
    // outside the pool (made now plus forecast) — five when the pair itself takes the ADC role and
    // neither pool ADC can ever be used; Blue's cut pool still covers five roles.
    assert_eq!((top.ends.red_off_pool, top.ends.blue_off_pool), (4, 0));
    for r in out.ranked.iter().filter(|r| r.ends.red_feasible) {
        assert!(
            r.ends.red_off_pool >= 4 && r.ends.blue_off_pool == 0,
            "{:?}: {:?}",
            r.action,
            r.ends
        );
        // Red minimises: the suicide pair sits at board + L', above every feasible line's board + 4P or 5P.
        assert!(r.value < suicide.value, "{:?}", r.action);
    }
    // Not vacuous: priced at L instead of L' the suicide pair would have beaten the top line.
    assert!(suicide.value - u.live_loss() + u.loss() < top.value);
    println!(
        "two-ADC pool at slot 7: top {:?} value {:.4}; suicide pair value {:.4}",
        top.action.champions().map(|c| u.id(c)).collect::<Vec<_>>(),
        top.value,
        suicide.value
    );
}

/// Round 5 (Codex): a finite L' is not enough — the largest live leaf is |board| + 5P + L' (a side
/// broken alone with off-pool picks made), so `from_tables` refuses a universe where that bound
/// overflows although L and L' are both finite, and one where L is finite but L' is not.
#[test]
fn a_universe_whose_largest_live_leaf_overflows_is_refused() {
    let two = |linear: f64| {
        vec![
            Champion {
                id: "A".into(),
                positions: vec![Role::Top],
                linear,
            },
            Champion {
                id: "B".into(),
                positions: vec![Role::Support],
                linear: 0.0,
            },
        ]
    };
    let zero = vec![vec![0.0; 2]; 2];
    let refused = |linear: f64| Universe::from_tables(two(linear), &zero, &zero).err();
    // L ≈ MAX/12 and L' ≈ 11·MAX/12 are finite; Σ + 5P + L' ≈ 33·MAX/24 is not.
    assert_eq!(
        refused(f64::MAX / 24.0),
        Some(UniverseError::NonFinite("L'".into()))
    );
    // L ≈ MAX/4 is finite; L' = L + 10·L is not.
    assert_eq!(
        refused(f64::MAX / 8.0),
        Some(UniverseError::NonFinite("L'".into()))
    );
    // L itself overflows first (the slice-4 check).
    assert_eq!(
        refused(f64::MAX),
        Some(UniverseError::NonFinite("L".into()))
    );
    // Under the bound the universe builds and L' is the exact sum.
    let u =
        Universe::from_tables(two(f64::MAX / 64.0), &zero, &zero).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(u.live_loss(), u.loss() + 10.0 * u.off_pool_cost());
}

/// The exclusion list that leaves exactly `extra` plus four champions of each primary role from
/// Blue's own pool available (so Blue's pool always covers five roles and never widens), given
/// what is already on the board. Keeps the live universe and the pools real while cutting a pair
/// fan from thousands to a few hundred (tests 8e, 8i).
fn cut_roster(s: &Sample, on_board: &[String], extra: &[String]) -> Vec<String> {
    let (_, meta) = load_production_data();
    let mut keep: Vec<String> = extra.to_vec();
    for role in [
        Role::Top,
        Role::Jungle,
        Role::Middle,
        Role::Adc,
        Role::Support,
    ] {
        let mut ids: Vec<&String> = s
            .pools
            .blue
            .iter()
            .filter(|id| !on_board.contains(id) && !keep.contains(id))
            .filter(|id| meta[*id].positions.first() == Some(&role))
            .collect();
        ids.sort();
        assert!(ids.len() >= 4, "{role:?}: Blue's pool has four primaries");
        keep.extend(ids.into_iter().take(4).cloned());
    }
    meta.keys()
        .filter(|id| !keep.contains(id) && !on_board.contains(id))
        .cloned()
        .collect()
}

/// Review round 5 (judgement): the incentive probe's tables are all zero, so no board gain ever sits
/// behind a self-ban and "self-break never pays" was vacuous there. Here it is not: a roster support
/// SX is worth +1 to Blue, Blue's pool can finish (BA, BS), and the only road to SX is to ban one's
/// own support first. Blue's ban at slot 15, horizon 3 (ban, Red's pick, Blue's pair): at P = L the
/// self-ban BS ranks below the harmless ban K10 and denying Red's support ranks above it; at
/// P = 0.1·L the judge measured the self-ban as the TOP action (+0.7) and denial inverted (−0.7) —
/// which is why a board-comparable P is not "the same shape with a smaller constant" (§ 5b). Oracle-
/// checked; `off_pool_cost` → 0 must fail the first assertion.
#[test]
fn self_break_does_not_pay_when_a_roster_champion_is_worth_having() {
    use engine_core::reference::oracle::evaluate;
    use engine_core::reference::state::Action;
    let u = band_universe(&[
        ("BT", Role::Top, 0.0),
        ("BJ", Role::Jungle, 0.0),
        ("BM", Role::Middle, 0.0),
        ("BA", Role::Adc, 0.0),
        ("BS", Role::Support, 0.0),
        ("RT", Role::Top, 0.0),
        ("RJ", Role::Jungle, 0.0),
        ("RM", Role::Middle, 0.0),
        ("RA", Role::Adc, 0.0),
        ("RS", Role::Support, 0.0),
        ("SX", Role::Support, 1.0),
    ]);
    let idx = |id: &str| u.index(id).unwrap_or_else(|| panic!("{id}"));
    let set = |ids: &[&str]| -> ChampionSet { ids.iter().map(|id| idx(id)).collect() };
    assert_eq!(
        (u.loss(), u.off_pool_cost(), u.live_loss()),
        (3.0, 3.0, 33.0)
    );
    let pools = Pools {
        blue: set(&["BT", "BJ", "BM", "BA", "BS"]),
        red: set(&["RT", "RJ", "RM", "RA", "RS"]),
    };
    let format = engine_core::reference::format::Format::standard();
    // Slots 0–14: six bans, B pick, R pair, B pair, R pick, R ban, B ban, R ban — Blue's ban at 15 next.
    let entries: Vec<Entry> = [
        ("K1", true),
        ("K2", true),
        ("K3", true),
        ("K4", true),
        ("K5", true),
        ("K6", true),
        ("BT", false),
        ("RT", false),
        ("RJ", false),
        ("BJ", false),
        ("BM", false),
        ("RM", false),
        ("K7", true),
        ("K8", true),
        ("K9", true),
    ]
    .iter()
    .map(|(id, ban)| {
        if *ban {
            Entry::Ban(idx(id))
        } else {
            Entry::Pick(idx(id))
        }
    })
    .collect();
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (position.mover(), position.slot_index()),
        (Some(Side::Blue), 15)
    );
    assert_eq!(position.available(&u).len(), 6, "BA BS RA RS SX K10");
    let input = OracleInput {
        position: &position,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: FeasibilityRule::PoolOrRoster,
        mode: Mode::Horizon(3),
        epsilon: 1e-9,
        off_pool_cost: None,
    };
    let oracle = evaluate(&input).unwrap_or_else(|e| panic!("{e}"));
    let engine = search(&input, &params(None), &CancelHandle::new(), |_| {})
        .unwrap_or_else(|e| panic!("{e}"));
    let oracle_ranked: Vec<(Action, u64)> = oracle
        .ranked
        .iter()
        .map(|r| (r.action, r.value.to_bits()))
        .collect();
    assert_eq!(bits(&engine), oracle_ranked);
    let value_of = |id: &str| -> f64 {
        engine
            .ranked
            .iter()
            .find(|r| r.action == Action::Ban(idx(id)))
            .map(|r| r.value)
            .unwrap_or_else(|| panic!("{id} not ranked"))
    };
    for r in &engine.ranked {
        println!(
            "self-break probe: ban {:>3} {:+.1}  line {:?}",
            r.action
                .champions()
                .map(|c| u.id(c))
                .collect::<Vec<_>>()
                .join("+"),
            r.value,
            r.continuation
                .iter()
                .map(|a| a.champions().map(|c| u.id(c)).collect::<Vec<_>>().join("+"))
                .collect::<Vec<_>>()
        );
    }
    // Self-break to reach SX: Blue's pair becomes (BA, SX), one off-pool pick for a board of +1 → −P + 1.
    assert!(
        value_of("BS") < value_of("K10"),
        "banning one's own support to unlock SX must rank below a harmless ban"
    );
    assert_eq!(value_of("BS"), 1.0 - u.off_pool_cost());
    assert_eq!(
        value_of("K10"),
        0.0,
        "the harmless ban: everyone picks in pool"
    );
    // Denial: Red loses its support and retaliates on Blue's; both sides fetch one roster champion
    // and Blue gets SX — the off-pool picks cancel and the board's +1 remains (the engine's line,
    // oracle-checked; a hand derivation had Red fetching SX itself, which Red never does).
    assert!(value_of("RS") > value_of("K10"));
    assert_eq!(value_of("RS"), 1.0);
}

/// Review round 5 (judgement, verified by running it): under the live rule a board where a side's
/// LOCKED picks cannot fill five roles — the sample's slot 7 with Red pairing Aphelios and Ashe, a
/// real play that champion-meta lists as BOTTOM-only — used to REFUSE at every later root for both
/// sides (`RootInfeasible`: pool ∨ roster, and no roster fixes the locked pair). The draft must go
/// on (U10: "has to pick something"), so under `pool_or_roster` the root is ranked with that side
/// priced at L' on every leaf: Blue's pair at slot 9 ranks in exactly the order the bare board gives
/// (`off`), every line Red-infeasible, and the gate still refuses. The roster is cut to twenty as
/// in 8e (190 pairs).
#[test]
fn a_board_whose_locked_picks_cannot_fill_five_roles_is_ranked_not_refused() {
    let live = live_universe();
    let u = &live.universe;
    let s = sample();
    let mut state = state_at(&s, 7);
    state.red_picks.push("Aphelios".into());
    state.red_picks.push("Ashe".into());
    let mut on_board: Vec<String> = s
        .events
        .iter()
        .take(7)
        .map(|e| e.champion.clone())
        .collect();
    on_board.extend(["Aphelios".to_string(), "Ashe".to_string()]);
    let exclusions = cut_roster(&s, &on_board, &[]);
    let root = LiveRoot::from_draft_state(&state, &s.pools.blue, &s.pools.red, &exclusions, u)
        .unwrap_or_else(|e| panic!("{e}"));
    let position = root.position(u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (position.mover(), position.slot_index()),
        (Some(Side::Blue), 9)
    );
    assert_eq!(position.available(u).len(), 20);
    // The gate refuses: Red cannot finish from its pool.
    let refused = search(
        &OracleInput {
            position: &position,
            universe: u,
            pools: &root.pools,
            objective: u,
            feasibility: FeasibilityRule::On,
            mode: Mode::Horizon(1),
            epsilon: 1e-9,
            off_pool_cost: None,
        },
        &params(None),
        &CancelHandle::new(),
        |_| {},
    );
    assert!(matches!(
        refused,
        Err(engine_core::engine::EngineError::InvalidInput { .. })
    ));
    let live_rule = run(
        &root,
        u,
        Mode::Horizon(1),
        &params(None),
        FeasibilityRule::PoolOrRoster,
    );
    let bare = run(
        &root,
        u,
        Mode::Horizon(1),
        &params(None),
        FeasibilityRule::Off,
    );
    assert_eq!(live_rule.ranked.len(), 190);
    assert_eq!(live_rule.top_set, bare.top_set);
    let bare_value = |action| {
        bare.ranked
            .iter()
            .find(|r| r.action == action)
            .map(|r| r.value)
            .unwrap_or_else(|| panic!("{action:?}"))
    };
    // Lines that keep Blue's comp intact: Red broken alone, the bare board plus L' (within rounding),
    // in the board's order up to rounding — adding L' ≈ 11 290 to boards of size ≈ 1 rounds away
    // differences below an ulp of L' (≈ 2e-12), so near-tied pairs may swap, never more.
    let intact: Vec<_> = live_rule
        .ranked
        .iter()
        .filter(|r| r.ends.blue_feasible)
        .collect();
    assert!(intact.len() > 150, "{}", intact.len());
    for w in intact.windows(2) {
        assert!(
            bare_value(w[0].action) >= bare_value(w[1].action) - 1e-9,
            "{:?} above {:?}",
            w[0].action,
            w[1].action
        );
    }
    for l in &intact {
        assert!(!l.ends.red_feasible);
        assert_eq!((l.ends.blue_off_pool, l.ends.red_off_pool), (0, 0));
        let b = bare_value(l.action);
        assert!(
            (l.value - b - u.live_loss()).abs() <= 1e-9 * u.live_loss(),
            "{:?}: live {} bare {}",
            l.action,
            l.value,
            b
        );
    }
    // Pairs that break Blue's own comp too (two of a role Tristana or Veigar already fills): both
    // sides broken, R1's board exactly — L' below every intact line, so the live rule ranks them
    // last where the bare board interspersed them. Blue must keep its comp to collect Red's break.
    let first_broken = live_rule
        .ranked
        .iter()
        .position(|r| !r.ends.blue_feasible)
        .unwrap_or_else(|| panic!("some pair breaks Blue"));
    for r in &live_rule.ranked[first_broken..] {
        assert!(
            !r.ends.blue_feasible && !r.ends.red_feasible,
            "{:?}",
            r.action
        );
        assert_eq!(r.value.to_bits(), bare_value(r.action).to_bits());
    }
}

/// Review round 5 (judgement): the Tier A harness's band check reads L/2, so a Tier A fixture that
/// declared the live rule would misfire silently; the loader refuses the rule instead (the live rule
/// is Tier B's and the wire's). Every shipped Tier A fixture declares `on` or `off`.
#[test]
fn the_tier_a_loader_refuses_the_live_rule() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/tier-a/01-pair-completion.json");
    let raw = std::fs::read_to_string(&path).expect("fixture 01");
    assert_eq!(raw.matches("\"feasibility\": \"on\"").count(), 1);
    let live_rule = raw.replace(
        "\"feasibility\": \"on\"",
        "\"feasibility\": \"pool_or_roster\"",
    );
    match Fixture::from_json(&live_rule, "01-live") {
        Err(FixtureError::Invalid { field, reason, .. }) => {
            assert_eq!(field, "feasibility");
            assert!(reason.contains("Tier B"), "{reason}");
        }
        other => panic!("expected the loader to refuse: {other:?}"),
    }
    assert!(Fixture::from_json(&raw, "01").is_ok());
}
