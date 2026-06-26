use engine_core::coverage::{
    coverage_marginal_gain, coverage_score, missing_roles, per_role_max_factors,
};
use engine_core::pools::Role;
use engine_core::role_solver::{
    CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
};
use std::collections::HashMap;

fn champ(id: &str, positions: Vec<Role>) -> ChampionMeta {
    ChampionMeta {
        id: id.into(),
        positions,
        damage_profile: DamageProfile::default(),
        scaling_profile: ScalingProfile::default(),
        cc_profile: CcProfile::default(),
        tags: ChampionTags::default(),
    }
}

fn meta_from(entries: &[(&str, &[Role])]) -> HashMap<String, ChampionMeta> {
    entries
        .iter()
        .map(|(id, p)| ((*id).into(), champ(id, p.to_vec())))
        .collect()
}

#[test]
fn per_role_max_factors_full_5_unique_primaries() {
    let m = meta_from(&[
        ("T", &[Role::Top]),
        ("J", &[Role::Jungle]),
        ("M", &[Role::Middle]),
        ("A", &[Role::Adc]),
        ("S", &[Role::Support]),
    ]);
    let picks: Vec<String> = ["T", "J", "M", "A", "S"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    assert_eq!(
        per_role_max_factors(&picks, &m),
        [1.0, 1.0, 1.0, 1.0, 1.0]
    );
}

#[test]
fn per_role_max_factors_missing_role_returns_001() {
    let m = meta_from(&[("MidA", &[Role::Middle])]);
    let picks = vec!["MidA".to_string()];
    let f = per_role_max_factors(&picks, &m);
    assert_eq!(f[0], 0.01);
    assert_eq!(f[1], 0.01);
    assert_eq!(f[2], 1.0);
    assert_eq!(f[3], 0.01);
    assert_eq!(f[4], 0.01);
}

#[test]
fn per_role_max_factors_secondary_yields_04() {
    let m = meta_from(&[("Heimer", &[Role::Middle, Role::Support, Role::Top])]);
    let picks = vec!["Heimer".to_string()];
    let f = per_role_max_factors(&picks, &m);
    assert_eq!(f[0], 0.4); // TOP secondary
    assert_eq!(f[1], 0.01); // JG not listed
    assert_eq!(f[2], 1.0); // MID primary
    assert_eq!(f[3], 0.01);
    assert_eq!(f[4], 0.4); // SUP secondary
}

#[test]
fn per_role_max_factors_takes_max_across_picks() {
    let m = meta_from(&[
        ("Lucian", &[Role::Adc, Role::Middle]),
        ("Yasuo", &[Role::Middle]),
    ]);
    let picks: Vec<String> = ["Lucian", "Yasuo"].iter().map(|s| (*s).into()).collect();
    let f = per_role_max_factors(&picks, &m);
    assert_eq!(f[2], 1.0); // MID — Yasuo primary beats Lucian secondary
    assert_eq!(f[3], 1.0); // ADC — Lucian primary
}

#[test]
fn per_role_max_factors_empty_picks_all_001() {
    let m: HashMap<String, ChampionMeta> = HashMap::new();
    let picks: Vec<String> = vec![];
    assert_eq!(per_role_max_factors(&picks, &m), [0.01; 5]);
}

#[test]
fn per_role_max_factors_unknown_pick_treated_as_no_signal() {
    let m: HashMap<String, ChampionMeta> = HashMap::new();
    let picks = vec!["UnknownChamp".to_string()];
    assert_eq!(per_role_max_factors(&picks, &m), [0.01; 5]);
}

#[test]
fn coverage_score_full_5_unique_primaries_is_one() {
    let m = meta_from(&[
        ("T", &[Role::Top]),
        ("J", &[Role::Jungle]),
        ("M", &[Role::Middle]),
        ("A", &[Role::Adc]),
        ("S", &[Role::Support]),
    ]);
    let picks: Vec<String> = ["T", "J", "M", "A", "S"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    assert!((coverage_score(&picks, &m) - 1.0).abs() < 1e-9);
}

#[test]
fn coverage_score_one_missing_role_about_0_398() {
    // 4 unique primaries; ADC is the missing role at 0.01.
    let m = meta_from(&[
        ("T", &[Role::Top]),
        ("J", &[Role::Jungle]),
        ("M", &[Role::Middle]),
        ("S", &[Role::Support]),
    ]);
    let picks: Vec<String> = ["T", "J", "M", "S"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    assert!((coverage_score(&picks, &m) - 0.398107170553_f64).abs() < 1e-6);
}

#[test]
fn coverage_score_two_missing_roles_about_0_158() {
    // The bug case: 3 picks (TOP/JG/MID), missing ADC and SUP.
    let m = meta_from(&[
        ("Garen", &[Role::Top]),
        ("Amumu", &[Role::Jungle]),
        ("Aurelion", &[Role::Middle]),
    ]);
    let picks: Vec<String> = ["Garen", "Amumu", "Aurelion"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    assert!((coverage_score(&picks, &m) - 0.158489319246_f64).abs() < 1e-6);
}

#[test]
fn coverage_score_empty_picks_minimum_value() {
    let m: HashMap<String, ChampionMeta> = HashMap::new();
    let picks: Vec<String> = vec![];
    assert!((coverage_score(&picks, &m) - 0.01).abs() < 1e-9);
}

#[test]
fn coverage_marginal_gain_redundant_pick_is_zero() {
    // Garen+Amumu+Aurelion. Adding Annie (another MID) gains nothing.
    let m = meta_from(&[
        ("Garen", &[Role::Top]),
        ("Amumu", &[Role::Jungle]),
        ("Aurelion", &[Role::Middle]),
        ("Annie", &[Role::Middle]),
    ]);
    let picks: Vec<String> = ["Garen", "Amumu", "Aurelion"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    let gain = coverage_marginal_gain(&picks, "Annie", &m);
    assert!(gain.abs() < 1e-9);
}

#[test]
fn coverage_marginal_gain_filling_role_increases_score() {
    // Same comp; add Jinx (ADC). 0.158 -> 0.398, gain ~ 0.24.
    let m = meta_from(&[
        ("Garen", &[Role::Top]),
        ("Amumu", &[Role::Jungle]),
        ("Aurelion", &[Role::Middle]),
        ("Jinx", &[Role::Adc]),
    ]);
    let picks: Vec<String> = ["Garen", "Amumu", "Aurelion"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    let gain = coverage_marginal_gain(&picks, "Jinx", &m);
    assert!(gain > 0.23 && gain < 0.25, "expected ~0.24, got {}", gain);
}

#[test]
fn missing_roles_strict_threshold_catches_partial_coverage() {
    let m = meta_from(&[
        ("Lucian", &[Role::Adc, Role::Middle]),
        ("Nami", &[Role::Support]),
        ("Jarvan", &[Role::Jungle]),
    ]);
    let picks: Vec<String> = ["Lucian", "Nami", "Jarvan"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    // < 0.9: TOP at 0.01 and MID at 0.4 are both missing
    assert_eq!(
        missing_roles(&picks, &m, 0.9),
        vec![Role::Top, Role::Middle]
    );
}

#[test]
fn missing_roles_loose_threshold_only_catches_uncovered() {
    let m = meta_from(&[
        ("Lucian", &[Role::Adc, Role::Middle]),
        ("Nami", &[Role::Support]),
        ("Jarvan", &[Role::Jungle]),
    ]);
    let picks: Vec<String> = ["Lucian", "Nami", "Jarvan"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    // < 0.4: only TOP (0.01) is missing; MID (0.4) is not strictly less than 0.4
    assert_eq!(missing_roles(&picks, &m, 0.4), vec![Role::Top]);
}

#[test]
fn missing_roles_full_comp_returns_empty() {
    let m = meta_from(&[
        ("T", &[Role::Top]),
        ("J", &[Role::Jungle]),
        ("M", &[Role::Middle]),
        ("A", &[Role::Adc]),
        ("S", &[Role::Support]),
    ]);
    let picks: Vec<String> = ["T", "J", "M", "A", "S"]
        .iter()
        .map(|s| (*s).into())
        .collect();
    assert!(missing_roles(&picks, &m, 0.9).is_empty());
}
