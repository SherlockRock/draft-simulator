use engine_core::draft_state::{ActionType, Phase, Side};
use engine_core::evaluator::ScoreSet;
use engine_core::pools::Role;
use engine_core::role_solver::{
    CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
};
use engine_core::scenarios::{collect_leaves, extract_scenarios, feature_vector, label_scenario, Perspective};
use engine_core::search::TreeNode;
use std::collections::HashMap;

fn node(
    champion_ids: &[&str],
    side: Option<Side>,
    action_type: ActionType,
    slots: &[usize],
    composite: f64,
    children: Vec<TreeNode>,
) -> TreeNode {
    TreeNode {
        champion_ids: champion_ids.iter().map(|id| (*id).to_string()).collect(),
        scores: ScoreSet {
            composite,
            ..Default::default()
        },
        side,
        slots: slots.to_vec(),
        action_type,
        phase: Phase::Ban1,
        user_injected: false,
        children,
    }
}

fn sample_tree() -> TreeNode {
    node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![
            node(
                &["Aatrox"],
                Some(Side::Blue),
                ActionType::Ban,
                &[0],
                0.8,
                vec![node(
                    &["LeeSin"],
                    Some(Side::Red),
                    ActionType::Ban,
                    &[1],
                    0.7,
                    vec![node(
                        &["Ahri"],
                        Some(Side::Blue),
                        ActionType::Pick,
                        &[6],
                        0.6,
                        vec![],
                    )],
                )],
            ),
            node(
                &["Jinx"],
                Some(Side::Blue),
                ActionType::Pick,
                &[6],
                0.5,
                vec![node(
                    &["Leona"],
                    Some(Side::Red),
                    ActionType::Pick,
                    &[7],
                    0.4,
                    vec![],
                )],
            ),
        ],
    )
}

fn champion_meta_with_positions(
    id: &str,
    positions: Vec<Role>,
    damage: (f64, f64),
    scaling: (f64, f64, f64),
    engage: f64,
    peel: f64,
) -> ChampionMeta {
    ChampionMeta {
        id: id.to_string(),
        positions,
        damage_profile: DamageProfile {
            physical: damage.0,
            magic: damage.1,
            r#true: 0.0,
        },
        scaling_profile: ScalingProfile {
            early: scaling.0,
            mid: scaling.1,
            late: scaling.2,
        },
        cc_profile: CcProfile {
            has_cc: engage > 0.0 || peel > 0.0,
            cc_types: Vec::new(),
            engage_quality: engage,
            peel_quality: peel,
        },
        tags: ChampionTags::default(),
    }
}

fn champion_meta(
    id: &str,
    damage: (f64, f64),
    scaling: (f64, f64, f64),
    engage: f64,
    peel: f64,
) -> ChampionMeta {
    champion_meta_with_positions(id, vec![Role::Top], damage, scaling, engage, peel)
}

fn sample_meta() -> HashMap<String, ChampionMeta> {
    HashMap::from([
        (
            "Alpha".to_string(),
            champion_meta("Alpha", (0.8, 0.2), (0.6, 0.3, 0.1), 0.4, 0.2),
        ),
        (
            "Beta".to_string(),
            champion_meta("Beta", (0.2, 0.6), (0.2, 0.5, 0.8), 0.6, 0.4),
        ),
        (
            "Gamma".to_string(),
            champion_meta("Gamma", (0.3, 0.3), (0.3, 0.4, 0.3), 0.2, 0.2),
        ),
        (
            "Delta".to_string(),
            champion_meta("Delta", (0.8, 0.1), (0.2, 0.2, 0.8), 0.7, 0.1),
        ),
        (
            "Epsilon".to_string(),
            champion_meta("Epsilon", (0.1, 0.8), (0.7, 0.2, 0.2), 0.1, 0.6),
        ),
        (
            "Zeta".to_string(),
            champion_meta("Zeta", (0.55, 0.2), (0.4, 0.6, 0.2), 0.3, 0.1),
        ),
        (
            "Eta".to_string(),
            champion_meta("Eta", (0.15, 0.7), (0.1, 0.3, 0.9), 0.0, 0.7),
        ),
    ])
}

