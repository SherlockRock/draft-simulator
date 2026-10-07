//! Graded off-role cost (design docs/designs/engine-role-grade-design.md): the shares and the grades
//! here, the weighted solver, the leaf and the key as the slice lands them. Band universes; the
//! live-universe readings (the Q = 0 identity, the report, the acceptance probe) are in
//! tests/tier_b.rs and tests/live.rs.

mod common;

use common::{aligned_shares, load_production_data, repo_root};
use engine_core::cancellation::CancelHandle;
use engine_core::engine::EngineError;
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::feasibility::{FeasibilityMemo, FeasibilityRule, Price};
use engine_core::reference::format::Format;
use engine_core::reference::live::LiveUniverse;
use engine_core::reference::objective::{net_live, Leaf, Objective};
use engine_core::reference::oracle::{evaluate, Mode, OracleError, OracleInput};
use engine_core::reference::search::{search, SearchOutcome, SearchParams};
use engine_core::reference::state::{Pools, Position};
use engine_core::reference::universe::{Champion, Universe, UniverseError, UniverseSpec};
use serde::Deserialize;
use std::collections::HashMap;

const ROLE_ORDER: [Role; 5] = [
    Role::Top,
    Role::Jungle,
    Role::Middle,
    Role::Adc,
    Role::Support,
];

fn live() -> LiveUniverse {
    let root = repo_root();
    let fm = FmWeights::from_json_str(
        &std::fs::read_to_string(root.join("data/compiled/fm-weights.json"))
            .expect("fm-weights.json"),
    )
    .expect("fm-weights parses");
    #[derive(Deserialize)]
    struct MetaVersion {
        version: String,
    }
    let version: MetaVersion = serde_json::from_str(
        &std::fs::read_to_string(root.join("data/compiled/champion-meta.json"))
            .expect("champion-meta.json"),
    )
    .expect("champion-meta version");
    let (_, meta) = load_production_data();
    LiveUniverse::build(&fm, &version.version, &meta).unwrap_or_else(|e| panic!("{e}"))
}

/// One champion `C` with `positions` (a JSON list body) and an optional `, "shares": [...]` tail.
fn one(positions: &str, shares: &str) -> Result<Universe, UniverseError> {
    let spec: UniverseSpec = serde_json::from_str(&format!(
        r#"{{"champions": [{{"id": "C", "positions": [{positions}], "linear": 0{shares}}}]}}"#
    ))
    .unwrap_or_else(|e| panic!("{e}"));
    Universe::new(spec)
}

fn grades(u: &Universe) -> Vec<u8> {
    let c = u.index("C").expect("C");
    ROLE_ORDER.iter().map(|r| u.grade(c, *r)).collect()
}

