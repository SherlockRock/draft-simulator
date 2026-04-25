use engine_core::draft_state::{ActionType, Phase, Side};
use engine_core::evaluator::ScoreSet;
use engine_core::scenarios::collect_leaves;
use engine_core::search::TreeNode;

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
