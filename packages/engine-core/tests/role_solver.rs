use engine_core::pools::Role;
use engine_core::role_solver::{solve, ChampionMeta};
use std::collections::HashMap;

fn champ(id: &str, primary: Role, secondary: Option<Role>) -> ChampionMeta {
    let mut positions = vec![primary];
    if let Some(sec) = secondary {
        positions.push(sec);
    }
    ChampionMeta {
        id: id.into(),
        positions,
        ..Default::default()
    }
}

fn meta_with(positions: &[(&str, Vec<Role>)]) -> HashMap<String, ChampionMeta> {
    let mut m = HashMap::new();
    for (name, roles) in positions {
        m.insert(
            name.to_string(),
            ChampionMeta {
                id: name.to_string(),
                positions: roles.clone(),
                ..Default::default()
            },
        );
    }
    m
}

fn meta() -> HashMap<String, ChampionMeta> {
    let mut m = HashMap::new();
    m.insert("Aatrox".into(), champ("Aatrox", Role::Top, None));
    m.insert("Vi".into(), champ("Vi", Role::Jungle, None));
    m.insert("Ahri".into(), champ("Ahri", Role::Middle, None));
    m.insert("Jinx".into(), champ("Jinx", Role::Adc, None));
    m.insert("Nautilus".into(), champ("Nautilus", Role::Support, None));
    m.insert("Yone".into(), champ("Yone", Role::Middle, Some(Role::Top))); // flex
    m
}

#[test]
fn weights_sum_to_one() {
    let m = meta();
    let assignments = solve(&["Aatrox", "Vi", "Ahri", "Jinx", "Nautilus"], &m);
    let total: f64 = assignments.iter().map(|a| a.weight).sum();
    assert!((total - 1.0).abs() < 1e-6, "weights must sum to 1, got {}", total);
}

#[test]
fn primary_position_outranks_secondary() {
    let m = meta();
    // Yone has primary MID, secondary TOP. With Aatrox (primary TOP),
    // assignment "Yone TOP, Aatrox MID(?)" should weight much less than
    // "Aatrox TOP, Yone MID."
    let assignments = solve(&["Yone", "Aatrox", "Vi", "Jinx", "Nautilus"], &m);
    let yone_top = assignments.iter().find(|a| a.assignment.top == "Yone").unwrap();
    let yone_mid = assignments.iter().find(|a| a.assignment.middle == "Yone").unwrap();
    assert!(
        yone_mid.weight > yone_top.weight * 2.0,
        "Yone-mid (primary) must dominate Yone-top (secondary): mid={}, top={}",
        yone_mid.weight,
        yone_top.weight
    );
}

#[test]
fn fake_flex_near_zero() {
    let m = meta();
    // Jinx as jungle (no position match) should have near-zero weight when
    // the team has Vi as a real jungle option. Verify by checking that ALL
    // assignments where Jinx is NOT ADC have near-zero combined weight.
    let assignments = solve(&["Aatrox", "Vi", "Ahri", "Jinx", "Nautilus"], &m);
    let jinx_not_adc: f64 = assignments
        .iter()
        .filter(|a| a.assignment.adc != "Jinx")
        .map(|a| a.weight)
        .sum();
    assert!(
        jinx_not_adc < 0.01,
        "Jinx-as-not-ADC fake-flex must aggregate near zero: got {}",
        jinx_not_adc
    );
}

#[test]
fn solve_partial_4_champs_returns_120_assignments() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
        ("Jinx", vec![Role::Adc]),
    ]);
    let champs = vec!["Garen", "LeeSin", "Ahri", "Jinx"];
    let result = solve(&champs, &meta);
    assert_eq!(result.len(), 120, "P(5,4) = 120");
    let weight_sum: f64 = result.iter().map(|wa| wa.weight).sum();
    assert!((weight_sum - 1.0).abs() < 0.01, "weights sum to ~1");
    for wa in &result {
        let filled = [
            !wa.assignment.top.is_empty(),
            !wa.assignment.jungle.is_empty(),
            !wa.assignment.middle.is_empty(),
            !wa.assignment.adc.is_empty(),
            !wa.assignment.support.is_empty(),
        ]
        .iter()
        .filter(|b| **b)
        .count();
        assert_eq!(filled, 4);
    }
}

#[test]
fn solve_partial_3_champs_returns_60_assignments() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
    ]);
    let champs = vec!["Garen", "LeeSin", "Ahri"];
    let result = solve(&champs, &meta);
    assert_eq!(result.len(), 60, "P(5,3) = 60");
}

