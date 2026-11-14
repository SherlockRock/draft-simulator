//! The 2 % own-games floor's exposure in the engine (engine slice B, design F2 / F10, T31): what the
//! floored `playable` field does to the incumbent's prune and to the reference universe, pinned on a
//! frozen copy of the floored table (`tests/data/champion-meta-2026-11-12-floor.json`, a byte copy of
//! the committed `data/compiled/champion-meta.json`), and the shape of the live file.

mod common;

use common::{load_production_data_from, repo_root};
use engine_core::draft_state::{ActionType, Side};
use engine_core::feasibility::can_complete_roles;
use engine_core::fm::FmWeights;
use engine_core::pools::Role;
use engine_core::reference::feasibility::{side_feasible, FeasibilityMemo, FeasibilityRule, Price};
use engine_core::reference::format::Format;
use engine_core::reference::live::LiveUniverse;
use engine_core::reference::state::{Entry, Pools, Position, RoleSets};
use engine_core::reference::universe::Universe;
use serde::Deserialize;
use std::path::{Path, PathBuf};

fn frozen_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/champion-meta-2026-11-12-floor.json")
}

fn live_from(meta_path: &Path) -> LiveUniverse {
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
        &std::fs::read_to_string(meta_path)
            .unwrap_or_else(|e| panic!("{}: {e}", meta_path.display())),
    )
    .expect("champion-meta version");
    let (_, meta) = load_production_data_from(meta_path);
    LiveUniverse::build(&fm, &version.version, &meta).unwrap_or_else(|e| panic!("{e}"))
}

/// T31: the floor removes Lee Sin's off-roles from the incumbent's mask (`champion_role_mask` reads
/// `playable_roles()`), so Jinx + Kai'Sa with a specialist pool can no longer complete: Kai'Sa's top
/// (1.9 % of her games) is under the floor. Galio support, Locke adc and Locke top stay.
#[test]
fn the_floor_narrows_the_incumbents_mask_and_leaves_the_rest() {
    let (_, meta) = load_production_data_from(&frozen_path());
    assert_eq!(meta["LeeSin"].playable_roles(), &[Role::Jungle]);

    let locked: Vec<String> = vec!["Jinx".into(), "Kaisa".into()];
    let pool: Vec<String> = vec!["LeeSin".into(), "Ahri".into(), "Sona".into()];
    assert_eq!(meta["Kaisa"].playable_roles(), &[Role::Adc]);
    assert!(
        !can_complete_roles(&locked, &pool, 3, &meta),
        "two bottom-only picks cannot complete five roles"
    );

    assert!(meta["Galio"].playable_roles().contains(&Role::Support));
    assert!(meta["Locke"].playable_roles().contains(&Role::Adc));
    assert!(meta["Locke"].playable_roles().contains(&Role::Top));
}

/// T31: the reference universe built on the floored table agrees with the meta through `is_playable`.
#[test]
fn the_live_universe_agrees_through_is_playable() {
    let live = live_from(&frozen_path());
    let u = &live.universe;
    let at = |id: &str| u.index(id).unwrap_or_else(|| panic!("no {id}"));
    let (lee, kaisa) = (at("LeeSin"), at("Kaisa"));
    assert!(u.is_playable(lee, Role::Jungle));
    for role in [Role::Top, Role::Middle, Role::Adc, Role::Support] {
        assert!(!u.is_playable(lee, role), "Lee Sin {role:?}");
    }
    assert!(u.is_playable(kaisa, Role::Adc));
    assert!(!u.is_playable(kaisa, Role::Top));
    assert!(u.is_playable(at("Galio"), Role::Support));
    assert!(u.is_playable(at("Locke"), Role::Adc));
    assert!(u.is_playable(at("Locke"), Role::Top));
}

fn idx(u: &Universe, id: &str) -> engine_core::reference::universe::ChampionIdx {
    u.index(id).unwrap_or_else(|| panic!("no champion {id}"))
}

fn tags(u: &Universe, rows: &[(Role, &[&str])]) -> RoleSets {
    rows.iter().fold(RoleSets::default(), |tags, (role, ids)| {
        ids.iter()
            .fold(tags, |tags, id| tags.with(*role, idx(u, id)))
    })
}