/// Design § 7 test 5: `from_tables` grades each listed role by its shortfall against the primary
/// (`[0.6, 0.3, 0.12]` → 0 / 50 / 80), a role never played 100, every role 0 when the shares are empty;
/// `f64::round` is the convention (half away from zero: `[0.8, 0.1]` → 87.5 → 88); ties are allowed.
#[test]
fn grades_follow_the_shortfall_against_the_primary() {
    let u = one(
        r#""Top", "Middle", "Adc""#,
        r#", "shares": [0.6, 0.3, 0.12]"#,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    let g = grades(&u);
    println!("[Top, Jungle, Middle, Adc, Support] grades {g:?}");
    assert_eq!(g, vec![0, 100, 50, 80, 100]);

    let u = one(r#""Top", "Middle""#, "").unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(grades(&u), vec![0; 5], "unknown shares grade nothing");
    let u = one(r#""Top", "Middle""#, r#", "shares": []"#).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(grades(&u), vec![0; 5], "an explicit empty list is the same");

    let u = one(r#""Jungle", "Support""#, r#", "shares": [0.8, 0.1]"#)
        .unwrap_or_else(|e| panic!("{e}"));
    let g = grades(&u);
    println!("the exact-.5 pair [0.8, 0.1]: {g:?}");
    assert_eq!(g[4], 88, "87.5 rounds half away from zero");

    let u =
        one(r#""Middle", "Top""#, r#", "shares": [0.5, 0.5]"#).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        grades(&u),
        vec![0, 100, 0, 100, 100],
        "a tie with the primary grades 0"
    );
}

/// Design § 7 test 5: a share list of the wrong length, a non-maximal first share, a zero, a share
/// above 1 and a non-finite one are each `UniverseError::Shares` naming the champion.
#[test]
fn malformed_shares_are_refused_by_name() {
    for shares in [
        r#", "shares": [0.6]"#,
        r#", "shares": [0.6, 0.3, 0.1]"#,
        r#", "shares": [0.3, 0.6]"#,
        r#", "shares": [0.6, 0.0]"#,
        r#", "shares": [0.6, -0.1]"#,
        r#", "shares": [1.5, 0.6]"#,
    ] {
        let got = one(r#""Top", "Middle""#, shares);
        assert!(
            matches!(&got, Err(UniverseError::Shares(id)) if id == "C"),
            "{shares}: {got:?}"
        );
    }
    let nan = vec![Champion {
        id: "C".into(),
        positions: vec![Role::Top, Role::Middle],
        linear: 0.0,
        shares: vec![0.6, f64::NAN],
    }];
    let zero = vec![vec![0.0; 1]; 1];
    assert_eq!(
        Universe::from_tables(nan, &zero, &zero).err(),
        Some(UniverseError::Shares("C".into()))
    );
}

/// Design § 7 test 10: the shipped `positionShares` load into a vector aligned with `positions` in
/// both loaders' order of keys, absent is empty, a mismatched key set is named, and the live universe
/// carries fact 6's Zyra: shares 0.448 / 0.380 / 0.130 → grades 0 / 15 / 71.
#[test]
fn the_shipped_shares_load_aligned_with_positions_and_reach_the_live_universe() {
    let (_, meta) = load_production_data();
    for m in meta.values() {
        assert_eq!(m.position_shares.len(), m.positions.len(), "{}", m.id);
    }
    let zyra = &meta["Zyra"];
    println!("Zyra {:?} {:?}", zyra.positions, zyra.position_shares);
    assert_eq!(zyra.positions, vec![Role::Jungle, Role::Support, Role::Adc]);
    assert_eq!(zyra.position_shares, vec![0.448, 0.38, 0.13]);
    assert_eq!(zyra.share_of(Role::Adc), Some(0.13));
    assert_eq!(zyra.share_of(Role::Top), None);

    let positions: Vec<String> = ["JUNGLE", "SUPPORT", "BOTTOM"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let map = |pairs: &[(&str, f64)]| -> HashMap<String, f64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    };
    assert_eq!(
        aligned_shares(
            "Zyra",
            &positions,
            &map(&[("BOTTOM", 0.13), ("JUNGLE", 0.448), ("SUPPORT", 0.38)])
        ),
        Ok(vec![0.448, 0.38, 0.13]),
        "aligned by positions, whatever order the map's keys come in"
    );
    assert_eq!(
        aligned_shares("Zyra", &positions, &map(&[])),
        Ok(Vec::new())
    );
    let extra = aligned_shares(
        "Zyra",
        &positions,
        &map(&[
            ("BOTTOM", 0.13),
            ("JUNGLE", 0.448),
            ("SUPPORT", 0.38),
            ("TOP", 0.1),
        ]),
    );
    assert_eq!(
        extra,
        Err("Zyra: positionShares names TOP, which positions does not list".into())
    );
    let missing = aligned_shares("Zyra", &positions, &map(&[("JUNGLE", 0.448)]));
    assert_eq!(
        missing,
        Err("Zyra: positionShares lacks the listed role SUPPORT".into())
    );

    let live = live();
    let u = &live.universe;
    let z = u.index("Zyra").expect("Zyra");
    let g = (
        u.grade(z, Role::Jungle),
        u.grade(z, Role::Support),
        u.grade(z, Role::Adc),
        u.grade(z, Role::Top),
    );
    println!("Zyra grades jungle / support / adc / top: {g:?}");
    assert_eq!(g, (0, 15, 71, 100));
}

/// Two single-role champions per role, no tables: ten champions, so the oracle's bound holds.
fn band() -> Universe {
    let ids = ["T1", "T2", "J1", "J2", "M1", "M2", "A1", "A2", "S1", "S2"];
    let roles = [
        "Top", "Top", "Jungle", "Jungle", "Middle", "Middle", "Adc", "Adc", "Support", "Support",
    ];
    let list: Vec<String> = ids
        .iter()
        .zip(roles)
        .map(|(id, role)| format!(r#"{{"id": "{id}", "positions": ["{role}"], "linear": 0}}"#))
        .collect();
    let spec: UniverseSpec =
        serde_json::from_str(&format!(r#"{{"champions": [{}]}}"#, list.join(",")))
            .unwrap_or_else(|e| panic!("{e}"));
    Universe::new(spec).unwrap_or_else(|e| panic!("{e:?}"))
}

/// Design § 4 and § 7 test 6 (the validation half): under `roster` Q is required, finite,
/// non-negative and capped so that P + Q ≤ L — P + Q = L is accepted, P + Q > L refused with a message
/// naming both; under every other rule a value is refused. The oracle and the search say the same.
#[test]
fn off_role_cost_is_required_under_roster_capped_with_p_at_l_and_refused_elsewhere() {
    let u = band();
    let format = Format::standard();
    let pools = Pools {
        blue: u.all(),
        red: u.all(),
        ..Pools::default()
    };
    let position = Position::new(&format, &[], &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let l = u.loss();
    let input = |rule: FeasibilityRule, p: Option<f64>, q: Option<f64>| OracleInput {
        position: &position,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: rule,
        mode: Mode::Horizon(1),
        epsilon: 1e-9,
        off_pool_cost: p,
        off_role_cost: q,
    };
    let both = |rule: FeasibilityRule,
                p: Option<f64>,
                q: Option<f64>|
     -> (Option<String>, Option<String>) {
        let oracle = evaluate(&input(rule, p, q)).err().map(|e| e.to_string());
        let searched = search(
            &input(rule, p, q),
            &SearchParams::default(),
            &CancelHandle::new(),
            |_| {},
        )
        .err()
        .map(|e| match e {
            EngineError::InvalidInput { path } => path.join("/"),
            other => panic!("{other:?}"),
        });
        (oracle, searched)
    };
    let refused = |rule: FeasibilityRule, p: Option<f64>, q: Option<f64>, word: &str| {
        let (oracle, searched) = both(rule, p, q);
        println!("{rule:?} P {p:?} Q {q:?}: oracle {oracle:?} search {searched:?}");
        for text in [oracle, searched] {
            let text = text.unwrap_or_else(|| panic!("{rule:?} P {p:?} Q {q:?} must be refused"));
            assert!(
                text.starts_with("off_role_cost: ") && text.contains(word),
                "{rule:?} P {p:?} Q {q:?}: {text}"
            );
        }
    };
    use FeasibilityRule::{Off, On, PoolOrRoster, Roster};
    refused(Roster, Some(0.1), None, "required");
    refused(Roster, Some(0.1), Some(f64::NAN), "not finite");
    refused(Roster, Some(0.1), Some(f64::INFINITY), "not finite");
    refused(Roster, Some(0.1), Some(-0.01), "negative");
    refused(Roster, Some(0.1), Some(l), "exceeds L");
    let (oracle, _) = both(Roster, Some(0.1), Some(l));
    let text = oracle.expect("refused");
    assert!(
        text.contains("P + Q = 0.1 + ") && text.contains(&format!("exceeds L = {l}")),
        "{text}"
    );
    for rule in [PoolOrRoster, On, Off] {
        refused(
            rule,
            None,
            Some(0.05),
            &format!("not read under {}", rule.wire_name()),
        );
    }
    // Accepted: P + Q = L exactly, from either end.
    assert_eq!(
        both(Roster, Some(0.0), Some(l)),
        (None, None),
        "P = 0, Q = L"
    );
    assert_eq!(
        both(Roster, Some(l), Some(0.0)),
        (None, None),
        "P = L, Q = 0"
    );
    assert_eq!(both(Roster, Some(0.1), Some(0.05)), (None, None));
    // The typed error is `OffRoleCost`, beside `OffPoolCost`.
    assert!(matches!(
        evaluate(&input(Roster, Some(0.1), None)),
        Err(OracleError::OffRoleCost { .. })
    ));
}

/// Design § 2: the memo carries the price it was built at (`Price::of` turns Q into a per-grade-unit
/// price); `Default` is gone, so no reader can build an unpriced memo by accident.
#[test]
fn the_memo_carries_its_price() {
    let memo = FeasibilityMemo::new(Price::of(0.1, 0.05));
    assert_eq!(
        memo.price(),
        Price {
            p: 0.1,
            q_unit: 0.0005
        }
    );
    assert_eq!(
        FeasibilityMemo::new(Price::ZERO).price(),
        Price {
            p: 0.0,
            q_unit: 0.0
        }
    );
}

// ---------------------------------------------------------------- the solver, the charge, the key

use engine_core::draft_state::{ActionType, Side};
use engine_core::reference::feasibility::{
    action_charge, critical_pool, off_pool, placements, Charge, OffPool, Placement,
};
use engine_core::reference::search::static_order;
use engine_core::reference::state::{Action, Entry, RoleSets};
use engine_core::reference::universe::ChampionIdx;

/// A universe from `(id, positions, shares, linear)` rows, no tables; shares empty = ungraded.
fn graded(rows: &[(&str, &[&str], &[f64], f64)]) -> Universe {
    let list: Vec<String> = rows
        .iter()
        .map(|(id, positions, shares, linear)| {
            let positions: Vec<String> = positions.iter().map(|p| format!("\"{p}\"")).collect();
            let shares: Vec<String> = shares.iter().map(|s| s.to_string()).collect();
            format!(
                r#"{{"id": "{id}", "positions": [{}], "linear": {linear}, "shares": [{}]}}"#,
                positions.join(","),
                shares.join(",")
            )
        })
        .collect();
    let spec: UniverseSpec =
        serde_json::from_str(&format!(r#"{{"champions": [{}]}}"#, list.join(",")))
            .unwrap_or_else(|e| panic!("{e}"));
    Universe::new(spec).unwrap_or_else(|e| panic!("{e:?}"))
}

fn idx(u: &Universe, id: &str) -> ChampionIdx {
    u.index(id).unwrap_or_else(|| panic!("no champion {id}"))
}

/// Tags from `(role, ids)` rows.
fn tags(u: &Universe, rows: &[(Role, &[&str])]) -> RoleSets {
    rows.iter().fold(RoleSets::default(), |tags, (role, ids)| {
        ids.iter()
            .fold(tags, |tags, id| tags.with(*role, idx(u, id)))
    })
}

/// The standard format's board with every ban a skip and each side's picks in the order given,
/// stopping at the first pick slot whose side has none left.
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

/// A position over `entries` validated against the whole roster on both sides: the board may hold
/// picks outside the tagged pool the readers are then given, exactly the state the search reaches once
/// a roster pick is on the board (a board pick the MAP omits at a root is a sunk fact; here the pick is
/// below the root). `Position` holds no pools of its own.
fn at<'f>(format: &'f Format, entries: &[Entry], u: &Universe) -> Position<'f> {
    let any = Pools {
        blue: u.all(),
        red: u.all(),
        ..Pools::default()
    };
    Position::new(format, entries, &any, u).unwrap_or_else(|e| panic!("{e}"))
}

/// Two single-role champions per role for Red's list pool and the roster.
const FILL: [(&str, &[&str], &[f64], f64); 10] = [
    ("T1", &["Top"], &[], 0.0),
    ("T2", &["Top"], &[], 0.0),
    ("J1", &["Jungle"], &[], 0.0),
    ("J2", &["Jungle"], &[], 0.0),
    ("M1", &["Middle"], &[], 0.0),
    ("M2", &["Middle"], &[], 0.0),
    ("A1", &["Adc"], &[], 0.0),
    ("A2", &["Adc"], &[], 0.0),
    ("S1", &["Support"], &[], 0.0),
    ("S2", &["Support"], &[], 0.0),
];

fn with_fill(extra: &[(&str, &[&str], &[f64], f64)]) -> Universe {
    let mut rows: Vec<(&str, &[&str], &[f64], f64)> = FILL.to_vec();
    rows.extend_from_slice(extra);
    graded(&rows)
}

/// Design fact 10, the v1.1 counter-example, now the split's definition: locked `a` (plays Top /
/// Jungle, listed Top, primary Jungle) and `b` (picked from the roster below the root — outside the
/// pool; plays Top / Middle, primary Top, grade 50 at Middle), the pool net Jungle / Adc / Support
/// specialists. At P = 1, Q = 3 the picks alone are cheapest as a-Jungle, b-Top = (2, 0) (price 2
/// against (1, 50)'s 2.5), but the total prefers a-Top, b-Middle = (1, 50) with every free role filled
/// in-pool (2.5 against 3). The split is the total's own argmin — `made 1, grade 50, forced 0`, never
/// `total.off − cheapest.off = −1`.
#[test]
fn the_split_is_the_least_totals_own_argmin() {
    let u = with_fill(&[
        ("a", &["Jungle", "Top"], &[0.6, 0.3], 0.0),
        ("b", &["Top", "Middle"], &[0.6, 0.3], 0.0),
    ]);
    let blue = tags(
        &u,
        &[
            (Role::Top, &["a"]),
            (Role::Jungle, &["J1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let format = Format::standard();
    let entries = board(&format, &u, &["a", "b"], &["T2", "J2"]);
    let position = at(&format, &entries, &u);
    assert_eq!(
        (position.slot_index(), position.mover()),
        (10, Some(Side::Blue))
    );
    let read = |price: Price| {
        off_pool(
            &mut FeasibilityMemo::new(price),
            FeasibilityRule::Roster,
            Side::Blue,
            &position,
            &pools,
            &u,
        )
    };
    let weighted = read(Price::of(1.0, 3.0));
    let unweighted = read(Price::of(1.0, 0.0));
    println!("fact 10 board: at (1, 3) {weighted:?}; at (1, 0) {unweighted:?}");
    assert_eq!(
        weighted,
        OffPool {
            made: 1,
            grade: 50,
            forced: 0
        }
    );
    // At Q = 0 the same arrangement is the cheapest alone too (fact 8: made = today's made).
    assert_eq!(unweighted, weighted);
}

/// Design § 7 test 7 (b) and (c): a child whose RAW weighted deltas are (−1, +80) — locked `A`
/// (listed Jungle, primary Top) and `B` (picked from the roster; Jungle, then Middle at grade 80) are
/// cheapest as A-Top, B-Jungle = (2, 0) at P = 0.1, Q = 0.2; the in-pool pick `Y` (listed Top) takes
/// Top, so the child is A-Jungle, B-Middle = (1, 80). The key charges the raw price rise
/// 0.16 − 0.1 = 0.06, never negative; the class is today's (`d_off` 0: in-pool, a pick that pushes a
/// locked pick to a graded role). At Q = 0 the node is already (1, 80) and the key charges nothing.
#[test]
fn a_raw_off_delta_can_be_negative_and_the_key_charges_the_price_rise() {
    let u = with_fill(&[
        ("A", &["Top", "Jungle"], &[0.6, 0.3], 0.0),
        ("B", &["Jungle", "Middle"], &[0.6, 0.12], 0.0),
        ("Y", &["Top"], &[1.0], 0.0),
    ]);
    let blue = tags(&u, &[(Role::Top, &["Y"]), (Role::Jungle, &["A"])]);
    let pools = Pools {
        red: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let format = Format::standard();
    let entries = board(&format, &u, &["A", "B"], &["T2", "J2"]);
    let position = at(&format, &entries, &u);
    let charge_at = |price: Price| -> Charge {
        action_charge(
            &mut FeasibilityMemo::new(price),
            FeasibilityRule::Roster,
            Side::Blue,
            &position,
            &pools,
            &u,
        )
        .of(Action::Pick(idx(&u, "Y")))
    };
    let weighted = charge_at(Price::of(0.1, 0.2));
    let unweighted = charge_at(Price::of(0.1, 0.0));
    println!(
        "Y at (0.1, 0.2): {weighted:?} key {}; at (0.1, 0): {unweighted:?} key {}",
        weighted.key_charge(),
        unweighted.key_charge()
    );
    assert_eq!(
        (weighted.d_off, weighted.d_off_key, weighted.d_grade),
        (0, -1, 80)
    );
    assert!(weighted.is_in_pool());
    assert_eq!(weighted.key_charge(), 80.0 * (0.2 / 100.0) - 0.1);
    assert_eq!(
        (unweighted.d_off, unweighted.d_off_key, unweighted.d_grade),
        (0, 0, 0)
    );
    assert_eq!(unweighted.key_charge(), 0.0);
}

/// Design § 7 test 7 (e), review round 3's witness: node (2, 0), child (2, 99), one outside champion.
/// Locked `L` (listed Support; Jungle primary, Top at 80), `X1` (listed Middle) and `X2` (from the
/// roster; Support, Top at 99) are cheapest at P = 0.09, Q = 0.1 as L-Jungle, X1-Middle, X2-Support =
/// (2, 0); the outside pick `Y` (Jungle only) sends L to its in-pool Support and X2 to Top: (2, 99). The
/// off delta is 0 and the key charges the grade alone, 0.099 — not the floored 0.09 + 0.099 — while
/// the class stays off-pool 1. And (d): a child that breaks the comp (two Jungle-only champions) is
/// charged P, today's fallback.
#[test]
fn a_matchable_child_is_charged_its_raw_rise_and_a_broken_one_the_floor() {
    let u = with_fill(&[
        ("L", &["Jungle", "Support", "Top"], &[0.6, 0.3, 0.12], 0.0),
        ("X1", &["Middle"], &[1.0], 0.0),
        ("X2", &["Support", "Top"], &[0.99, 0.01], 0.0),
        ("Y", &["Jungle"], &[1.0], 0.0),
    ]);
    let blue = tags(
        &u,
        &[
            (Role::Support, &["L"]),
            (Role::Middle, &["X1"]),
            (Role::Adc, &["A1"]),
        ],
    );
    let pools = Pools {
        red: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let format = Format::standard();
    let entries = board(&format, &u, &["L", "X1", "X2"], &["T2", "J2"]);
    let position = at(&format, &entries, &u);
    let price = Price::of(0.09, 0.1);
    let charge = action_charge(
        &mut FeasibilityMemo::new(price),
        FeasibilityRule::Roster,
        Side::Blue,
        &position,
        &pools,
        &u,
    );
    let y = charge.of(Action::Pick(idx(&u, "Y")));
    println!("Y: {y:?} key {}", y.key_charge());
    assert_eq!((y.d_off, y.d_off_key, y.d_grade), (1, 0, 99));
    assert!(!y.is_in_pool());
    assert_eq!(y.key_charge(), 99.0 * (0.1 / 100.0));

    // (d) the broken child: Blue holds `T1` and the roster's `Y` (Jungle only); picking `Y2` (Jungle
    // only) too leaves no arrangement — the fallback charges the champions outside the pool, one P.
    let u2 = with_fill(&[
        ("Y", &["Jungle"], &[1.0], 0.0),
        ("Y2", &["Jungle"], &[1.0], 0.0),
    ]);
    let blue = tags(&u2, &[(Role::Top, &["T1"])]);
    let pools = Pools {
        red: u2.all(),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u2, &["T1", "Y"], &["T2", "J2"]);
    let position = at(&format, &entries, &u2);
    let charge = action_charge(
        &mut FeasibilityMemo::new(Price::of(0.1, 0.05)),
        FeasibilityRule::Roster,
        Side::Blue,
        &position,
        &pools,
        &u2,
    );
    let broken = charge.of(Action::Pick(idx(&u2, "Y2")));
    println!("broken child: {broken:?} key {}", broken.key_charge());
    assert_eq!((broken.d_off, broken.d_off_key, broken.d_grade), (1, 1, 0));
    assert_eq!(broken.key_charge(), 0.1);
}

/// Design § 7 test 7 (a): Red's single pick at slot 11 with Middle and Adc locked; the roster's `X`
/// (Middle primary, Top at 99) lowers Blue's value by 0.02 and must take Top, `Z` (Top) is worth 0.
/// Both off-pool 1. At Q = 0 the key orders X first (−0.02 + 0.1 against 0.1); at Q = 0.05 the grade,
/// 0.0495, outweighs the board gap and Z comes first.
#[test]
fn the_key_orders_a_primary_placement_above_a_graded_one_once_q_exceeds_the_gap() {
    let u = with_fill(&[
        ("X", &["Middle", "Top"], &[0.99, 0.01], 0.02),
        ("Z", &["Top"], &[1.0], 0.0),
    ]);
    let red = tags(&u, &[(Role::Middle, &["M2"]), (Role::Adc, &["A2"])]);
    let pools = Pools {
        blue: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Red, red);
    let format = Format::standard();
    let entries = board(&format, &u, &["T1", "J1", "S1"], &["M2", "A2"]);
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        (position.slot_index(), position.mover()),
        (11, Some(Side::Red))
    );
    let (x, z) = (Action::Pick(idx(&u, "X")), Action::Pick(idx(&u, "Z")));
    let order = |q: f64| -> Vec<Action> {
        let mut memo = FeasibilityMemo::new(Price::of(0.1, q));
        let charge = action_charge(
            &mut memo,
            FeasibilityRule::Roster,
            Side::Red,
            &position,
            &pools,
            &u,
        );
        let (cx, cz) = (charge.of(x), charge.of(z));
        println!(
            "Q {q}: X {cx:?} key {}; Z {cz:?} key {}",
            cx.key_charge(),
            cz.key_charge()
        );
        assert_eq!((cx.d_off, cz.d_off), (1, 1));
        static_order(&u, &position, Side::Red, vec![x, z], Some(charge), None)
    };
    assert_eq!(order(0.0), vec![x, z]);
    assert_eq!(order(0.05), vec![z, x]);
}

/// Design § 7 test 12 (G9): under weights a pool champion is critical when its removal makes the least
/// total dearer. Blue's one pick is the roster's `X` (Middle primary, Top at 89), at Middle with the
/// pool net filling the rest, total (1, 0); without `T1` the total moves X to Top so the net fills the
/// rest — (1, 89), the same off units, a higher price. `T1` is critical at P = 0.105, Q = 0.1 and not at
/// `Price::ZERO`, where the set is today's (W-based: removing `T1` leaves W at 4 either way).
#[test]
fn a_champion_whose_removal_raises_the_price_is_critical_under_weights() {
    let u = with_fill(&[("X", &["Middle", "Top"], &[0.9, 0.1], 0.0)]);
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let format = Format::standard();
    let entries = board(&format, &u, &["X"], &[]);
    let position = at(&format, &entries, &u);
    let critical = |price: Price| {
        let set = critical_pool(
            &mut FeasibilityMemo::new(price),
            Side::Blue,
            &position,
            &pools,
            &u,
        );
        let mut names: Vec<&str> = set.iter().map(|c| u.id(c)).collect();
        names.sort_unstable();
        names
    };
    let (zero, weighted) = (critical(Price::ZERO), critical(Price::of(0.105, 0.1)));
    println!("critical at ZERO {zero:?}; at (0.105, 0.1) {weighted:?}");
    assert_eq!(zero, vec!["A1", "J1", "S1"]);
    assert_eq!(weighted, vec!["A1", "J1", "S1", "T1"]);
}

// ---------------------------------------------------------------- the leaf (G5)

/// Design § 7 test 6, the arithmetic: the two sides' counts are netted as integers, then one
/// operation per term — `(board + net_off · P) + net_grade · Q/100` — and a term is skipped when its
/// net OR its unit is zero: Q = 0 adds no `+0.0` (a `−0.0` board stays `−0.0`, bit for bit), equal
/// counts leave the board, P = 0 skips the P term. Through `net_live` and through
/// `Universe::value_under` on a real board.
#[test]
fn the_leaf_nets_integer_counts_and_skips_zero_terms() {
    let (p, q) = (0.1, 0.05);
    let b = 0.123_456_789;
    // One op per term, in order.
    assert_eq!(
        net_live(b, p, q, 1, 0, 50, 0).to_bits(),
        ((b + -p) + -(50.0 * (q / 100.0))).to_bits()
    );
    assert_eq!(
        net_live(b, p, q, 0, 2, 0, 130).to_bits(),
        ((b + 2.0 * p) + 130.0 * (q / 100.0)).to_bits()
    );
    // Q = 0: no second operation at all.
    assert_eq!(
        net_live(b, p, 0.0, 1, 0, 50, 0).to_bits(),
        (b + -p).to_bits()
    );
    // Nets of zero leave the board, bits included — a `−0.0` board in particular.
    assert_eq!(
        net_live(-0.0, p, q, 2, 2, 70, 70).to_bits(),
        (-0.0f64).to_bits()
    );
    assert_eq!(
        net_live(-0.0, p, 0.0, 0, 0, 0, 50).to_bits(),
        (-0.0f64).to_bits(),
        "Q = 0 skips the grade term"
    );
    assert_eq!(
        net_live(-0.0, 0.0, q, 0, 3, 0, 0).to_bits(),
        (-0.0f64).to_bits(),
        "P = 0 skips the off term"
    );
    // P = 0 with a grade net: the grade term alone.
    assert_eq!(
        net_live(b, 0.0, q, 2, 0, 0, 30).to_bits(),
        (b + 30.0 * (q / 100.0)).to_bits()
    );

    // The universe: a real board, both rules; under pool_or_roster the caller's Q is 0.
    let u = with_fill(&[]);
    let (t1, j1, t2) = (idx(&u, "T1"), idx(&u, "J1"), idx(&u, "T2"));
    let leaf = Leaf {
        blue: &[t1, j1],
        red: &[t2],
        blue_feasible: true,
        red_feasible: true,
    };
    let board = u.board_value(&[t1, j1], &[t2]);
    assert_eq!(
        u.value_under(&leaf, FeasibilityRule::Roster, p, q, 1, 0, 89, 0)
            .to_bits(),
        ((board + -p) + -(89.0 * (q / 100.0))).to_bits()
    );
    assert_eq!(
        u.value_under(&leaf, FeasibilityRule::Roster, p, q, 1, 1, 0, 89)
            .to_bits(),
        (board + 89.0 * (q / 100.0)).to_bits()
    );
    assert_eq!(
        u.value_under(
            &leaf,
            FeasibilityRule::PoolOrRoster,
            u.off_pool_cost(),
            0.0,
            0,
            1,
            0,
            89
        )
        .to_bits(),
        (board + u.off_pool_cost()).to_bits(),
        "pool_or_roster at Q = 0: the grade count is carried and prices nothing"
    );
}

/// Design § 7 test 6 end to end: Red's last pick (slot 19) with Middle locked; the roster's `X`
/// (Middle primary, Support at 89) must take Support, `S2` (Support) is a roster support, `Z` is in
/// pool. Every board is 0, so the search's values are the charges alone: Z 0, S2 P, X P + 89 · Q/100
/// exactly, in that order for Red; at Q = 0 X and S2 tie at P. The oracle says the same, and the
/// leaf's ending carries the grade.
#[test]
fn a_graded_last_pick_is_priced_p_plus_its_grade_at_the_leaf() {
    let u = with_fill(&[
        ("X", &["Middle", "Support"], &[0.9, 0.1], 0.0),
        ("Z", &["Support"], &[1.0], 0.0),
    ]);
    let red = tags(
        &u,
        &[
            (Role::Top, &["T2"]),
            (Role::Jungle, &["J2"]),
            (Role::Middle, &["M2"]),
            (Role::Adc, &["A2"]),
            (Role::Support, &["Z"]),
        ],
    );
    let pools = Pools {
        blue: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Red, red);
    let format = Format::standard();
    let entries = board(
        &format,
        &u,
        &["T1", "J1", "M1", "A1", "S1"],
        &["T2", "J2", "M2", "A2"],
    );
    let position = at(&format, &entries, &u);
    assert_eq!(
        (position.slot_index(), position.mover()),
        (19, Some(Side::Red))
    );
    let (p, q) = (0.1, 0.05);
    let input = |q: f64| OracleInput {
        position: &position,
        universe: &u,
        pools: &pools,
        objective: &u,
        feasibility: FeasibilityRule::Roster,
        mode: Mode::Horizon(1),
        epsilon: 1e-9,
        off_pool_cost: Some(p),
        off_role_cost: Some(q),
    };
    let run = |q: f64| -> SearchOutcome {
        search(
            &input(q),
            &SearchParams::default(),
            &CancelHandle::new(),
            |_| {},
        )
        .unwrap_or_else(|e| panic!("{e}"))
    };
    let value = |o: &SearchOutcome, id: &str| {
        o.ranked
            .iter()
            .find(|r| r.action == Action::Pick(idx(&u, id)))
            .unwrap_or_else(|| panic!("{id} is not ranked"))
            .clone()
    };
    let o = run(q);
    let (x, s2, z) = (value(&o, "X"), value(&o, "S2"), value(&o, "Z"));
    println!(
        "Q {q}: Z {} S2 {} X {} (X ends {:?})",
        z.value, s2.value, x.value, x.ends
    );
    assert_eq!(z.value.to_bits(), 0.0f64.to_bits());
    assert_eq!(s2.value.to_bits(), (0.0 + 1.0 * p).to_bits());
    assert_eq!(
        x.value.to_bits(),
        ((0.0 + 1.0 * p) + 89.0 * (q / 100.0)).to_bits()
    );
    assert_eq!(
        (x.ends.red_off_pool, x.ends.red_grade, x.ends.blue_grade),
        (1, 89, 0)
    );
    assert_eq!((s2.ends.red_off_pool, s2.ends.red_grade), (1, 0));
    let names: Vec<&str> = o
        .ranked
        .iter()
        .map(|r| {
            u.id(match r.action {
                Action::Pick(c) => c,
                other => panic!("{other:?}"),
            })
        })
        .collect();
    assert_eq!(&names[..3], &["Z", "S2", "X"]);
    let o0 = run(0.0);
    assert_eq!(
        value(&o0, "X").value.to_bits(),
        (0.0 + 1.0 * p).to_bits(),
        "Q = 0: the grade prices nothing"
    );
    // The oracle, same values.
    let oracle = evaluate(&input(q)).unwrap_or_else(|e| panic!("{e}"));
    for r in &o.ranked {
        let theirs = oracle
            .ranked
            .iter()
            .find(|a| a.action == r.action)
            .expect("ranked alike");
        assert_eq!(theirs.value.to_bits(), r.value.to_bits(), "{:?}", r.action);
    }
}

// ---------------------------------------------------------------- the trace (§ 6)

/// Design § 6: `placements` reruns the child's weighted table with argmin pointers and reports where
/// the cheapest arrangement puts the action's champions — the arrangement the key priced. On the slot-11
/// board of the ordering test `X` lands at Top at grade 99 (off-pool), `Z` at Top at 0; on a Blue
/// pair `X'` (Middle, Jungle at 89) with `Z'` (Middle only) lands at Jungle at 89 and `Z'` at Middle;
/// an in-pool pick is traced in its listed role at grade 0; a list-form side and a ban trace nothing;
/// a child that cannot be arranged traces nothing.
#[test]
fn the_trace_reports_the_roles_the_key_priced() {
    let u = with_fill(&[
        ("X", &["Middle", "Top"], &[0.99, 0.01], 0.02),
        ("Z", &["Top"], &[1.0], 0.0),
        ("X2", &["Middle", "Jungle"], &[0.9, 0.1], 0.0),
        ("Z2", &["Middle"], &[1.0], 0.0),
    ]);
    let red = tags(&u, &[(Role::Middle, &["M2"]), (Role::Adc, &["A2"])]);
    let pools = Pools {
        blue: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Red, red);
    let format = Format::standard();
    let entries = board(&format, &u, &["T1", "J1", "S1"], &["M2", "A2"]);
    let position = at(&format, &entries, &u);
    let trace = |pools: &Pools, side: Side, position: &Position<'_>, action: Action| {
        placements(
            &mut FeasibilityMemo::new(Price::of(0.1, 0.05)),
            side,
            position,
            pools,
            &u,
            action,
        )
    };
    let (x, z) = (idx(&u, "X"), idx(&u, "Z"));
    let tx = trace(&pools, Side::Red, &position, Action::Pick(x));
    let tz = trace(&pools, Side::Red, &position, Action::Pick(z));
    println!("X {tx:?}; Z {tz:?}");
    assert_eq!(
        tx,
        vec![Placement {
            champion: x,
            role: Role::Top,
            grade: 99,
            in_pool: false
        }]
    );
    assert_eq!(
        tz,
        vec![Placement {
            champion: z,
            role: Role::Top,
            grade: 0,
            in_pool: false
        }]
    );
    // An in-pool pick: its listed role, grade 0, in-pool.
    let m2 = idx(&u, "M2");
    let red_in = tags(&u, &[(Role::Middle, &["M2"]), (Role::Adc, &["A2"])]);
    let pools_in = Pools {
        blue: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Red, red_in);
    let early = at(
        &format,
        &board(&format, &u, &["T1", "J1", "S1"], &["A2", "T2"]),
        &u,
    );
    let tm = trace(&pools_in, Side::Red, &early, Action::Pick(m2));
    println!("M2 {tm:?}");
    assert_eq!(
        tm,
        vec![Placement {
            champion: m2,
            role: Role::Middle,
            grade: 0,
            in_pool: true
        }]
    );
    // A list-form side traces nothing; so does a ban.
    let list = Pools {
        blue: u.all(),
        red: u.all(),
        ..Pools::default()
    };
    assert!(trace(&list, Side::Red, &position, Action::Pick(x)).is_empty());
    let ban_root = at(&format, &[], &u);
    assert!(trace(&pools, Side::Blue, &ban_root, Action::Ban(x)).is_empty());

    // A Blue pair at slot 9: both champions placed, in the action's order.
    let blue = tags(&u, &[(Role::Top, &["T1"]), (Role::Support, &["S1"])]);
    let pools_b = Pools {
        red: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let pair_root = at(&format, &board(&format, &u, &["T1"], &["T2", "J2"]), &u);
    assert!(pair_root.next_slot().is_some_and(|s| s.pair_start));
    let (x2, z2) = (idx(&u, "X2"), idx(&u, "Z2"));
    let tp = trace(&pools_b, Side::Blue, &pair_root, Action::pair(x2, z2));
    println!("pair {tp:?}");
    assert_eq!(
        tp,
        vec![
            Placement {
                champion: x2,
                role: Role::Jungle,
                grade: 89,
                in_pool: false
            },
            Placement {
                champion: z2,
                role: Role::Middle,
                grade: 0,
                in_pool: false
            },
        ]
    );
    // A child that cannot be arranged: two Middle-only champions.
    let m1 = idx(&u, "M1");
    assert!(trace(&pools_b, Side::Blue, &pair_root, Action::pair(z2, m1)).is_empty());
}
