//! The live universe and the converter (slice-5 design § 9): parity with the FM's structural logit
//! against the Python-exported fixtures, the marginal identity, the set widening, canonical order,
//! the converter on a real session state, and the live-side pruning-soundness check.

use engine_core::pools::Role;
use engine_core::reference::universe::{
    Champion, ChampionIdx, ChampionSet, Universe, UniverseError, MAX_CHAMPIONS,
};
use proptest::prelude::*;
use std::collections::HashSet;

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