fn scenario_branch(blue_pick: &str, red_pick: &str, composite: f64) -> TreeNode {
    node(
        &[blue_pick],
        Some(Side::Blue),
        ActionType::Pick,
        &[6],
        composite,
        vec![node(
            &[red_pick],
            Some(Side::Red),
            ActionType::Pick,
            &[7],
            composite,
            vec![],
        )],
    )
}

fn extraction_tree() -> TreeNode {
    node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![
            scenario_branch("Alpha", "Rho", 0.95),
            scenario_branch("Alpha", "Sigma", 0.90),
            scenario_branch("Delta", "Tau", 0.85),
            scenario_branch("Alpha", "Upsilon", 0.80),
            scenario_branch("Alpha", "Phi", 0.75),
            scenario_branch("Alpha", "Chi", 0.70),
            scenario_branch("Alpha", "Psi", 0.65),
        ],
    )
}

fn complete_blue_tree() -> TreeNode {
    node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![node(
            &["Topper"],
            Some(Side::Blue),
            ActionType::Pick,
            &[6],
            0.9,
            vec![node(
                &["Jungler"],
                Some(Side::Blue),
                ActionType::Pick,
                &[9],
                0.85,
                vec![node(
                    &["Midder"],
                    Some(Side::Blue),
                    ActionType::Pick,
                    &[10],
                    0.8,
                    vec![node(
                        &["Carry"],
                        Some(Side::Blue),
                        ActionType::Pick,
                        &[17],
                        0.75,
                        vec![node(
                            &["Supporter"],
                            Some(Side::Blue),
                            ActionType::Pick,
                            &[18],
                            0.7,
                            vec![],
                        )],
                    )],
                )],
            )],
        )],
    )
}

fn complete_blue_meta() -> HashMap<String, ChampionMeta> {
    HashMap::from([
        (
            "Topper".to_string(),
            champion_meta_with_positions(
                "Topper",
                vec![Role::Top],
                (0.7, 0.1),
                (0.5, 0.3, 0.3),
                0.2,
                0.1,
            ),
        ),
        (
            "Jungler".to_string(),
            champion_meta_with_positions(
                "Jungler",
                vec![Role::Jungle],
                (0.6, 0.2),
                (0.6, 0.3, 0.2),
                0.3,
                0.1,
            ),
        ),
        (
            "Midder".to_string(),
            champion_meta_with_positions(
                "Midder",
                vec![Role::Middle],
                (0.2, 0.7),
                (0.3, 0.5, 0.5),
                0.1,
                0.2,
            ),
        ),
        (
            "Carry".to_string(),
            champion_meta_with_positions(
                "Carry",
                vec![Role::Adc],
                (0.8, 0.1),
                (0.2, 0.4, 0.8),
                0.0,
                0.1,
            ),
        ),
        (
            "Supporter".to_string(),
            champion_meta_with_positions(
                "Supporter",
                vec![Role::Support],
                (0.1, 0.4),
                (0.2, 0.4, 0.6),
                0.7,
                0.8,
            ),
        ),
    ])
}

#[test]
fn collect_leaves_walks_to_terminals_with_path() {
    let leaves = collect_leaves(&sample_tree());

    assert_eq!(leaves.len(), 2);
    assert!(leaves.iter().all(|leaf| !leaf.path.is_empty()));
}

#[test]
fn collect_leaves_accumulates_picks_and_bans_by_side_and_action() {
    let leaves = collect_leaves(&sample_tree());

    let deep_leaf = leaves
        .iter()
        .find(|leaf| leaf.blue_bans == vec!["Aatrox".to_string()])
        .expect("expected deep leaf");
    assert_eq!(deep_leaf.red_bans, vec!["LeeSin".to_string()]);
    assert_eq!(deep_leaf.blue_picks, vec!["Ahri".to_string()]);
    assert!(deep_leaf.red_picks.is_empty());

    let pick_leaf = leaves
        .iter()
        .find(|leaf| leaf.red_picks == vec!["Leona".to_string()])
        .expect("expected pick leaf");
    assert_eq!(pick_leaf.blue_picks, vec!["Jinx".to_string()]);
    assert!(pick_leaf.blue_bans.is_empty());
    assert!(pick_leaf.red_bans.is_empty());
}

