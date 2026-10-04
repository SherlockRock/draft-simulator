//! Role-aware pools (design docs/designs/engine-role-aware-pools-design.md): a pool as (champion,
//! role) entries, off-role priced as off-pool. Band universes here; the live-universe tests are in
//! tests/live.rs and tests/tier_b.rs.

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, Side};
use engine_core::engine::EngineError;
use engine_core::pools::Role;
use engine_core::reference::feasibility::{
    action_charge, critical_pool, locked_matchable, off_pool, off_pool_count, pool_can_complete,
    side_feasible, tags_for, FeasibilityMemo, FeasibilityRule, OffPool,
};
use engine_core::reference::fixture::{Fixture, FixtureError};
use engine_core::reference::format::{Format, Kind, Turn};
use engine_core::reference::node::legal_actions_under;
use engine_core::reference::oracle::{evaluate, Mode, OracleError, OracleInput};
use engine_core::reference::search::{
    root_shortlist, search, static_order, truncate_children, Filter, SearchOutcome, SearchParams,
    Shortlist,
};
use engine_core::reference::state::{Action, Entry, Pools, Position, RoleSets};
use engine_core::reference::universe::{ChampionIdx, ChampionSet, Universe, UniverseSpec};

/// `(id, positions)` per champion, linear term 0, no tables: roles are all most of these tests read.
fn universe(champions: &[(&str, &[&str])]) -> Universe {
    let valued: Vec<(&str, &[&str], f64)> = champions
        .iter()
        .map(|(id, positions)| (*id, *positions, 0.0))
        .collect();
    valued_universe(&valued)
}

