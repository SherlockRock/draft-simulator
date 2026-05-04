use engine_core::feasibility::can_complete_roles;
use engine_core::pools::Role;
use engine_core::role_solver::ChampionMeta;
use std::collections::HashMap;

fn meta_with(positions: &[(&str, Vec<Role>)]) -> HashMap<String, ChampionMeta> {
    let mut m = HashMap::new();
    for (name, roles) in positions {
        m.insert(name.to_string(), ChampionMeta {
            id: name.to_string(),
            positions: roles.clone(),
            ..Default::default()
        });
    }
    m
}

#[test]
fn empty_locked_with_5_pool_one_per_role_is_feasible() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
        ("Jinx", vec![Role::Adc]),
        ("Sona", vec![Role::Support]),
    ]);
    let pool: Vec<String> = meta.keys().cloned().collect();
    let locked: Vec<String> = vec![];
    assert!(can_complete_roles(&locked, &pool, 5, &meta));
}

#[test]
fn three_locked_two_remaining_two_uncovered_with_specialists_is_feasible() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
        ("Jinx", vec![Role::Adc]),
        ("Sona", vec![Role::Support]),
    ]);
    let locked = vec!["Garen".to_string(), "LeeSin".to_string(), "Ahri".to_string()];
    let pool = vec!["Jinx".to_string(), "Sona".to_string()];
    assert!(can_complete_roles(&locked, &pool, 2, &meta));
}

#[test]
fn three_locked_two_remaining_pool_only_covers_one_uncovered_is_infeasible() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
        ("Jinx", vec![Role::Adc]),
        ("Caitlyn", vec![Role::Adc]),
    ]);
    let locked = vec!["Garen".to_string(), "LeeSin".to_string(), "Ahri".to_string()];
    let pool = vec!["Jinx".to_string(), "Caitlyn".to_string()];
    assert!(!can_complete_roles(&locked, &pool, 2, &meta));
}

#[test]
fn uncovered_count_exceeds_remaining_is_infeasible() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
    ]);
    let locked = vec!["Garen".to_string(), "LeeSin".to_string()];
    let pool: Vec<String> = vec![];
    assert!(!can_complete_roles(&locked, &pool, 2, &meta));
}

#[test]
fn flex_champion_satisfies_either_role() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
        ("Pyke", vec![Role::Support, Role::Middle]),
        ("Jinx", vec![Role::Adc]),
    ]);
    let locked = vec!["Garen".to_string(), "LeeSin".to_string(), "Ahri".to_string()];
    let pool = vec!["Pyke".to_string(), "Jinx".to_string()];
    assert!(can_complete_roles(&locked, &pool, 2, &meta));
}

#[test]
fn locked_flex_does_not_double_cover() {
    // REGRESSION TEST for the union-of-masks unsoundness.
    let meta = meta_with(&[
        ("Yasuo", vec![Role::Top, Role::Middle]),
        ("LeeSin", vec![Role::Jungle]),
        ("Jinx", vec![Role::Adc]),
        ("Sona", vec![Role::Support]),
    ]);
    let locked = vec![
        "Yasuo".to_string(),
        "LeeSin".to_string(),
        "Jinx".to_string(),
        "Sona".to_string(),
    ];
    let pool: Vec<String> = vec![];
    assert!(!can_complete_roles(&locked, &pool, 1, &meta));

    let meta2 = meta_with(&[
        ("Yasuo", vec![Role::Top, Role::Middle]),
        ("LeeSin", vec![Role::Jungle]),
        ("Jinx", vec![Role::Adc]),
        ("Sona", vec![Role::Support]),
        ("Garen", vec![Role::Top]),
    ]);
    let locked2 = vec!["Yasuo".to_string(), "LeeSin".to_string(), "Jinx".to_string(), "Sona".to_string()];
    let pool2 = vec!["Garen".to_string()];
    assert!(can_complete_roles(&locked2, &pool2, 1, &meta2));
}

#[test]
fn three_supports_in_pool_two_uncovered_adc_sup_is_infeasible() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
        ("Sona", vec![Role::Support]),
        ("Lulu", vec![Role::Support]),
        ("Janna", vec![Role::Support]),
    ]);
    let locked = vec!["Garen".to_string(), "LeeSin".to_string(), "Ahri".to_string()];
    let pool = vec!["Sona".to_string(), "Lulu".to_string(), "Janna".to_string()];
    assert!(!can_complete_roles(&locked, &pool, 2, &meta));
}

#[test]
fn champion_in_pool_not_in_meta_is_treated_as_unplayable() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
        ("Jinx", vec![Role::Adc]),
    ]);
    let locked = vec!["Garen".to_string(), "LeeSin".to_string(), "Ahri".to_string(), "Jinx".to_string()];
    let pool = vec!["UnknownChamp".to_string()];
    assert!(!can_complete_roles(&locked, &pool, 1, &meta));
}

#[test]
fn locked_picks_preserved_in_matching() {
    let meta = meta_with(&[
        ("Sona", vec![Role::Support]),
        ("Yasuo", vec![Role::Top, Role::Middle]),
        ("LeeSin", vec![Role::Jungle]),
        ("Jinx", vec![Role::Adc]),
        ("Garen", vec![Role::Top]),
    ]);
    let locked = vec!["Sona".to_string()];
    let pool = vec!["Yasuo".to_string(), "LeeSin".to_string(), "Jinx".to_string(), "Garen".to_string()];
    assert!(can_complete_roles(&locked, &pool, 4, &meta));
}