#[test]
fn solve_partial_canonical_top_assignment_for_unique_primaries() {
    let meta = meta_with(&[
        ("Garen", vec![Role::Top]),
        ("LeeSin", vec![Role::Jungle]),
        ("Ahri", vec![Role::Middle]),
    ]);
    let champs = vec!["Garen", "LeeSin", "Ahri"];
    let mut result = solve(&champs, &meta);
    result.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap());
    let top = &result[0].assignment;
    assert_eq!(top.top, "Garen");
    assert_eq!(top.jungle, "LeeSin");
    assert_eq!(top.middle, "Ahri");
    assert_eq!(top.adc, "", "ADC empty when unfilled");
    assert_eq!(top.support, "", "SUP empty when unfilled");
}

#[test]
fn solve_empty_returns_empty() {
    let result = solve(&Vec::<&str>::new(), &HashMap::new());
    assert!(result.is_empty());
}

#[test]
fn solve_six_or_more_returns_empty() {
    let champs: Vec<&str> = vec!["A", "B", "C", "D", "E", "F"];
    let result = solve(&champs, &HashMap::new());
    assert!(result.is_empty());
}

// --- champion-role-shares slice B (design § 6, D8 / U3): the factor is the share ratio ----------

use engine_core::role_solver::{position_factor, RoleAssignment, SHARE_EPSILON};

/// A champion with five shares aligned with `ROLES` (Top, Jungle, Middle, Adc, Support).
fn shared(id: &str, positions: Vec<Role>, shares: [f64; 5]) -> ChampionMeta {
    ChampionMeta {
        id: id.into(),
        positions,
        position_shares: shares.to_vec(),
        ..Default::default()
    }
}

/// The index into `ROLES` of the role `id` is seated in.
fn seat(a: &RoleAssignment, id: &str) -> usize {
    [&a.top, &a.jungle, &a.middle, &a.adc, &a.support]
        .iter()
        .position(|s| s.as_str() == id)
        .expect("every champion is seated")
}

#[test]
fn the_factor_is_the_share_over_the_largest_share_floored_at_epsilon_for_every_role() {
    // Pantheon on 16.19: TOP 0.392 / SUPPORT 0.376 (the near-tie that flipped a primary), JUNGLE
    // 0.1, MIDDLE 0.05, BOTTOM 0 — listed TOP and SUPPORT. One max, one division (the TypeScript
    // port computes it in the same order, so the parity snapshots agree bit for bit).
    let p = shared(
        "Pantheon",
        vec![Role::Top, Role::Support],
        [0.392, 0.1, 0.05, 0.0, 0.376],
    );
    assert_eq!(SHARE_EPSILON, 0.001);
    assert_eq!(position_factor(Role::Top, &p), 1.0);
    assert_eq!(
        position_factor(Role::Support, &p),
        0.376_f64.max(SHARE_EPSILON) / 0.392
    );
    assert_eq!(
        position_factor(Role::Jungle, &p),
        0.1_f64.max(SHARE_EPSILON) / 0.392
    );
    // An UNLISTED role reads its ratio too, never a category: MIDDLE at 5% weighs 0.128 ...
    assert_eq!(
        position_factor(Role::Middle, &p),
        0.05_f64.max(SHARE_EPSILON) / 0.392
    );
    // ... and a never-played role weighs ε / max — a quarter of today's 0.01 here, never 0.
    assert_eq!(position_factor(Role::Adc, &p), SHARE_EPSILON / 0.392);
    assert!(position_factor(Role::Adc, &p) > 0.0);
}

#[test]
fn the_denominator_is_the_largest_share_not_the_first_listed_position() {
    // An override may reorder `positions` (design § 4.1): SUPPORT listed first, TOP's share larger.
    // The factor still peaks at 1.0 — at TOP — and never exceeds it anywhere.
    let p = shared(
        "Pantheon",
        vec![Role::Support, Role::Top],
        [0.392, 0.1, 0.05, 0.0, 0.376],
    );
    assert_eq!(position_factor(Role::Top, &p), 1.0);
    assert_eq!(
        position_factor(Role::Support, &p),
        0.376_f64.max(SHARE_EPSILON) / 0.392
    );
    for role in [
        Role::Top,
        Role::Jungle,
        Role::Middle,
        Role::Adc,
        Role::Support,
    ] {
        assert!(position_factor(role, &p) <= 1.0, "{role:?} exceeds 1.0");
    }
}

#[test]
fn shares_unknown_reads_the_category_factors() {
    // A hand row, a file from before the shares, a test literal: 1.0 / 0.4 / 0.01 over the positions.
    let m = champ("Yone", Role::Middle, Some(Role::Top));
    assert_eq!(position_factor(Role::Middle, &m), 1.0);
    assert_eq!(position_factor(Role::Top, &m), 0.4);
    assert_eq!(position_factor(Role::Adc, &m), 0.01);
    // The loaders refuse an all-zero row (design § 4.1); a literal that carries one still reads the
    // categories rather than dividing by zero.
    let zero = shared("Zero", vec![Role::Middle], [0.0; 5]);
    assert_eq!(position_factor(Role::Middle, &zero), 1.0);
    assert_eq!(position_factor(Role::Top, &zero), 0.01);
}