/// `(id, positions, linear)` per champion, no tables.
fn valued_universe(champions: &[(&str, &[&str], f64)]) -> Universe {
    let list: Vec<String> = champions
        .iter()
        .map(|(id, positions, linear)| {
            let positions: Vec<String> = positions.iter().map(|p| format!("\"{p}\"")).collect();
            format!(
                r#"{{"id": "{id}", "positions": [{}], "linear": {linear}}}"#,
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
    band_with(extra, &[])
}

/// `band`, with a linear term for the champions named in `linear` (0 for the rest).
fn band_with(
    extra: &[(&'static str, &'static [&'static str])],
    linear: &[(&str, f64)],
) -> Universe {
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
    let valued: Vec<(&str, &[&str], f64)> = champions
        .iter()
        .map(|(id, positions)| {
            let value = linear
                .iter()
                .find(|(named, _)| named == id)
                .map_or(0.0, |(_, value)| *value);
            (*id, *positions, value)
        })
        .collect();
    valued_universe(&valued)
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

/// Design § 2: the shortlist's lazy filter asks `locked_matchable` with the mover's tags. `X` is
/// Middle-only in the meta and Blue's pool lists it Top. Beside M1 + J1, taking X keeps Blue's comp
/// arrangeable only through that entry: a role-tagged Blue keeps X as its one child; the same pool as
/// a list drops it for the next arrangeable child.
#[test]
fn the_lazy_filter_matches_a_tagged_side_on_its_playable_roles() {
    let u = band(&[("X", &["Middle"])]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1", "X"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let list = Pools {
        blue: pools.blue,
        red: pools.red,
        ..Pools::default()
    };
    // Blue holds M1 + J1 and completes its pair at slot 10.
    let entries = board(&format, &u, &["M1", "J1"], &["T2", "J2"]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    // A second mid (never arrangeable), then X, then a top.
    let ordered = vec![
        Action::Pick(idx(&u, "M2")),
        Action::Pick(idx(&u, "X")),
        Action::Pick(idx(&u, "T1")),
    ];
    let first = |pools: &Pools| {
        truncate_children(
            &root,
            Side::Blue,
            ordered.clone(),
            1,
            &mut Filter {
                rule: FeasibilityRule::Roster,
                memo: &mut FeasibilityMemo::default(),
                universe: &u,
                pools,
            },
        )
    };
    assert_eq!(first(&pools), vec![Action::Pick(idx(&u, "X"))]);
    assert_eq!(first(&list), vec![Action::Pick(idx(&u, "T1"))]);
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
    // The helpers agree: off five picks the tags are not read, whatever the rule.
    let one_pick = Position::new(&short, &[], &tagged, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(
        tags_for(FeasibilityRule::Roster, Side::Blue, &one_pick, &tagged),
        None
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

/// Review minor F7: `Pools`' set and tag fields are public, so a literal can put them out of step and
/// the three readers of the set (the gate, the legal fan, the board check) would then disagree
/// silently with the readers of the tags. A tagged side whose set is not the union of its tags is
/// refused up front, under either live rule, by the oracle and the search alike.
#[test]
fn a_tagged_side_whose_set_is_not_its_union_is_refused() {
    let u = band(&[]);
    let format = Format::standard();
    let blue = RoleSets::meta_roles(set(&u, &["T1", "J1", "M1", "A1", "S1"]), &u);
    let out_of_step = Pools {
        blue: set(&u, &["T1", "J1", "M1", "A1"]),
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        blue_roles: Some(blue),
        red_roles: None,
    };
    let in_step = Pools {
        red: out_of_step.red,
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    for rule in LIVE {
        let refuse = |pools: &Pools| {
            let position = Position::new(&format, &[], pools, &u).unwrap_or_else(|e| panic!("{e}"));
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
            (
                evaluate(&input).err(),
                search(&input, &search_params(), &CancelHandle::new(), |_| {}).err(),
            )
        };
        let (oracle, searched) = refuse(&out_of_step);
        let reason = match oracle {
            Some(OracleError::RoleTags { reason }) => reason,
            other => panic!("{rule:?}: the oracle: {other:?}"),
        };
        assert!(
            ["Blue", "union"].iter().all(|w| reason.contains(w)),
            "{reason}"
        );
        match searched {
            Some(EngineError::InvalidInput { path }) => {
                assert_eq!(path, vec![format!("role tags: {reason}")])
            }
            other => panic!("{rule:?}: the search: {other:?}"),
        }
        let (oracle, searched) = refuse(&in_step);
        assert!(
            !matches!(oracle, Some(OracleError::RoleTags { .. })),
            "{rule:?}: {oracle:?}"
        );
        assert!(searched.is_none(), "{rule:?}: {searched:?}");
    }
}

const LIVE: [FeasibilityRule; 2] = [FeasibilityRule::PoolOrRoster, FeasibilityRule::Roster];

/// The same sets with no tags: the list form of a tagged pool.
fn as_list(pools: &Pools) -> Pools {
    Pools {
        blue: pools.blue,
        red: pools.red,
        ..Pools::default()
    }
}

fn count(
    rule: FeasibilityRule,
    side: Side,
    position: &Position<'_>,
    pools: &Pools,
    u: &Universe,
) -> OffPool {
    off_pool(
        &mut FeasibilityMemo::default(),
        rule,
        side,
        position,
        pools,
        u,
    )
}

/// Blue's pool has no ADC of its own; `V` is listed Middle and the meta lets it play Adc — the
/// Viktor-at-ADC case. Red's pool is a plain list. Blue holds top, jungle, mid, support and picks last.
fn off_role_probe() -> (Universe, Pools, Vec<Entry>) {
    off_role_probe_with(&[])
}

/// `off_role_probe` with linear terms (the search tests give the roster ADC an edge).
fn off_role_probe_with(linear: &[(&str, f64)]) -> (Universe, Pools, Vec<Entry>) {
    let u = band_with(&[("V", &["Middle", "Adc"])], linear);
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1", "V"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(
        &Format::standard(),
        &u,
        &["T1", "J1", "M1", "S1"],
        &["T2", "J2", "M2", "A2"],
    );
    (u, pools, entries)
}

/// Design § 6 tests 3 and 8: off-role is off-pool. At the root the pool cannot fill ADC in-role, so
/// one pick is forced though the pool, as a set, can finish (list form: 0). Taking `V` for ADC is
/// charged exactly like taking the roster's `A1`; listed for Adc it is free.
#[test]
fn an_off_role_fill_is_charged_like_an_off_pool_pick() {
    let (u, pools, entries) = off_role_probe();
    let format = Format::standard();
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(root.mover(), Some(Side::Blue));
    let (v, a1) = (idx(&u, "V"), idx(&u, "A1"));
    let listed_adc = pools.with_roles(
        Side::Blue,
        pools
            .roles(Side::Blue)
            .copied()
            .unwrap_or_default()
            .with(Role::Adc, v),
    );
    for rule in LIVE {
        // The root: nothing made, one forced — the ADC has to come from off-role or off-pool.
        assert_eq!(
            count(rule, Side::Blue, &root, &pools, &u),
            OffPool { made: 0, forced: 1 },
            "{rule:?}"
        );
        // The same pool as a set: V covers ADC by the meta, nothing is forced.
        assert_eq!(
            count(rule, Side::Blue, &root, &as_list(&pools), &u),
            OffPool::default(),
            "{rule:?}"
        );
        // V at ADC is one off-pool pick, and so is A1.
        for pick in [v, a1] {
            let leaf = root.apply(Action::Pick(pick));
            assert_eq!(
                count(rule, Side::Blue, &leaf, &pools, &u),
                OffPool { made: 1, forced: 0 },
                "{rule:?} {}",
                u.id(pick)
            );
        }
        // V listed for Adc as well: in-role, free, and nothing forced at the root.
        assert_eq!(
            count(rule, Side::Blue, &root, &listed_adc, &u),
            OffPool::default()
        );
        assert_eq!(
            count(
                rule,
                Side::Blue,
                &root.apply(Action::Pick(v)),
                &listed_adc,
                &u
            ),
            OffPool::default()
        );
        // The action's own charge says the same, without building the leaf.
        let mut memo = FeasibilityMemo::default();
        let charge = action_charge(&mut memo, rule, Side::Blue, &root, &pools, &u);
        assert_eq!(charge.of(Action::Pick(v)), 1);
        assert_eq!(charge.of(Action::Pick(a1)), 1);
        let mut memo = FeasibilityMemo::default();
        let charge = action_charge(&mut memo, rule, Side::Blue, &root, &listed_adc, &u);
        assert_eq!(charge.of(Action::Pick(v)), 0);
        // Red's list pool is untouched by Blue's tags.
        assert_eq!(
            count(rule, Side::Red, &root, &pools, &u),
            OffPool::default()
        );
    }
    // Cross-game exclusions with tags: an excluded champion leaves the pool net. With A1 listed for
    // Adc nothing is forced; exclude A1 (A2 is on Red's board) and the ADC is forced again.
    let with_a1 = pools.with_roles(
        Side::Blue,
        pools
            .roles(Side::Blue)
            .copied()
            .unwrap_or_default()
            .with(Role::Adc, a1),
    );
    let open = Position::new(&format, &entries, &with_a1, &u).unwrap_or_else(|e| panic!("{e}"));
    let shut = Position::new(&format, &entries, &with_a1, &u)
        .unwrap_or_else(|e| panic!("{e}"))
        .with_excluded(set(&u, &["A1"]));
    for rule in LIVE {
        assert_eq!(
            count(rule, Side::Blue, &open, &with_a1, &u),
            OffPool::default(),
            "{rule:?}"
        );
        assert_eq!(
            count(rule, Side::Blue, &shut, &with_a1, &u),
            OffPool { made: 0, forced: 1 },
            "{rule:?}"
        );
    }
    // The gate rules have no off-pool count at all.
    assert_eq!(
        count(FeasibilityRule::On, Side::Blue, &root, &pools, &u),
        OffPool::default()
    );
}

/// Design RA4 / § 6 test 7 (pricing half): a pool entry under a role the meta does not list is
/// IN-ROLE there — not merely playable. `X` is Middle-only in the meta and Blue's pool lists it Top,
/// and lists nobody else for Top. X is the pool's top filler (nothing is forced), taking it costs
/// nothing, and it sits in-role on the board. Listed under its meta role instead, Top is forced.
#[test]
fn an_off_meta_entry_is_in_role_where_the_pool_lists_it() {
    let u = band(&[("X", &["Middle"])]);
    let format = Format::standard();
    let red = set(&u, &["T2", "J2", "M2", "A2", "S2"]);
    let pools = |x_role: Role| {
        let blue = tags(
            &u,
            &[
                (Role::Jungle, &["J1"]),
                (Role::Middle, &["M1"]),
                (Role::Adc, &["A1"]),
                (Role::Support, &["S1"]),
            ],
        )
        .with(x_role, idx(&u, "X"));
        Pools {
            red,
            ..Pools::default()
        }
        .with_roles(Side::Blue, blue)
    };
    // Blue holds J1 + M1 and completes its pair at slot 10; three picks to come.
    let entries = board(&format, &u, &["J1", "M1"], &["T2", "J2"]);
    let x = Action::Pick(idx(&u, "X"));
    for rule in LIVE {
        // X listed Top: the pool finishes in-role through it.
        let listed_top = pools(Role::Top);
        let root =
            Position::new(&format, &entries, &listed_top, &u).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            count(rule, Side::Blue, &root, &listed_top, &u),
            OffPool::default(),
            "{rule:?}"
        );
        let charge = action_charge(
            &mut FeasibilityMemo::default(),
            rule,
            Side::Blue,
            &root,
            &listed_top,
            &u,
        );
        assert_eq!(charge.of(x), 0, "{rule:?}");
        assert_eq!(
            count(rule, Side::Blue, &root.apply(x), &listed_top, &u),
            OffPool::default(),
            "{rule:?}"
        );
        // X listed Middle (where the meta has it): nobody is listed for Top, one pick is forced.
        let listed_mid = pools(Role::Middle);
        let root =
            Position::new(&format, &entries, &listed_mid, &u).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            count(rule, Side::Blue, &root, &listed_mid, &u),
            OffPool { made: 0, forced: 1 },
            "{rule:?}"
        );
    }
}

/// Design § 2 (the grid's finding): the tagged count asks the pool first and the roster only when a
/// pick is short. The roster predicate's candidate set is everything available — a new memo entry at
/// every leaf — so a count that asks it when nothing is forced pays memory for nothing
/// (`FeasibilityMemo::calls` counts the roster / set predicate's calls; the weight has its own map).
#[test]
fn the_tagged_count_asks_the_roster_only_when_a_pick_is_short() {
    let (u, pools, entries) = off_role_probe();
    let format = Format::standard();
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let finishes = pools.with_roles(
        Side::Blue,
        pools
            .roles(Side::Blue)
            .copied()
            .unwrap_or_default()
            .with(Role::Adc, idx(&u, "A1")),
    );
    for rule in LIVE {
        // The pool finishes in-role: nothing short, the roster is never asked.
        let mut memo = FeasibilityMemo::default();
        assert_eq!(
            off_pool(&mut memo, rule, Side::Blue, &root, &finishes, &u),
            OffPool::default()
        );
        assert_eq!(memo.calls, 0, "{rule:?}");
        // One pick short: the roster is asked, once.
        let mut memo = FeasibilityMemo::default();
        assert_eq!(
            off_pool(&mut memo, rule, Side::Blue, &root, &pools, &u),
            OffPool { made: 0, forced: 1 }
        );
        assert_eq!(memo.calls, 1, "{rule:?}");
    }
}

/// Design fact 3 / § 2: an action that breaks the mover's comp is charged nothing more. Blue holds M1
/// and `V` (listed Middle, pushed to Adc: one off-role pick already made); taking A1 — in the pool,
/// listed Adc — leaves V nowhere to go. The broken board falls back to the set test (no champion is
/// outside the pool), which is below what was already made, and the charge is clamped at 0: that child
/// is priced by L', not by P.
#[test]
fn an_action_that_breaks_the_comp_is_charged_nothing_more() {
    let u = band(&[("V", &["Middle", "Adc"])]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1", "V"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u, &["M1", "V"], &["T2", "J2"]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let rule = FeasibilityRule::Roster;
    assert_eq!(count(rule, Side::Blue, &root, &pools, &u).made, 1);
    let mut memo = FeasibilityMemo::default();
    let charge = action_charge(&mut memo, rule, Side::Blue, &root, &pools, &u);
    let a1 = Action::Pick(idx(&u, "A1"));
    assert_eq!(charge.of(a1), 0);
    let broken = root.apply(a1);
    assert!(!side_feasible(
        &mut memo,
        rule,
        Side::Blue,
        &broken,
        &pools,
        &u
    ));
    // A pick that keeps the comp arrangeable is charged as usual: T1 is in-role, J2 is off the pool.
    assert_eq!(charge.of(Action::Pick(idx(&u, "T1"))), 0);
    assert_eq!(charge.of(Action::Pick(idx(&u, "J2"))), 1);
}

/// Review minor F2 (role-aware pools execution): the clamp above floors the DIFFERENCE at 0, but an
/// action that names a champion outside the pool is off-pool whatever it does to the comp. Same
/// board: taking A2 — off Blue's pool, Adc — leaves V nowhere to go, so the broken board falls back to
/// the set test (one champion outside) and the clamp alone would read 0 below the one already made.
/// The charge is never below the champions the action names outside the pool: 1 — as list form says.
#[test]
fn an_outside_champion_that_breaks_the_comp_is_still_charged_for_itself() {
    let u = band(&[("V", &["Middle", "Adc"])]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1", "V"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u, &["M1", "V"], &["T2", "J2"]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let rule = FeasibilityRule::Roster;
    assert_eq!(count(rule, Side::Blue, &root, &pools, &u).made, 1);
    let mut memo = FeasibilityMemo::default();
    let charge = action_charge(&mut memo, rule, Side::Blue, &root, &pools, &u);
    let a2 = Action::Pick(idx(&u, "A2"));
    assert!(!pools.blue.contains(idx(&u, "A2")));
    assert!(!side_feasible(
        &mut memo,
        rule,
        Side::Blue,
        &root.apply(a2),
        &pools,
        &u
    ));
    assert_eq!(charge.of(a2), 1, "its own outside champion still counts");
    // List form agrees, and the in-pool break (A1) is still charged nothing more.
    let list = as_list(&pools);
    let list_charge = action_charge(&mut memo, rule, Side::Blue, &root, &list, &u);
    assert_eq!(list_charge.of(a2), 1);
    assert_eq!(charge.of(Action::Pick(idx(&u, "A1"))), 0);
    // A pair naming one outside champion that breaks the comp is charged that one: with T1 locked
    // too (Blue's pair at slot 17), A2 + S1 fills Adc and Support and leaves V nowhere to go.
    let entries = board(&format, &u, &["M1", "V", "T1"], &["T2", "J2", "M2", "S2"]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(root.slot_index(), 17);
    assert_eq!(count(rule, Side::Blue, &root, &pools, &u).made, 1);
    let mut memo = FeasibilityMemo::default();
    let charge = action_charge(&mut memo, rule, Side::Blue, &root, &pools, &u);
    let pair = Action::pair(idx(&u, "A2"), idx(&u, "S1"));
    assert!(!side_feasible(
        &mut memo,
        rule,
        Side::Blue,
        &root.apply(pair),
        &pools,
        &u
    ));
    assert_eq!(charge.of(pair), 1);
}

/// Design § 6 test 4 (RA1): a champion listed under two roles is in-role in either.
#[test]
fn a_two_role_entry_is_in_pool_for_both_roles() {
    let u = band(&[("F", &["Top", "Jungle"])]);
    let format = Format::standard();
    let both = tags(
        &u,
        &[
            (Role::Top, &["T1", "F"]),
            (Role::Jungle, &["J1", "F"]),
            (Role::Middle, &["M1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let top_only = tags(
        &u,
        &[
            (Role::Top, &["T1", "F"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let red = set(&u, &["T2", "J2", "M2", "A2", "S2"]);
    let pools = |blue: RoleSets| {
        Pools {
            red,
            ..Pools::default()
        }
        .with_roles(Side::Blue, blue)
    };
    let made = |blue: RoleSets, locked: &str| {
        let pools = pools(blue);
        let entries = board(&format, &u, &[locked, "F"], &["T2", "J2"]);
        let position =
            Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
        count(FeasibilityRule::Roster, Side::Blue, &position, &pools, &u).made
    };
    // Beside a top, F plays jungle; beside a jungle, top: listed for both, free either way.
    assert_eq!(made(both, "T1"), 0);
    assert_eq!(made(both, "J1"), 0);
    // Listed top only: beside a top it has to jungle, off-role.
    assert_eq!(made(top_only, "T1"), 1);
    assert_eq!(made(top_only, "J1"), 0);
}

/// Design § 6 test 5 (RA2): the charge is the cheapest arrangement's. A later pick that takes a locked
/// pick's listed role displaces one of the two — one charge, whichever moves — and none when the
/// newcomer has a listed role of its own to go to.
#[test]
fn a_displaced_pick_is_charged_once_whichever_of_the_two_moves() {
    let u = band(&[("B", &["Middle", "Top"]), ("L", &["Middle", "Top"])]);
    let format = Format::standard();
    let red = set(&u, &["T2", "J2", "M2", "A2", "S2"]);
    let blue_rows: [(Role, &[&str]); 5] = [
        (Role::Top, &["T1"]),
        (Role::Jungle, &["J1"]),
        (Role::Middle, &["M1", "B", "L"]),
        (Role::Adc, &["A1"]),
        (Role::Support, &["S1"]),
    ];
    let mids = tags(&u, &blue_rows);
    let made = |blue: RoleSets, picks: &[&str]| {
        let pools = Pools {
            red,
            ..Pools::default()
        }
        .with_roles(Side::Blue, blue);
        let entries = board(&format, &u, picks, &["T2", "J2"]);
        let position =
            Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
        count(FeasibilityRule::Roster, Side::Blue, &position, &pools, &u).made
    };
    // M1 (Middle only) locked, B (listed Middle) picked: B goes top, off-role.
    assert_eq!(made(mids, &["M1", "B"]), 1);
    // B also listed Top: it has an in-role seat, nothing is charged.
    assert_eq!(made(mids.with(Role::Top, idx(&u, "B")), &["M1", "B"]), 0);
    // L (listed Middle, can play Top) locked first, then M1 (Middle only): the LOCKED pick moves.
    assert_eq!(made(mids, &["L", "M1"]), 1);
    // Each alone is in-role.
    assert_eq!(made(mids, &["B"]), 0);
    assert_eq!(made(mids, &["L"]), 0);
}

/// Design § 6 test 8: a pool whose champions are listed only for roles already filled is charged
/// every remaining pick, though as a set (the meta lets each play elsewhere) it could finish.
#[test]
fn a_pool_listed_only_for_filled_roles_forces_every_remaining_pick() {
    let u = band(&[
        ("FM", &["Top", "Middle"]),
        ("FA", &["Top", "Adc"]),
        ("FS", &["Top", "Support"]),
    ]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1", "FM", "FA", "FS"]),
            (Role::Jungle, &["J1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u, &["T1", "J1"], &["T2", "J2"]);
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    for rule in LIVE {
        assert_eq!(
            count(rule, Side::Blue, &position, &pools, &u),
            OffPool { made: 0, forced: 3 },
            "{rule:?}"
        );
        assert_eq!(
            count(rule, Side::Blue, &position, &as_list(&pools), &u),
            OffPool::default(),
            "{rule:?}"
        );
    }
}

/// Design § 3 / § 6 test 9 (RA3): under `pool_or_roster` a pool that can finish only off-role opens
/// the roster — the off-role fill is no longer the only legal answer — and once a roster pick has
/// filled the hole the side is back inside its pool (the sunk pick does not count against it).
#[test]
fn a_pool_that_finishes_only_off_role_widens_and_returns_after_the_hole_is_filled() {
    let u = band(&[("V", &["Middle", "Adc"])]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1", "V"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    // Blue holds T1 + J1 and completes its pair at slot 10; three picks to come.
    let entries = board(&format, &u, &["T1", "J1"], &["T2", "J2"]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!((root.slot_index(), root.mover()), (10, Some(Side::Blue)));
    let rule = FeasibilityRule::PoolOrRoster;
    let can = |position: &Position<'_>, pools: &Pools| {
        pool_can_complete(
            &mut FeasibilityMemo::default(),
            rule,
            Side::Blue,
            position,
            pools,
            &u,
        )
    };
    let legal = |position: &Position<'_>, pools: &Pools| {
        legal_actions_under(position, &u, pools, rule, &mut FeasibilityMemo::default())
    };

    // Tagged: no in-role ADC, the pool cannot finish, every available champion is legal.
    assert!(!can(&root, &pools));
    let widened = legal(&root, &pools);
    assert_eq!(widened.len(), root.available(&u).len());
    assert!(widened.contains(&Action::Pick(idx(&u, "A1"))));
    assert!(widened.contains(&Action::Pick(idx(&u, "V"))));
    // As a set the pool finishes (V at ADC), and the side is held inside it: the defect.
    assert!(can(&root, &as_list(&pools)));
    assert_eq!(
        legal(&root, &as_list(&pools)),
        vec![
            Action::Pick(idx(&u, "M1")),
            Action::Pick(idx(&u, "S1")),
            Action::Pick(idx(&u, "V")),
        ]
    );

    // A1 from the roster fills the hole: one off-pool pick made, nothing more forced, and the pool can
    // finish the rest in-role — the side returns to it.
    let filled = root.apply(Action::Pick(idx(&u, "A1")));
    assert_eq!(
        count(rule, Side::Blue, &filled, &pools, &u),
        OffPool { made: 1, forced: 0 }
    );
    assert!(can(&filled, &pools));
    // V instead, with two picks still to come: V can still sit at Middle in-role, so nothing is made
    // yet and the ADC stays one forced pick (V at ADC with M1 at Middle costs the same one). The pool
    // still cannot finish in-role, so the roster stays open.
    let took_v = root.apply(Action::Pick(idx(&u, "V")));
    assert_eq!(
        count(rule, Side::Blue, &took_v, &pools, &u),
        OffPool { made: 0, forced: 1 }
    );
    assert!(!can(&took_v, &pools));
}

/// Design § 2 / § 6 test 10 (the judge's collision): a tagged side whose pool net is EVERYTHING
/// available, a pool that cannot finish in-role and a roster that can. The tagged pool test and the
/// roster predicate then share the key `(side, locked, candidates)`; on one memo, asked pool first,
/// the side must still be feasible and widened — not priced at L'.
#[test]
fn the_tagged_pool_test_never_poisons_the_roster_predicate() {
    let u = band(&[]);
    let format = Format::standard();
    // Every champion is in Blue's pool; the two ADCs are listed Top, so no entry fills Adc.
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1", "T2", "A1", "A2"]),
            (Role::Jungle, &["J1", "J2"]),
            (Role::Middle, &["M1", "M2"]),
            (Role::Support, &["S1", "S2"]),
        ],
    );
    let pools = Pools {
        red: u.all(),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    assert_eq!(pools.blue, u.all());
    let entries = board(&format, &u, &["T1"], &[]);
    let position = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let rule = FeasibilityRule::PoolOrRoster;
    let mut memo = FeasibilityMemo::default();
    assert_eq!(
        pools.blue.intersect(position.available(&u)),
        position.available(&u),
        "the pool net is everything available"
    );
    assert!(!pool_can_complete(
        &mut memo,
        rule,
        Side::Blue,
        &position,
        &pools,
        &u
    ));
    assert!(side_feasible(
        &mut memo,
        rule,
        Side::Blue,
        &position,
        &pools,
        &u
    ));
    assert_eq!(
        off_pool(&mut memo, rule, Side::Blue, &position, &pools, &u),
        OffPool { made: 0, forced: 1 }
    );
    // Asked again, in the other order, on the same memo: the same answers.
    assert!(side_feasible(
        &mut memo,
        rule,
        Side::Blue,
        &position,
        &pools,
        &u
    ));
    assert!(!pool_can_complete(
        &mut memo,
        rule,
        Side::Blue,
        &position,
        &pools,
        &u
    ));
}

struct Lcg(u64);

impl Lcg {
    fn below(&mut self, bound: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        usize::try_from((self.0 >> 33) % u64::try_from(bound.max(1)).unwrap_or(1)).unwrap_or(0)
    }
}

const ROLE_NAMES: [&str; 5] = ["Top", "Jungle", "Middle", "Adc", "Support"];

/// Design § 6 test 1 (a), on random boards: a pool written as a map of every meta role is the list.
/// 400 random universes (10–16 champions, one to three meta roles each), random pools, a random line
/// played from the empty board (picks land in and out of the pools, bans anywhere), and at the
/// position reached every reader is asked of the list pools, of the same pools as maps, and of one
/// side each way: the off-pool count in both parts, the pool test, feasibility, the critical set, the
/// legal fan and every action's charge — equal throughout, under both live rules. What this test can
/// and cannot see: it ties the tagged solver to list semantics, and it would still pass if every
/// reader ignored the tags (a map of every meta role IS the list) — the tests above, whose maps differ
/// from the meta, are what a tag bypass fails.
#[test]
fn a_map_of_every_meta_role_is_the_list_on_random_boards() {
    let format = Format::standard();
    let mut rng = Lcg(20_261_001);
    let (mut forced_cases, mut broken_cases, mut widened_cases, mut critical_cases) = (0, 0, 0, 0);
    for case in 0..400 {
        let n = 10 + rng.below(7);
        let names: Vec<String> = (0..n).map(|i| format!("C{i}")).collect();
        let positions: Vec<Vec<&str>> = (0..n)
            .map(|_| {
                let roles = 1 + rng.below(3);
                let mut picked: Vec<&str> = Vec::new();
                while picked.len() < roles {
                    let role = ROLE_NAMES[rng.below(5)];
                    if !picked.contains(&role) {
                        picked.push(role);
                    }
                }
                picked
            })
            .collect();
        let champions: Vec<(&str, &[&str])> = names
            .iter()
            .zip(&positions)
            .map(|(id, roles)| (id.as_str(), roles.as_slice()))
            .collect();
        let u = universe(&champions);
        let pool = |rng: &mut Lcg| -> ChampionSet {
            u.all().iter().filter(|_| rng.below(5) < 3).collect()
        };
        let list = Pools {
            blue: pool(&mut rng),
            red: pool(&mut rng),
            ..Pools::default()
        };
        let maps = list
            .with_roles(Side::Blue, RoleSets::meta_roles(list.blue, &u))
            .with_roles(Side::Red, RoleSets::meta_roles(list.red, &u));
        assert_eq!((maps.blue, maps.red), (list.blue, list.red));
        let blue_only = list.with_roles(Side::Blue, RoleSets::meta_roles(list.blue, &u));

        // A random line from the empty board: `apply` does not gate on the pools.
        let mut position = Position::new(&format, &[], &list, &u).unwrap_or_else(|e| panic!("{e}"));
        let stop = rng.below(20);
        while position.slot_index() < stop {
            let Some(slot) = position.next_slot() else {
                break;
            };
            let available: Vec<ChampionIdx> = position.available(&u).iter().collect();
            let needed = if slot.pair_start { 2 } else { 1 };
            if available.len() < needed {
                break;
            }
            let a = available[rng.below(available.len())];
            let action = match slot.action {
                ActionType::Ban => Action::Ban(a),
                ActionType::Pick if slot.pair_start => {
                    let rest: Vec<ChampionIdx> =
                        available.iter().copied().filter(|c| *c != a).collect();
                    Action::pair(a, rest[rng.below(rest.len())])
                }
                ActionType::Pick => Action::Pick(a),
            };
            position = position.apply(action);
        }

        for rule in LIVE {
            for side in [Side::Blue, Side::Red] {
                let ask = |pools: &Pools| {
                    let mut memo = FeasibilityMemo::default();
                    (
                        off_pool(&mut memo, rule, side, &position, pools, &u),
                        pool_can_complete(&mut memo, rule, side, &position, pools, &u),
                        side_feasible(&mut memo, rule, side, &position, pools, &u),
                        critical_pool(&mut memo, side, &position, pools, &u),
                    )
                };
                let expected = ask(&list);
                assert_eq!(ask(&maps), expected, "case {case} {rule:?} {side:?}");
                assert_eq!(
                    ask(&blue_only),
                    expected,
                    "case {case} {rule:?} {side:?} (mixed)"
                );
                forced_cases += usize::from(expected.0.forced > 0);
                critical_cases += usize::from(!expected.3.is_empty());
                broken_cases += usize::from(!locked_matchable(
                    &mut FeasibilityMemo::default(),
                    side,
                    position.picks(side),
                    None,
                    &u,
                ));
            }
            let fan = |pools: &Pools| {
                legal_actions_under(&position, &u, pools, rule, &mut FeasibilityMemo::default())
            };
            let actions = fan(&list);
            assert_eq!(fan(&maps), actions, "case {case} {rule:?}");
            assert_eq!(fan(&blue_only), actions, "case {case} {rule:?} (mixed)");
            if let Some(slot) = position.next_slot() {
                if slot.action == ActionType::Pick {
                    let pool_only = position.pick_actions_from(
                        position.available(&u).intersect(list.for_side(slot.side)),
                    );
                    widened_cases += usize::from(actions.len() > pool_only.len());
                    let charge = |pools: &Pools, action: Action| {
                        action_charge(
                            &mut FeasibilityMemo::default(),
                            rule,
                            slot.side,
                            &position,
                            pools,
                            &u,
                        )
                        .of(action)
                    };
                    // Every roster action, in or out of the pool.
                    for action in position.pick_actions_from(position.available(&u)) {
                        let expected = charge(&list, action);
                        assert_eq!(
                            charge(&maps, action),
                            expected,
                            "case {case} {rule:?} {action:?}"
                        );
                        assert_eq!(
                            charge(&blue_only, action),
                            expected,
                            "case {case} {action:?}"
                        );
                    }
                }
            }
        }
        // `off_pool_count` is the sum of the parts.
        assert_eq!(
            off_pool_count(
                &mut FeasibilityMemo::default(),
                FeasibilityRule::Roster,
                Side::Blue,
                &position,
                &maps,
                &u
            ),
            count(FeasibilityRule::Roster, Side::Blue, &position, &maps, &u).total()
        );
    }
    // The boards reach the cases the pricing turns on (printed once, then pinned as floors).
    assert!(forced_cases > 100, "forced {forced_cases}");
    assert!(broken_cases > 50, "broken {broken_cases}");
    assert!(widened_cases > 50, "widened {widened_cases}");
    assert!(critical_cases > 50, "critical {critical_cases}");
}

fn exact() -> SearchParams {
    search_params()
}

fn shortlisted(root_off_pool: usize, snipe_key: bool) -> SearchParams {
    SearchParams {
        shortlist: Some(Shortlist {
            singles: 5,
            pairs: 5,
            root_off_pool,
        }),
        snipe_key,
        ..search_params()
    }
}

fn roster_search(
    position: &Position<'_>,
    pools: &Pools,
    u: &Universe,
    params: &SearchParams,
    p: f64,
) -> SearchOutcome {
    search(
        &OracleInput {
            position,
            universe: u,
            pools,
            objective: u,
            feasibility: FeasibilityRule::Roster,
            mode: Mode::Horizon(1),
            epsilon: 1e-9,
            off_pool_cost: Some(p),
        },
        params,
        &CancelHandle::new(),
        |_| {},
    )
    .unwrap_or_else(|e| panic!("{e}"))
}

fn value_of(outcome: &SearchOutcome, u: &Universe, id: &str) -> f64 {
    outcome
        .ranked
        .iter()
        .find(|r| r.action == Action::Pick(idx(u, id)))
        .map(|r| r.value)
        .unwrap_or_else(|| panic!("{id} is not ranked"))
}

/// Design § 6 test 11 and the acceptance case in miniature: Blue needs an ADC, its pool lists `V`
/// for Middle only, and the roster's `A1` is a slightly better ADC (+0.05). With list pools V is "in-
/// pool" and free, so it wins. With role tags both cost P and the board decides: A1. The ordering key,
/// the root's in-pool / off-pool split and the leaf charge all agree.
#[test]
fn the_search_stops_preferring_the_off_role_fill_once_it_is_priced() {
    let (u, pools, entries) = off_role_probe_with(&[("A1", 0.05)]);
    let format = Format::standard();
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    let p = 0.1;
    let close = |a: f64, b: f64| (a - b).abs() < 1e-12;

    // List pools: V is in the set, free; A1 costs P and loses.
    let list = roster_search(&root, &as_list(&pools), &u, &exact(), p);
    assert_eq!(list.top_set, vec![Action::Pick(idx(&u, "V"))]);
    assert!(
        close(value_of(&list, &u, "V"), 0.0),
        "{}",
        value_of(&list, &u, "V")
    );
    assert!(close(value_of(&list, &u, "A1"), 0.05 - p));

    // Role tags: V at ADC is off-role and costs the same P; A1's 0.05 decides.
    let tagged = roster_search(&root, &pools, &u, &exact(), p);
    assert_eq!(tagged.top_set, vec![Action::Pick(idx(&u, "A1"))]);
    assert!(close(value_of(&tagged, &u, "A1"), 0.05 - p));
    assert!(close(value_of(&tagged, &u, "V"), -p));
    assert_eq!(
        tagged.root_fan, list.root_fan,
        "the roster rule fans to everything either way"
    );

    // No shortlist = the oracle, under tags as under lists: the same ranking, values bit for bit.
    for pools in [&pools, &as_list(&pools)] {
        let input = OracleInput {
            position: &root,
            universe: &u,
            pools,
            objective: &u,
            feasibility: FeasibilityRule::Roster,
            mode: Mode::Horizon(1),
            epsilon: 1e-9,
            off_pool_cost: Some(p),
        };
        let oracle = evaluate(&input).unwrap_or_else(|e| panic!("{e}"));
        let searched = roster_search(&root, pools, &u, &exact(), p);
        assert_eq!(
            searched
                .ranked
                .iter()
                .map(|r| (r.action, r.value.to_bits()))
                .collect::<Vec<_>>(),
            oracle
                .ranked
                .iter()
                .map(|r| (r.action, r.value.to_bits()))
                .collect::<Vec<_>>()
        );
        assert_eq!(searched.top_set, oracle.top_set);
    }

    // The root split under a shortlist: every in-pool action plus the best ONE off-pool. Tagged, no
    // action is in-pool (V is off-role), so the root is that one action — A1, by the key. As a list V
    // is in-pool and is kept beside it.
    let tagged = roster_search(&root, &pools, &u, &shortlisted(1, false), p);
    let ranked = |o: &SearchOutcome| -> Vec<Action> { o.ranked.iter().map(|r| r.action).collect() };
    assert_eq!(ranked(&tagged), vec![Action::Pick(idx(&u, "A1"))]);
    let list = roster_search(&root, &as_list(&pools), &u, &shortlisted(1, false), p);
    assert_eq!(
        ranked(&list),
        vec![Action::Pick(idx(&u, "V")), Action::Pick(idx(&u, "A1"))]
    );

    // The key itself: V sorts below A1 under tags and above it as a list (Blue: best first).
    let mut memo = FeasibilityMemo::default();
    let actions = vec![Action::Pick(idx(&u, "A1")), Action::Pick(idx(&u, "V"))];
    let order = |pools: &Pools, memo: &mut FeasibilityMemo| {
        let charge = action_charge(memo, FeasibilityRule::Roster, Side::Blue, &root, pools, &u);
        static_order(
            &u,
            &root,
            Side::Blue,
            actions.clone(),
            Some((charge, p)),
            None,
        )
    };
    assert_eq!(order(&pools, &mut memo), actions);
    assert_eq!(
        order(&as_list(&pools), &mut FeasibilityMemo::default()),
        vec![actions[1], actions[0]]
    );
}

/// Design § 6 tests 12 and 14: an action is charged whole. `X` is listed Top and Middle and can also
/// play Support. Beside X, a top alone is free (X goes Middle) and a mid alone is free (X goes Top) —
/// but the PAIR of them pushes X to Support, off-role: one charge, not the sum of two zeros. At a
/// mid-pair root the first half already on the board counts the same way.
#[test]
fn a_pair_is_charged_whole_and_a_mid_pair_root_counts_its_first_half() {
    let u = band(&[("X", &["Top", "Middle", "Support"])]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1", "X"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1", "X"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let rule = FeasibilityRule::Roster;
    let (t1, j1, m1) = (idx(&u, "T1"), idx(&u, "J1"), idx(&u, "M1"));

    // Blue holds X and starts its pair at slot 9.
    let entries = board(&format, &u, &["X"], &["T2", "J2"]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert!(root
        .next_slot()
        .is_some_and(|s| s.pair_start && s.side == Side::Blue));
    let mut memo = FeasibilityMemo::default();
    let charge = action_charge(&mut memo, rule, Side::Blue, &root, &pools, &u);
    assert_eq!(charge.of(Action::Pick(t1)), 0);
    assert_eq!(charge.of(Action::Pick(m1)), 0);
    assert_eq!(charge.of(Action::pair(t1, m1)), 1);
    assert_eq!(charge.of(Action::pair(t1, j1)), 0);
    // As a list the same pair is two pool champions: free.
    let list = as_list(&pools);
    let by_list = action_charge(&mut memo, rule, Side::Blue, &root, &list, &u);
    assert_eq!(by_list.of(Action::pair(t1, m1)), 0);

    // The key orders by it (every board value here is 0, so the key IS −P × the charge)...
    let actions = legal_actions_under(&root, &u, &pools, rule, &mut memo);
    let ordered = static_order(
        &u,
        &root,
        Side::Blue,
        actions.clone(),
        Some((charge, 0.1)),
        None,
    );
    let charges: Vec<usize> = ordered.iter().map(|a| charge.of(*a)).collect();
    assert!(charges.windows(2).all(|w| w[0] <= w[1]), "{charges:?}");
    let in_pool = charges.iter().filter(|c| **c == 0).count();
    assert!(in_pool > 0 && in_pool < ordered.len());
    // ...and the root keeps every in-pool pair plus one more — never the displacing pair as in-pool.
    let kept = root_shortlist(
        &root,
        Side::Blue,
        ordered.clone(),
        &charge,
        1,
        &mut Filter {
            rule,
            memo: &mut memo,
            universe: &u,
            pools: &pools,
        },
    );
    assert_eq!(kept.len(), in_pool + 1);
    assert_eq!(kept[..in_pool], ordered[..in_pool]);
    assert!(!kept[..in_pool].contains(&Action::pair(t1, m1)));

    // Mid-pair: T1 is the pair's first half, already on the board; M1 completes it and displaces X.
    let entries = board(&format, &u, &["X", "T1"], &["T2", "J2"]);
    let mid_pair = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert!(mid_pair.is_mid_pair());
    let charge = action_charge(&mut memo, rule, Side::Blue, &mid_pair, &pools, &u);
    assert_eq!(charge.of(Action::Pick(m1)), 1);
    assert_eq!(charge.of(Action::Pick(j1)), 0);
}

/// Design § 6 test 12, at an INTERIOR node: the search's own ordering charges a pair whole. Blue holds
/// `X` (listed Top and Middle, able to play Support); T1 and M1 are worth 0.25 each and nothing else is
/// worth anything. The root is Red's pair (Red, a list pool that can finish, stays inside it under
/// `pool_or_roster`), Blue's pair is one level down, and the shortlist keeps ONE pair there. T1 + M1 is
/// the best board (0.5) but pushes X to Support: charged, it sorts below every in-role pair, the pair
/// kept is worth 0.25, and that is the value. As a list the same pair is free and the value is 0.5.
#[test]
fn a_displacing_pair_is_ordered_below_in_role_pairs_at_an_interior_node() {
    let u = band_with(
        &[("X", &["Top", "Middle", "Support"])],
        &[("T1", 0.25), ("M1", 0.25)],
    );
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1", "X"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1", "X"]),
            (Role::Adc, &["A1"]),
            (Role::Support, &["S1"]),
        ],
    );
    let pools = Pools {
        red: set(&u, &["T2", "J2", "M2", "A2", "S2"]),
        ..Pools::default()
    }
    .with_roles(Side::Blue, blue);
    let entries = board(&format, &u, &["X"], &[]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert!(root
        .next_slot()
        .is_some_and(|s| s.pair_start && s.side == Side::Red));
    let run = |pools: &Pools| {
        search(
            &OracleInput {
                position: &root,
                universe: &u,
                pools,
                objective: &u,
                feasibility: FeasibilityRule::PoolOrRoster,
                mode: Mode::Horizon(2),
                epsilon: 1e-9,
                off_pool_cost: None,
            },
            &SearchParams {
                shortlist: Some(Shortlist {
                    singles: 1,
                    pairs: 1,
                    root_off_pool: 1,
                }),
                ..search_params()
            },
            &CancelHandle::new(),
            |_| {},
        )
        .unwrap_or_else(|e| panic!("{e}"))
    };
    let (t1, m1) = (idx(&u, "T1"), idx(&u, "M1"));
    let blue_reply = |o: &SearchOutcome| o.ranked[0].continuation[0];

    let tagged = run(&pools);
    assert_eq!(tagged.value, 0.25);
    let reply = blue_reply(&tagged);
    assert_ne!(reply, Action::pair(t1, m1));
    assert_eq!(
        reply.champions().filter(|c| *c == t1 || *c == m1).count(),
        1,
        "one of the two, with an in-role partner"
    );
    assert_eq!(tagged.ranked[0].ends.blue_off_pool, 0);

    let list = run(&as_list(&pools));
    assert_eq!(list.value, 0.5);
    assert_eq!(blue_reply(&list), Action::pair(t1, m1));
}

/// Design § 5 / § 6 test 18: the snipe-aware key's critical set under role tags is the champions
/// whose removal lowers the in-role weight. Red's only Adc listing is `A2`; `V2` is listed Middle and
/// could play Adc by the meta. As a set A2 is replaceable (V2 covers Adc), so it is not critical; in
/// role form it is — and the key, flag on, reaches it.
#[test]
fn the_critical_set_is_read_in_role_under_tags() {
    let u = band(&[("V2", &["Middle", "Adc"])]);
    let format = Format::standard();
    let red = tags(
        &u,
        &[
            (Role::Top, &["T2"]),
            (Role::Jungle, &["J2"]),
            (Role::Middle, &["M2", "V2"]),
            (Role::Adc, &["A2"]),
            (Role::Support, &["S2"]),
        ],
    );
    let pools = Pools {
        blue: set(&u, &["T1", "J1", "M1", "A1", "S1"]),
        ..Pools::default()
    }
    .with_roles(Side::Red, red);
    // Blue's first pick, slot 6: Red has all five picks to come.
    let entries = board(&format, &u, &[], &[]);
    let root = Position::new(&format, &entries, &pools, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!((root.slot_index(), root.mover()), (6, Some(Side::Blue)));

    let critical =
        |pools: &Pools| critical_pool(&mut FeasibilityMemo::default(), Side::Red, &root, pools, &u);
    assert_eq!(critical(&pools), set(&u, &["T2", "J2", "A2", "S2"]));
    assert_eq!(critical(&as_list(&pools)), set(&u, &["T2", "J2", "S2"]));

    // Flag on, the root's ordering takes the snipe term on one more child under tags (A2); flag off,
    // on none.
    let charged = |pools: &Pools, snipe_key: bool| {
        roster_search(&root, pools, &u, &shortlisted(3, snipe_key), 0.1).snipe_charged
    };
    assert_eq!(charged(&pools, true), 4);
    assert_eq!(charged(&as_list(&pools), true), 3);
    assert_eq!(charged(&pools, false), 0);
}

/// Design § 6 test 1 (b), interior nodes: on 60 random boards (as above) a search to depth 3 under a
/// narrow shortlist — so interior pick and pair nodes order, truncate and price — gives the same
/// outcome over list pools and over the same pools as maps of every meta role, under both live rules,
/// snipe key off and on: ranked actions, values bit for bit, continuations, endings, top set, root
/// fan and every counter; a refused root is refused alike.
#[test]
fn a_map_of_every_meta_role_searches_as_the_list_on_random_boards() {
    let format = Format::standard();
    let mut rng = Lcg(77_261_001);
    let (mut searched, mut interior_picks) = (0, 0u64);
    for case in 0..60 {
        // Twenty slots need twenty champions; a few to spare.
        let n = 20 + rng.below(4);
        let names: Vec<String> = (0..n).map(|i| format!("C{i}")).collect();
        let rows: Vec<(Vec<&str>, f64)> = (0..n)
            .map(|_| {
                let roles = 1 + rng.below(3);
                let mut picked: Vec<&str> = Vec::new();
                while picked.len() < roles {
                    let role = ROLE_NAMES[rng.below(5)];
                    if !picked.contains(&role) {
                        picked.push(role);
                    }
                }
                // Dyadic linear terms: sums are exact, so equal boards tie bit for bit.
                (
                    picked,
                    f64::from(u8::try_from(rng.below(9)).unwrap_or(0)) / 8.0,
                )
            })
            .collect();
        let champions: Vec<(&str, &[&str], f64)> = names
            .iter()
            .zip(&rows)
            .map(|(id, (roles, linear))| (id.as_str(), roles.as_slice(), *linear))
            .collect();
        let u = valued_universe(&champions);
        let pool = |rng: &mut Lcg| -> ChampionSet {
            u.all().iter().filter(|_| rng.below(5) < 3).collect()
        };
        let list = Pools {
            blue: pool(&mut rng),
            red: pool(&mut rng),
            ..Pools::default()
        };
        let maps = list
            .with_roles(Side::Blue, RoleSets::meta_roles(list.blue, &u))
            .with_roles(Side::Red, RoleSets::meta_roles(list.red, &u));
        let mut position = Position::new(&format, &[], &list, &u).unwrap_or_else(|e| panic!("{e}"));
        // Stop where three turns reach picks: in the first pick phase, or at the second one.
        let stop = if rng.below(2) == 0 {
            6 + rng.below(6)
        } else {
            16 + rng.below(3)
        };
        while position.slot_index() < stop {
            let Some(slot) = position.next_slot() else {
                break;
            };
            let available: Vec<ChampionIdx> = position.available(&u).iter().collect();
            if available.len() < 2 {
                break;
            }
            let a = available[rng.below(available.len())];
            let action = match slot.action {
                ActionType::Ban => Action::Ban(a),
                ActionType::Pick if slot.pair_start => {
                    let rest: Vec<ChampionIdx> =
                        available.iter().copied().filter(|c| *c != a).collect();
                    Action::pair(a, rest[rng.below(rest.len())])
                }
                ActionType::Pick => Action::Pick(a),
            };
            position = position.apply(action);
        }
        for (rule, p) in [
            (FeasibilityRule::PoolOrRoster, None),
            (FeasibilityRule::Roster, Some(0.125)),
        ] {
            for snipe_key in [false, true] {
                let params = SearchParams {
                    shortlist: Some(Shortlist {
                        singles: 3,
                        pairs: 4,
                        root_off_pool: 2,
                    }),
                    snipe_key,
                    ..search_params()
                };
                let run = |pools: &Pools| {
                    search(
                        &OracleInput {
                            position: &position,
                            universe: &u,
                            pools,
                            objective: &u,
                            feasibility: rule,
                            mode: Mode::Horizon(3),
                            epsilon: 1e-9,
                            off_pool_cost: p,
                        },
                        &params,
                        &CancelHandle::new(),
                        |_| {},
                    )
                    .map(|o| {
                        (
                            o.ranked
                                .iter()
                                .map(|r| {
                                    (r.action, r.value.to_bits(), r.continuation.clone(), r.ends)
                                })
                                .collect::<Vec<_>>(),
                            o.top_set.clone(),
                            (o.root_fan, o.depth, o.partial, o.value.to_bits()),
                            (o.nodes, o.leaves, o.orderings, o.cutoffs, o.table_hits),
                            o.snipe_charged,
                        )
                    })
                    .map_err(|e| format!("{e:?}"))
                };
                let expected = run(&list);
                assert_eq!(
                    run(&maps),
                    expected,
                    "case {case} {rule:?} snipe_key {snipe_key}"
                );
                if let Ok(outcome) = &expected {
                    searched += 1;
                    interior_picks += outcome.3 .2;
                }
            }
        }
    }
    // Most boards search, and the searches order children (the key is exercised below the root).
    assert!(searched >= 200, "searched {searched}");
    assert!(interior_picks > 50_000, "orderings {interior_picks}");
}

/// Design § 4 / § 6 test 15: Tier A takes list form only. A role map in a fixture is refused by shape
/// with the D4 message — a malformed map too, before anything in it is read.
#[test]
fn a_tier_a_fixture_refuses_a_role_map() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/tier-a/01-pair-completion.json");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{e}"));
    assert!(Fixture::from_json(&raw, "01").is_ok());
    let refused = |side: &str, map: serde_json::Value| {
        let mut file: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{e}"));
        file["pools"][side] = map;
        match Fixture::from_json(&file.to_string(), "01") {
            Err(FixtureError::Invalid { field, reason, .. }) => (field, reason),
            other => panic!("expected Invalid, got {:?}", other.map(|f| f.id)),
        }
    };
    let well_formed =
        serde_json::json!({"top": [], "jungle": [], "mid": [], "adc": [], "support": []});
    for (side, map) in [
        ("blue", well_formed.clone()),
        ("red", well_formed),
        ("blue", serde_json::json!({"bottom": ["nobody"]})),
    ] {
        let (field, reason) = refused(side, map);
        assert_eq!(field, format!("pools.{side}"));
        assert!(
            reason.contains("Tier A") && reason.contains("list form") && reason.contains("D4"),
            "{reason}"
        );
    }
}

/// Design § 1 / § 6 test 13: the two sides are read independently. Both sides hold top, jungle, mid
/// and support and need an ADC; each pool's only candidate is a champion listed Middle that the meta
/// lets play Adc. A side whose pool is a role map is forced off-pool once; a side whose pool is a list
/// is not — whatever the other side's form — and the search prices exactly that.
#[test]
fn a_tagged_side_and_a_list_side_are_read_independently() {
    let u = band(&[("V", &["Middle", "Adc"]), ("W", &["Middle", "Adc"])]);
    let format = Format::standard();
    let blue = tags(
        &u,
        &[
            (Role::Top, &["T1"]),
            (Role::Jungle, &["J1"]),
            (Role::Middle, &["M1", "V"]),
            (Role::Support, &["S1"]),
        ],
    );
    let red = tags(
        &u,
        &[
            (Role::Top, &["T2"]),
            (Role::Jungle, &["J2"]),
            (Role::Middle, &["M2", "W"]),
            (Role::Support, &["S2"]),
        ],
    );
    let both = Pools::default()
        .with_roles(Side::Blue, blue)
        .with_roles(Side::Red, red);
    let neither = as_list(&both);
    let blue_only = neither.with_roles(Side::Blue, blue);
    let red_only = neither.with_roles(Side::Red, red);
    let entries = board(
        &format,
        &u,
        &["T1", "J1", "M1", "S1"],
        &["T2", "J2", "M2", "S2"],
    );
    let root = Position::new(&format, &entries, &both, &u).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!((root.slot_index(), root.mover()), (18, Some(Side::Blue)));

    for rule in LIVE {
        let forced = |pools: &Pools, side: Side| count(rule, side, &root, pools, &u).forced;
        // (pools, Blue forced, Red forced)
        for (pools, blue_forced, red_forced) in [
            (&both, 1, 1),
            (&blue_only, 1, 0),
            (&red_only, 0, 1),
            (&neither, 0, 0),
        ] {
            assert_eq!(forced(pools, Side::Blue), blue_forced, "{rule:?} Blue");
            assert_eq!(forced(pools, Side::Red), red_forced, "{rule:?} Red");
        }
    }

    // End to end under `roster` at P = 0.125, two turns (Blue's last pick, Red's last pick), every
    // board value 0: a line's value is P × (Red's off-pool picks − Blue's). Blue taking its own `V`:
    let outcome = |pools: &Pools| {
        search(
            &OracleInput {
                position: &root,
                universe: &u,
                pools,
                objective: &u,
                feasibility: FeasibilityRule::Roster,
                mode: Mode::Horizon(2),
                epsilon: 1e-9,
                off_pool_cost: Some(0.125),
            },
            &exact(),
            &CancelHandle::new(),
            |_| {},
        )
        .unwrap_or_else(|e| panic!("{e}"))
    };
    // Both maps: Blue pays for V at ADC, Red pays for its own fill — even.
    assert_eq!(value_of(&outcome(&both), &u, "V"), 0.0);
    // Blue a map, Red a list: Blue pays, Red's W is free.
    assert_eq!(value_of(&outcome(&blue_only), &u, "V"), -0.125);
    // Blue a list, Red a map: V is free for Blue, Red pays.
    assert_eq!(value_of(&outcome(&red_only), &u, "V"), 0.125);
    // Both lists: nobody pays.
    assert_eq!(value_of(&outcome(&neither), &u, "V"), 0.0);
    // (With Blue a map and Red a list, Blue's best move is not V: taking W — Red's one ADC — costs
    // Blue the same P and makes Red pay it back, the P-neutral snipe of D4.)
    let sniped = outcome(&blue_only);
    assert_eq!(sniped.top_set, vec![Action::Pick(idx(&u, "W"))]);
    assert_eq!(sniped.value, 0.0);
}
