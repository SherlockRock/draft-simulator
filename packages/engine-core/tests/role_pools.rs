//! Role-aware pools (design docs/designs/engine-role-aware-pools-design.md): a pool as (champion,
//! role) entries, off-role priced as off-pool. Band universes here; the live-universe tests are in
//! tests/live.rs and tests/tier_b.rs.

use engine_core::draft_state::Side;
use engine_core::pools::Role;
use engine_core::reference::state::{Pools, RoleSets};
use engine_core::reference::universe::{ChampionIdx, ChampionSet, Universe, UniverseSpec};

/// `(id, positions)` per champion, linear term 0, no tables: roles are all these tests read.
fn universe(champions: &[(&str, &[&str])]) -> Universe {
    let list: Vec<String> = champions
        .iter()
        .map(|(id, positions)| {
            let positions: Vec<String> = positions.iter().map(|p| format!("\"{p}\"")).collect();
            format!(
                r#"{{"id": "{id}", "positions": [{}], "linear": 0}}"#,
                positions.join(",")
            )
        })
        .collect();
    let json = format!(r#"{{"champions": [{}]}}"#, list.join(","));
    let spec: UniverseSpec = serde_json::from_str(&json).unwrap_or_else(|e| panic!("{e}"));
    Universe::new(spec).unwrap_or_else(|e| panic!("{e:?}"))
}

fn idx(u: &Universe, id: &str) -> ChampionIdx {
    u.index(id).unwrap_or_else(|| panic!("no champion {id}"))
}

fn set(u: &Universe, ids: &[&str]) -> ChampionSet {
    ids.iter().map(|id| idx(u, id)).collect()
}

/// Design § 1: tags are per role, a champion may sit under two (RA1), the pool as a set is their
/// union, and list form written as tags is every role the meta lists.
#[test]
fn role_sets_hold_a_champion_under_every_role_it_is_listed_for() {
    let u = universe(&[
        ("Flex", &["Top", "Jungle"]),
        ("Mid", &["Middle"]),
        ("Adc", &["Adc"]),
    ]);
    let (flex, mid) = (idx(&u, "Flex"), idx(&u, "Mid"));
    let tags = RoleSets::default()
        .with(Role::Top, flex)
        .with(Role::Jungle, flex)
        .with(Role::Middle, mid);
    assert_eq!(tags.for_role(Role::Top), set(&u, &["Flex"]));
    assert_eq!(tags.for_role(Role::Jungle), set(&u, &["Flex"]));
    assert_eq!(tags.for_role(Role::Middle), set(&u, &["Mid"]));
    assert!(tags.for_role(Role::Adc).is_empty());
    assert_eq!(tags.union(), set(&u, &["Flex", "Mid"]));

    // List form as tags: every meta role, and only those.
    let listed = RoleSets::meta_roles(set(&u, &["Flex", "Adc"]), &u);
    assert_eq!(listed.for_role(Role::Top), set(&u, &["Flex"]));
    assert_eq!(listed.for_role(Role::Jungle), set(&u, &["Flex"]));
    assert_eq!(listed.for_role(Role::Adc), set(&u, &["Adc"]));
    assert!(listed.for_role(Role::Middle).is_empty());
    assert!(listed.for_role(Role::Support).is_empty());
    assert_eq!(listed.union(), set(&u, &["Flex", "Adc"]));
    assert!(!listed.union().contains(mid));
}

/// Design § 1: `with_roles` keeps a side's set equal to the union of its tags, and leaves the other
/// side as it was; a default pool carries no tags.
#[test]
fn with_roles_keeps_the_set_and_the_tags_in_step() {
    let u = universe(&[("Flex", &["Top", "Jungle"]), ("Mid", &["Middle"])]);
    let untagged = Pools {
        blue: set(&u, &["Mid"]),
        red: set(&u, &["Flex", "Mid"]),
        ..Pools::default()
    };
    assert_eq!(untagged.roles(Side::Blue), None);
    assert_eq!(untagged.roles(Side::Red), None);

    let tags = RoleSets::default().with(Role::Top, idx(&u, "Flex"));
    let tagged = untagged.with_roles(Side::Blue, tags);
    assert_eq!(tagged.for_side(Side::Blue), set(&u, &["Flex"]));
    assert_eq!(tagged.roles(Side::Blue), Some(&tags));
    assert_eq!(tagged.for_side(Side::Red), set(&u, &["Flex", "Mid"]));
    assert_eq!(tagged.roles(Side::Red), None);
}