#[test]
fn two_pure_marksmen_still_normalise_and_the_top_assignment_is_the_first_enumerated() {
    // Both share 1.0 at ADC and 0 elsewhere: every assignment seats one of them off-role at ε, so
    // without the floor every weight would be 0 and `solve` would hand back an unnormalised zero
    // vector. With it the total is positive and the maximum — one at ADC, the other anywhere at
    // ε — is first reached, in enumeration order, by Jinx TOP + Ashe ADC; eight assignments tie.
    let mut m = HashMap::new();
    m.insert(
        "Jinx".to_string(),
        shared("Jinx", vec![Role::Adc], [0.0, 0.0, 0.0, 1.0, 0.0]),
    );
    m.insert(
        "Ashe".to_string(),
        shared("Ashe", vec![Role::Adc], [0.0, 0.0, 0.0, 1.0, 0.0]),
    );
    let assignments = solve(&["Jinx", "Ashe"], &m);
    let total: f64 = assignments.iter().map(|a| a.weight).sum();
    assert!(
        (total - 1.0).abs() < 1e-12,
        "weights must normalise, total {total}"
    );
    let top = assignments.iter().fold(&assignments[0], |best, a| {
        if a.weight > best.weight {
            a
        } else {
            best
        }
    });
    assert_eq!(
        (top.assignment.top.as_str(), top.assignment.adc.as_str()),
        ("Jinx", "Ashe")
    );
    assert_eq!(
        assignments
            .iter()
            .filter(|a| a.weight == top.weight)
            .count(),
        8
    );
}

#[test]
fn raw_shares_and_ratios_give_the_same_normalised_weights() {
    // D8: a champion's denominator is the same in every assignment of a team, so it cancels under
    // normalisation — the ratio form changes nothing in the solver (it changes coverage and the
    // 0.9 injection threshold, which read the factor unnormalised).
    let rows: [(&str, Vec<Role>, [f64; 5]); 3] = [
        (
            "Pantheon",
            vec![Role::Top, Role::Support],
            [0.392, 0.1, 0.05, 0.0, 0.376],
        ),
        (
            "Sylas",
            vec![Role::Middle, Role::Top],
            [0.3, 0.02, 0.6, 0.001, 0.079],
        ),
        (
            "Ashe",
            vec![Role::Adc, Role::Support],
            [0.001, 0.0, 0.005, 0.8, 0.194],
        ),
    ];
    let m: HashMap<String, ChampionMeta> = rows
        .iter()
        .map(|(id, p, s)| (id.to_string(), shared(id, p.clone(), *s)))
        .collect();
    let ids = ["Pantheon", "Sylas", "Ashe"];
    let assignments = solve(&ids, &m);
    assert_eq!(assignments.len(), 60);
    let raw: Vec<f64> = assignments
        .iter()
        .map(|a| {
            ids.iter()
                .map(|id| m[*id].position_shares[seat(&a.assignment, id)].max(SHARE_EPSILON))
                .product()
        })
        .collect();
    let total: f64 = raw.iter().sum();
    for (a, r) in assignments.iter().zip(&raw) {
        assert!(
            (a.weight - r / total).abs() < 1e-12,
            "{:?}: {} vs {}",
            a.assignment,
            a.weight,
            r / total
        );
    }
}

#[test]
fn a_shares_unknown_champion_beside_known_ones_keeps_its_category_factors() {
    // The one hand row on a team of shared champions weighs 1.0 / 0.4 / 0.01 while the others weigh
    // their ratios — its unlisted roles sit at ten times ε (named and accepted, design § 6).
    let mut m = HashMap::new();
    m.insert(
        "Sylas".to_string(),
        shared(
            "Sylas",
            vec![Role::Middle, Role::Top],
            [0.3, 0.02, 0.6, 0.001, 0.079],
        ),
    );
    m.insert("Newcomer".to_string(), champ("Newcomer", Role::Adc, None));
    let assignments = solve(&["Sylas", "Newcomer"], &m);
    let weight = |top: &str, mid: &str, adc: &str| {
        assignments
            .iter()
            .find(|a| {
                a.assignment.top == top && a.assignment.middle == mid && a.assignment.adc == adc
            })
            .expect("enumerated")
            .weight
    };
    // Sylas MID + Newcomer ADC: 1.0 · 1.0; Sylas TOP + Newcomer ADC: 0.5 · 1.0;
    // Sylas MID + Newcomer TOP: 1.0 · 0.01.
    let base = weight("", "Sylas", "Newcomer");
    assert!((weight("Sylas", "", "Newcomer") / base - 0.3 / 0.6).abs() < 1e-12);
    assert!((weight("Newcomer", "Sylas", "") / base - 0.01).abs() < 1e-12);
}
