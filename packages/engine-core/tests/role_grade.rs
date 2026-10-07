//! Graded off-role cost (design docs/designs/engine-role-grade-design.md): the shares and the grades
//! here, the weighted solver, the leaf and the key as the slice lands them. Band universes; the
//! live-universe readings (the Q = 0 identity, the report, the acceptance probe) are in
//! tests/tier_b.rs and tests/live.rs.

mod common;

use common::{aligned_shares, load_production_data, repo_root};
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::live::LiveUniverse;
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
