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
        position_shares: Vec::new(),
        playable: Vec::new(),
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

// --- champion-role-shares slice B (design § 6): coverage reads the share ratio -------------------

fn meta_from_shared(entries: &[(&str, Vec<Role>, [f64; 5])]) -> HashMap<String, ChampionMeta> {
    entries
        .iter()
        .map(|(id, positions, shares)| {
            let mut m = champ(id, positions.clone());
            m.position_shares = shares.to_vec();
            ((*id).into(), m)
        })
        .collect()
}

#[test]
fn per_role_max_factors_reads_the_share_ratio_and_keeps_the_0_01_floor() {
    // Sylas-shaped: MIDDLE 0.6 (the largest), TOP 0.3, SUPPORT 0.079, JUNGLE 0.02, BOTTOM 0.001.
    // Coverage reads the ratio per role but never below its own 0.01 floor (a floor ABOVE ε / max:
    // the open-role term is 0.01 whatever ε is, so a never-played role reads 0.01, not 0.0017).
    let m = meta_from_shared(&[(
        "Sylas",
        vec![Role::Middle, Role::Top],
        [0.3, 0.02, 0.6, 0.001, 0.079],
    )]);
    let picks = vec!["Sylas".to_string()];
    let f = per_role_max_factors(&picks, &m);
    assert_eq!(f[0], 0.3_f64 / 0.6); // TOP: a listed secondary reads 0.5, not 0.4
    assert_eq!(f[1], 0.02_f64 / 0.6); // JUNGLE: an unlisted 2% role reads 0.033, not 0.01
    assert_eq!(f[2], 1.0);
    assert_eq!(f[3], 0.01); // BOTTOM: 0.001 / 0.6 = 0.0017 sits under the floor
    assert_eq!(f[4], 0.079_f64 / 0.6);
}

#[test]
fn missing_roles_at_0_9_names_the_roles_no_pick_is_within_ten_percent_of_its_best_in() {
    // Ekko-shaped: JUNGLE at 0.909 of his MIDDLE share is NOT missing at 0.9 — the thresholded step
    // the design names (five champions count for two roles at once); at 0.89 it is. Under the
    // category factors a secondary read 0.4 and was missing either way.
    let picks = vec!["Ekko".to_string()];
    let within = meta_from_shared(&[(
        "Ekko",
        vec![Role::Middle, Role::Jungle],
        [0.001, 0.4545, 0.5, 0.0, 0.0],
    )]);
    assert_eq!(
        missing_roles(&picks, &within, 0.9),
        vec![Role::Top, Role::Adc, Role::Support]
    );
    let below = meta_from_shared(&[(
        "Ekko",
        vec![Role::Middle, Role::Jungle],
        [0.001, 0.445, 0.5, 0.0, 0.0],
    )]);
    assert_eq!(
        missing_roles(&picks, &below, 0.9),
        vec![Role::Top, Role::Jungle, Role::Adc, Role::Support]
    );
}

#[test]
fn coverage_score_over_shares_is_the_geometric_mean_of_the_floored_ratios() {
    // Pantheon alone covers TOP at 1.0 and SUPPORT at 0.959 (flex double-cover, design § 6),
    // JUNGLE at 0.255, MIDDLE at 0.128 and BOTTOM at the floor.
    let m = meta_from_shared(&[(
        "Pantheon",
        vec![Role::Top, Role::Support],
        [0.392, 0.1, 0.05, 0.0, 0.376],
    )]);
    let picks = vec!["Pantheon".to_string()];
    let expected = (1.0_f64 * (0.1 / 0.392) * (0.05 / 0.392) * 0.01 * (0.376 / 0.392)).powf(0.2);
    assert!((coverage_score(&picks, &m) - expected).abs() < 1e-12);
}
