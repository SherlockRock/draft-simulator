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
    }
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
