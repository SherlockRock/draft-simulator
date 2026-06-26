use engine_core::pools::{ban_multiplier, pool_multiplier, Penalties, PoolTier, Role, RolePoolMap, TeamPool};

fn pool() -> TeamPool {
    TeamPool {
        display: RolePoolMap {
            top: vec!["Aatrox".into()],
            jungle: vec!["Vi".into()],
            middle: vec!["Ahri".into()],
            adc: vec!["Jinx".into()],
            support: vec!["Nautilus".into()],
        },
        search: vec![
            "Aatrox".into(),
            "Vi".into(),
            "Ahri".into(),
            "Jinx".into(),
            "Nautilus".into(),
            "Yone".into(),
        ],
    }
}

#[test]
fn in_pool_in_role_no_penalty() {
    let p = pool();
    let pen = Penalties { out_of_role: 0.25, out_of_pool: 0.75 };
    let (mult, tier) = pool_multiplier("Aatrox", Role::Top, &p, &pen);
    assert_eq!(tier, PoolTier::InPoolInRole);
    assert!((mult - 1.0).abs() < 1e-9);
}

#[test]
fn in_pool_out_of_role_penalty() {
    let p = pool();
    let pen = Penalties { out_of_role: 0.25, out_of_pool: 0.75 };
    // Yone is in search but not in any display role
    let (mult, tier) = pool_multiplier("Yone", Role::Top, &p, &pen);
    assert_eq!(tier, PoolTier::InPoolOutOfRole);
    assert!((mult - 0.75).abs() < 1e-9);
}

#[test]
fn out_of_pool_heavy_penalty() {
    let p = pool();
    let pen = Penalties { out_of_role: 0.25, out_of_pool: 0.75 };
    let (mult, tier) = pool_multiplier("RandomChamp", Role::Top, &p, &pen);
    assert_eq!(tier, PoolTier::OutOfPool);
    assert!((mult - 0.25).abs() < 1e-9);
}

#[test]
fn ban_evaluation_skips_pool_penalty() {
    let p = pool();
    let pen = Penalties { out_of_role: 0.25, out_of_pool: 0.75 };
    assert!((ban_multiplier("RandomChamp", &p, &pen) - 1.0).abs() < 1e-9);
}