#[test]
fn feature_vector_averages_seven_dimensions_over_picks() {
    let meta = sample_meta();
    let picks = vec!["Alpha".to_string(), "Beta".to_string()];

    let vector = feature_vector(&picks, &meta);

    let expected = [0.5, 0.4, 0.4, 0.4, 0.45, 0.5, 0.3];
    for (actual, expected) in vector.iter().zip(expected.iter()) {
        assert!((actual - expected).abs() < 1e-9);
    }
}

#[test]
fn feature_vector_zero_when_picks_empty() {
    let meta = sample_meta();

    assert_eq!(feature_vector(&[], &meta), [0.0; 7]);
}

#[test]
fn label_scenario_emits_physical_heavy_for_high_physical() {
    let meta = sample_meta();
    let picks = vec!["Alpha".to_string(), "Delta".to_string()];

    let label = label_scenario(&picks, &meta);

    assert!(label.starts_with("Physical Heavy"));
}

#[test]
fn label_scenario_emits_late_scaling_and_hard_engage() {
    let meta = sample_meta();
    let picks = vec!["Delta".to_string()];

    assert_eq!(label_scenario(&picks, &meta), "Physical Heavy / Late Scaling");
}

#[test]
fn label_scenario_default_mid_mixed() {
    let meta = sample_meta();
    let picks = vec!["Gamma".to_string()];

    assert_eq!(label_scenario(&picks, &meta), "Mixed Damage / Mid Game");
}

#[test]
fn extract_scenarios_returns_one_to_five_scenarios() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 5);

    assert!((1..=5).contains(&scenarios.len()));
}

#[test]
fn extract_scenarios_first_is_highest_composite() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 5);
    let max_composite = 0.95;

    assert_eq!(scenarios[0].scores.composite, max_composite);
}

#[test]
fn extract_scenarios_uses_farthest_first_after_first() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 3);

    assert_eq!(scenarios[0].blue_picks, vec!["Alpha".to_string()]);
    assert_eq!(scenarios[1].blue_picks, vec!["Delta".to_string()]);
}

#[test]
fn extract_scenarios_marks_first_robust_others_likely() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 4);

    assert_eq!(scenarios[0].perspective, Perspective::Robust);
    assert!(scenarios[1..]
        .iter()
        .all(|scenario| scenario.perspective == Perspective::Likely));
}

#[test]
fn extract_scenarios_populates_tree_path_with_content_addressed_steps() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 1);
    let path = &scenarios[0].tree_path;

    assert_eq!(path.len(), 2);
    assert_eq!(path[0].slot, 6);
    assert_eq!(path[0].champion_ids, vec!["Alpha".to_string()]);
    assert_eq!(path[1].slot, 7);
    assert_eq!(path[1].champion_ids, vec!["Rho".to_string()]);
}

#[test]
fn extract_scenarios_description_format() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 1);

    assert_eq!(scenarios[0].description, "Alpha vs Rho");
}

#[test]
fn extract_scenarios_indicators_empty() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 5);

    assert!(scenarios.iter().all(|scenario| scenario.indicators.is_empty()));
}

#[test]
fn extract_scenarios_populates_likely_assignments_for_complete_blue_comp() {
    let meta = complete_blue_meta();
    let scenarios = extract_scenarios(&complete_blue_tree(), &meta, 1);
    let assignments = &scenarios[0].likely_assignments;

    assert_eq!(assignments.len(), 120);
    let weight_sum: f64 = assignments.iter().map(|assignment| assignment.weight).sum();
    assert!((weight_sum - 1.0).abs() < 1e-9);
}

#[test]
fn extract_scenarios_leaves_assignments_empty_for_partial_comp() {
    let meta = complete_blue_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 1);

    assert!(scenarios[0].likely_assignments.is_empty());
}
