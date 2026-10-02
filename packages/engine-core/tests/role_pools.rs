//! Role-aware pools (design docs/designs/engine-role-aware-pools-design.md): a pool as (champion,
//! role) entries, off-role priced as off-pool. Band universes here; the live-universe tests are in
//! tests/live.rs and tests/tier_b.rs.

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, Side};
use engine_core::engine::EngineError;
use engine_core::pools::Role;
use engine_core::reference::feasibility::{
    locked_matchable, side_feasible, tags_for, FeasibilityMemo, FeasibilityRule,
};
use engine_core::reference::format::{Format, Kind, Turn};
use engine_core::reference::oracle::{evaluate, Mode, OracleError, OracleInput};
use engine_core::reference::search::{search, SearchParams};
use engine_core::reference::state::{Entry, Pools, Position, RoleSets};
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

/// Two single-role champions per role (`T1 T2 J1 J2 M1 M2 A1 A2 S1 S2`) plus `extra`.
fn band(extra: &[(&'static str, &'static [&'static str])]) -> Universe {
    let mut champions: Vec<(&str, &[&str])> = vec![
        ("T1", &["Top"]),
        ("T2", &["Top"]),
        ("J1", &["Jungle"]),
        ("J2", &["Jungle"]),
        ("M1", &["Middle"]),
        ("M2", &["Middle"]),
        ("A1", &["Adc"]),
        ("A2", &["Adc"]),
        ("S1", &["Support"]),
        ("S2", &["Support"]),
    ];
    champions.extend_from_slice(extra);
    universe(&champions)
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

/// Design RA4 / test 7 (feasibility half): a pool entry under a role the meta does not list makes
/// that role playable — for the side whose pool lists it, and for nobody else. `X` and `Y` are
/// Middle-only in the meta; Blue's pool lists both under Top.
#[test]
fn a_pool_entry_makes_its_role_playable_for_that_side_only() {
    let u = band(&[("X", &["Middle"]), ("Y", &["Middle"])]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1", "X", "Y"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let red = tags(
        &u,
        &[
            (Role::Top, &["T2"]),
            (Role::Jungle, &["J2"]),
            (Role::Middle, &["M2", "Y"]),
            (Role::Adc, &["A2"]),
            (Role::Support, &["S2"]),
        ],
    );
    let pools = Pools::default()
        .with_roles(Side::Blue, blue)
        .with_roles(Side::Red, red);
    // Blue holds M1 + X, Red holds M2 + Y: two Middle-only champions a side by the meta.
    let entries = board(&format, &u, &["M1", "X"], &["M2", "Y"]);
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let rule = FeasibilityRule::Roster;

    let feasible = |pools: &Pools, rule, side| {
        side_feasible(
            &mut FeasibilityMemo::default(),
            rule,
            side,
            &position,
            pools,
            &u,
        )
    };
    // Blue's own entry puts X top: the comp fills.
    assert!(feasible(&pools, rule, Side::Blue));
    // Red holds Y, which BLUE's pool lists top; Red's own pool lists it Middle: no help.
    assert!(!feasible(&pools, rule, Side::Red));
    // The same sets without tags: the meta alone, two mids, broken.
    let untagged = Pools {
        blue: pools.blue,
        red: pools.red,
        ..Pools::default()
    };
    assert!(!feasible(&untagged, rule, Side::Blue));

    // The lazy filter's question, asked the same way.
    let matchable = |pools: &Pools, side| {
        locked_matchable(
            &mut FeasibilityMemo::default(),
            side,
            position.picks(side),
            tags_for(rule, side, &position, pools),
            &u,
        )
    };
    assert!(matchable(&pools, Side::Blue));
    assert!(!matchable(&pools, Side::Red));
    assert!(!matchable(&untagged, Side::Blue));

    // Outside a live rule the tags are not read (the helpers are total): Blue is its set again.
    assert_eq!(
        tags_for(FeasibilityRule::On, Side::Blue, &position, &pools),
        None
    );
    assert_eq!(
        tags_for(FeasibilityRule::Off, Side::Blue, &position, &pools),
        None
    );
    assert_eq!(tags_for(rule, Side::Blue, &position, &pools), Some(&blue));
    assert!(!feasible(&pools, FeasibilityRule::On, Side::Blue));
}

fn search_params() -> SearchParams {
    SearchParams {
        node_budget: None,
        prune: true,
        transposition: true,
        wall_budget: std::time::Duration::from_secs(86_400),
        min_completed_depth: 1,
        shortlist: None,
        snipe_key: false,
    }
}

/// Design § 1 / test 15: a role-tagged pool is refused where role tags are not read — under the gate
/// rules (no price: an off-role pick would be legal and free) and on a format where a side does not
/// pick five — by the oracle and by the search, before anything is searched. A list pool on the same
/// inputs is accepted.
#[test]
fn a_role_tagged_pool_is_refused_where_tags_are_not_read() {
    let u = band(&[]);
    let standard = Format::standard();
    let blue = RoleSets::meta_roles(set(&u, &["T1", "J1", "M1", "A1", "S1"]), &u);
    let red = set(&u, &["T2", "J2", "M2", "A2", "S2"]);
    let tagged = Pools {
        red,
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let list = Pools {
        blue: tagged.blue,
        red,
        ..Pools::default()
    };

    let refusal = |format: &Format, pools: &Pools, rule: FeasibilityRule| {
        let position = Position::new(format, &[], pools, &u).unwrap_or_else(|e| panic!("{e}"));
        let input = OracleInput {
            position: &position,
            universe: &u,
            pools,
            objective: &u,
            feasibility: rule,
            mode: Mode::Horizon(1),
            epsilon: 1e-9,
            off_pool_cost: (rule == FeasibilityRule::Roster).then_some(0.1),
        };
        let oracle = evaluate(&input).err();
        let searched = search(&input, &search_params(), &CancelHandle::new(), |_| {}).err();
        (oracle, searched)
    };
    let names = |(oracle, searched): (Option<OracleError>, Option<EngineError>), words: &[&str]| {
        let reason = match oracle {
            Some(OracleError::RoleTags { reason }) => reason,
            other => panic!("the oracle: {other:?}"),
        };
        assert!(words.iter().all(|w| reason.contains(w)), "{reason}");
        match searched {
            Some(EngineError::InvalidInput { path }) => {
                assert_eq!(path, vec![format!("role tags: {reason}")])
            }
            other => panic!("the search: {other:?}"),
        }
    };

    names(
        refusal(&standard, &tagged, FeasibilityRule::On),
        &["Blue", "under on", "list form"],
    );
    names(
        refusal(&standard, &tagged, FeasibilityRule::Off),
        &["Blue", "under off", "list form"],
    );
    // One pick a side: the completion predicate is not defined there.
    let short = Format::explicit(vec![
        Turn {
            side: Side::Blue,
            kind: Kind::Pick,
        },
        Turn {
            side: Side::Red,
            kind: Kind::Pick,
        },
    ]);
    names(
        refusal(&short, &tagged, FeasibilityRule::Roster),
        &["Blue", "picks 1", "five-pick"],
    );

    // The same inputs in list form, and the tagged pool under the live rules: accepted.
    for (format, pools, rule) in [
        (&standard, &list, FeasibilityRule::On),
        (&standard, &list, FeasibilityRule::Off),
        (&short, &list, FeasibilityRule::Roster),
        (&standard, &tagged, FeasibilityRule::Roster),
        (&standard, &tagged, FeasibilityRule::PoolOrRoster),
    ] {
        let (oracle, searched) = refusal(format, pools, rule);
        assert!(
            !matches!(oracle, Some(OracleError::RoleTags { .. })),
            "{rule:?}: {oracle:?}"
        );
        assert!(searched.is_none(), "{rule:?}: {searched:?}");
    }
}
