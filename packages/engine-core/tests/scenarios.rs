use engine_core::draft_state::{ActionType, Phase, Side};
use engine_core::evaluator::ScoreSet;
use engine_core::pools::Role;
use engine_core::role_solver::{
    CcProfile, ChampionMeta, ChampionTags, DamageProfile, ScalingProfile,
};
use engine_core::scenarios::{collect_leaves, feature_vector, label_scenario};
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

fn champion_meta(
    id: &str,
    damage: (f64, f64),
    scaling: (f64, f64, f64),
    engage: f64,
    peel: f64,
) -> ChampionMeta {
    ChampionMeta {
        id: id.to_string(),
        positions: vec![Role::Top],
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