/// The standard format's board, every ban a skip, each side's picks in the order given.
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

/// T31 / RA4: the pool-tag exception, stated. Kai'Sa's top is under the floor, so by the meta she is
/// ADC-only; but a role-tagged side whose pool map lists her under top still seats her there in the
/// reference engine (`playable` = the meta's set | the side's own tags). Blue holds Jinx + Kai'Sa: with
/// Kai'Sa tagged top the comp fills; with the same pool without that entry it cannot.
#[test]
fn a_pool_tag_still_seats_kaisa_at_top_in_the_reference_engine() {
    let live = live_from(&frozen_path());
    let u = &live.universe;
    assert!(!u.is_playable(idx(u, "Kaisa"), Role::Top));
    let format = Format::standard();
    let red = tags(
        u,
        &[
            (Role::Top, &["Darius"]),
            (Role::Jungle, &["LeeSin"]),
            (Role::Middle, &["Zed"]),
            (Role::Adc, &["Jinx"]),
            (Role::Support, &["Sona"]),
        ],
    );
    let blue_with = tags(
        u,
        &[
            (Role::Top, &["Garen", "Kaisa"]),
            (Role::Jungle, &["LeeSin"]),
            (Role::Middle, &["Ahri"]),
            (Role::Adc, &["Jinx"]),
            (Role::Support, &["Sona"]),
        ],
    );
    let blue_without = tags(
        u,
        &[
            (Role::Top, &["Garen"]),
            (Role::Jungle, &["LeeSin"]),
            (Role::Middle, &["Ahri"]),
            (Role::Adc, &["Jinx", "Kaisa"]),
            (Role::Support, &["Sona"]),
        ],
    );
    let entries = board(&format, u, &["Jinx", "Kaisa"], &["Darius", "Zed"]);
    let feasible = |blue: RoleSets| {
        let pools = Pools::default()
            .with_roles(Side::Blue, blue)
            .with_roles(Side::Red, red);
        let position =
            Position::new(&format, &entries, &pools, u).unwrap_or_else(|e| panic!("{e}"));
        side_feasible(
            &mut FeasibilityMemo::new(Price::ZERO),
            FeasibilityRule::Roster,
            Side::Blue,
            &position,
            &pools,
            u,
        )
    };
    assert!(feasible(blue_with), "Kai'Sa tagged top by Blue's own pool");
    assert!(
        !feasible(blue_without),
        "no top entry: two ADC-only picks cannot fill five roles"
    );
}

/// T31, the live file: no non-listed playable role is stored below `playableRule.minOwnShare`. A file
/// without `playableRule` or without `minOwnShare` (a later `--source ugg` refresh omits both) passes
/// vacuously, and says so.
#[test]
fn the_live_file_holds_no_playable_role_under_its_floor() {
    let path = repo_root().join("data/compiled/champion-meta.json");
    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("champion-meta.json"))
            .expect("parses");
    let Some(floor) = doc["sources"]["positions"]["playableRule"]["minOwnShare"].as_f64() else {
        println!(
            "vacuous: {} carries no playableRule.minOwnShare",
            path.display()
        );
        return;
    };
    let mut checked = 0;
    for (id, row) in doc["champions"].as_object().expect("champions") {
        let (Some(playable), Some(shares)) = (
            row["playable"].as_array(),
            row["positionShares"].as_object(),
        ) else {
            continue;
        };
        if shares.len() != 5 {
            continue;
        }
        for role in playable {
            let role = role.as_str().expect("role");
            let listed = row["positions"]
                .as_array()
                .is_some_and(|p| p.iter().any(|r| r.as_str() == Some(role)));
            if listed {
                continue;
            }
            let share = shares[role]
                .as_f64()
                .unwrap_or_else(|| panic!("{id}: no share for {role}"));
            assert!(
                share >= floor,
                "{id}: playable {role} holds {share}, under the {floor} floor"
            );
            checked += 1;
        }
    }
    println!("{checked} non-listed playable roles at or above {floor}");
}
