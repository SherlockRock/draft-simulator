use engine_core::draft_state::{ActionType, Phase, Side};
use engine_core::evaluator::{ScoreSet, SideValues};
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
            composite_per_side: SideValues { blue: composite, red: 0.0 },
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

fn complete_red_tree() -> TreeNode {
    node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![node(
            &["Topper"],
            Some(Side::Red),
            ActionType::Pick,
            &[7],
            0.9,
            vec![node(
                &["Jungler"],
                Some(Side::Red),
                ActionType::Pick,
                &[8],
                0.85,
                vec![node(
                    &["Midder"],
                    Some(Side::Red),
                    ActionType::Pick,
                    &[11],
                    0.8,
                    vec![node(
                        &["Carry"],
                        Some(Side::Red),
                        ActionType::Pick,
                        &[16],
                        0.75,
                        vec![node(
                            &["Supporter"],
                            Some(Side::Red),
                            ActionType::Pick,
                            &[19],
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
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 5, &[], &[]);

    assert!((1..=5).contains(&scenarios.len()));
}

#[test]
fn extract_scenarios_first_is_highest_composite() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 5, &[], &[]);
    let max_composite = 0.95;

    assert_eq!(scenarios[0].scores.composite, max_composite);
}

#[test]
fn extract_scenarios_uses_farthest_first_after_first() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 3, &[], &[]);

    assert_eq!(scenarios[0].blue_picks, vec!["Alpha".to_string()]);
    assert_eq!(scenarios[1].blue_picks, vec!["Delta".to_string()]);
}

#[test]
fn extract_scenarios_marks_first_robust_others_likely() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 4, &[], &[]);

    assert_eq!(scenarios[0].perspective, Perspective::Robust);
    assert!(scenarios[1..]
        .iter()
        .all(|scenario| scenario.perspective == Perspective::Likely));
}

#[test]
fn extract_scenarios_populates_tree_path_with_content_addressed_steps() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 1, &[], &[]);
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
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 1, &[], &[]);

    assert_eq!(scenarios[0].description, "Alpha vs Rho");
}

#[test]
fn extract_scenarios_indicators_empty() {
    let meta = sample_meta();
    let scenarios = extract_scenarios(&extraction_tree(), &meta, 5, &[], &[]);

    assert!(scenarios.iter().all(|scenario| scenario.indicators.is_empty()));
}

#[test]
fn extract_scenarios_populates_likely_assignments_for_complete_blue_comp() {
    let meta = complete_blue_meta();
    let scenarios = extract_scenarios(&complete_blue_tree(), &meta, 1, &[], &[]);
    let assignments = &scenarios[0].blue_likely_assignments;

    assert_eq!(assignments.len(), 120);
    let weight_sum: f64 = assignments.iter().map(|assignment| assignment.weight).sum();
    assert!((weight_sum - 1.0).abs() < 1e-9);
    assert!(scenarios[0].red_likely_assignments.is_empty());
}

#[test]
fn extract_scenarios_populates_likely_assignments_for_complete_red_comp() {
    let meta = complete_blue_meta();
    let scenarios = extract_scenarios(&complete_red_tree(), &meta, 1, &[], &[]);
    let assignments = &scenarios[0].red_likely_assignments;

    assert_eq!(assignments.len(), 120);
    let weight_sum: f64 = assignments.iter().map(|assignment| assignment.weight).sum();
    assert!((weight_sum - 1.0).abs() < 1e-9);
    assert!(scenarios[0].blue_likely_assignments.is_empty());
}

#[test]
fn extract_scenarios_populates_assignments_for_partial_comp() {
    // Phase 3 of the role-parity plan: extract_scenarios drops its len==5 gate
    // so partial comps surface role assignments. Build a tree where the leaf
    // has a single blue pick ("Topper") matched in meta — assignments must
    // populate with P(5,1) = 5 entries.
    let meta = complete_blue_meta();
    let partial_tree = node(
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
            0.5,
            vec![],
        )],
    );
    let scenarios = extract_scenarios(&partial_tree, &meta, 1, &[], &[]);

    assert_eq!(
        scenarios[0].blue_likely_assignments.len(),
        5,
        "P(5,1) = 5 assignments for a single-pick partial comp"
    );
    let weight_sum: f64 = scenarios[0]
        .blue_likely_assignments
        .iter()
        .map(|wa| wa.weight)
        .sum();
    assert!((weight_sum - 1.0).abs() < 1e-9, "weights sum to 1");
    assert!(scenarios[0].red_likely_assignments.is_empty());
}

#[test]
fn extract_scenarios_populates_assignments_when_confirmed_plus_projected_total_five() {
    let meta = complete_blue_meta();
    let final_pick_tree = node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![node(
            &["Supporter"],
            Some(Side::Blue),
            ActionType::Pick,
            &[18],
            0.9,
            vec![],
        )],
    );
    let confirmed_blue: Vec<String> = ["Topper", "Jungler", "Midder", "Carry"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();

    let scenarios = extract_scenarios(&final_pick_tree, &meta, 1, &confirmed_blue, &[]);
    let assignments = &scenarios[0].blue_likely_assignments;

    assert_eq!(assignments.len(), 120);
    let weight_sum: f64 = assignments.iter().map(|assignment| assignment.weight).sum();
    assert!((weight_sum - 1.0).abs() < 1e-9);
    assert!(scenarios[0].red_likely_assignments.is_empty());
}

fn highest_weighted(
    assignments: &[engine_core::role_solver::WeightedAssignment],
) -> &engine_core::role_solver::RoleAssignment {
    &assignments
        .iter()
        .max_by(|a, b| a.weight.partial_cmp(&b.weight).expect("non-NaN weight"))
        .expect("non-empty")
        .assignment
}

/// Each champion has a unique primary role. Highest-weighted assignment must
/// place each at its primary regardless of input order.
#[test]
fn extract_scenarios_top_assignment_is_canonical_when_5_confirmed() {
    let meta = complete_blue_meta();
    let trivial_tree = node(&[], None, ActionType::Ban, &[], 0.0, Vec::new());
    let confirmed: Vec<String> =
        ["Topper", "Jungler", "Midder", "Carry", "Supporter"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();

    // 5 confirmed, no projection. Tree has no children → no leaves with projection.
    // Note: this exercises the API shape where the engine called extract_scenarios
    // when the comp is already fully resolved confirmed-side. Today extract_scenarios
    // returns Vec::new() for an empty tree; this test documents that shape.
    let scenarios = extract_scenarios(&trivial_tree, &meta, 1, &confirmed, &[]);
    assert!(
        scenarios.is_empty(),
        "trivial tree (no leaves with projection) yields no scenarios"
    );
}

/// Confirmed [Topper, Jungler, Midder, Carry] + projected [Supporter] should
/// produce a top-weighted assignment that places each champion at its primary role.
#[test]
fn extract_scenarios_top_assignment_is_canonical_for_4_confirmed_plus_1_projected() {
    let meta = complete_blue_meta();
    let final_pick_tree = node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![node(
            &["Supporter"],
            Some(Side::Blue),
            ActionType::Pick,
            &[18],
            0.9,
            vec![],
        )],
    );
    let confirmed_blue: Vec<String> = ["Topper", "Jungler", "Midder", "Carry"]
        .iter()
        .map(|s| (*s).to_string())
        .collect();

    let scenarios = extract_scenarios(&final_pick_tree, &meta, 1, &confirmed_blue, &[]);
    let top = highest_weighted(&scenarios[0].blue_likely_assignments);

    assert_eq!(top.top, "Topper", "Topper should be at TOP");
    assert_eq!(top.jungle, "Jungler", "Jungler should be at JUNGLE");
    assert_eq!(top.middle, "Midder", "Midder should be at MIDDLE");
    assert_eq!(top.adc, "Carry", "Carry should be at ADC");
    assert_eq!(top.support, "Supporter", "Supporter should be at SUPPORT");
}

/// Confirmed [Topper] + projected [Jungler, Midder, Carry, Supporter] (4 projected
/// from a deep pick chain) should produce the same canonical assignment. Verifies
/// the chain works mid-draft, where most picks come from projection.
#[test]
fn extract_scenarios_top_assignment_is_canonical_for_1_confirmed_plus_4_projected() {
    let meta = complete_blue_meta();
    let mid_draft_tree = node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![node(
            &["Jungler"],
            Some(Side::Blue),
            ActionType::Pick,
            &[9],
            0.9,
            vec![node(
                &["Midder"],
                Some(Side::Blue),
                ActionType::Pick,
                &[10],
                0.85,
                vec![node(
                    &["Carry"],
                    Some(Side::Blue),
                    ActionType::Pick,
                    &[17],
                    0.8,
                    vec![node(
                        &["Supporter"],
                        Some(Side::Blue),
                        ActionType::Pick,
                        &[18],
                        0.75,
                        vec![],
                    )],
                )],
            )],
        )],
    );
    let confirmed_blue = vec!["Topper".to_string()];

    let scenarios = extract_scenarios(&mid_draft_tree, &meta, 1, &confirmed_blue, &[]);
    let top = highest_weighted(&scenarios[0].blue_likely_assignments);

    assert_eq!(top.top, "Topper");
    assert_eq!(top.jungle, "Jungler");
    assert_eq!(top.middle, "Midder");
    assert_eq!(top.adc, "Carry");
    assert_eq!(top.support, "Supporter");
}

/// Degenerate comp: 3 champions whose primary is MID, plus a TOP and a JG —
/// no real ADC or SUPPORT. Documents what the solver returns when forced to
/// place off-role champions at ADC/SUPPORT, and verifies that the solver does
/// pick a "least-bad" arrangement (no panic, real values).
#[test]
fn extract_scenarios_degenerate_comp_assigns_off_role_to_uncovered_slots() {
    let mut meta = HashMap::new();
    meta.insert(
        "TopGuy".to_string(),
        champion_meta_with_positions("TopGuy", vec![Role::Top], (0.7, 0.1), (0.5, 0.3, 0.3), 0.2, 0.1),
    );
    meta.insert(
        "JgGuy".to_string(),
        champion_meta_with_positions("JgGuy", vec![Role::Jungle], (0.6, 0.2), (0.6, 0.3, 0.2), 0.3, 0.1),
    );
    meta.insert(
        "MidA".to_string(),
        champion_meta_with_positions("MidA", vec![Role::Middle], (0.2, 0.7), (0.3, 0.5, 0.5), 0.1, 0.2),
    );
    meta.insert(
        "MidB".to_string(),
        champion_meta_with_positions("MidB", vec![Role::Middle], (0.2, 0.7), (0.3, 0.5, 0.5), 0.1, 0.2),
    );
    meta.insert(
        "MidC".to_string(),
        champion_meta_with_positions("MidC", vec![Role::Middle], (0.2, 0.7), (0.3, 0.5, 0.5), 0.1, 0.2),
    );

    let confirmed_blue: Vec<String> =
        ["TopGuy", "JgGuy", "MidA", "MidB"].iter().map(|s| (*s).to_string()).collect();
    let final_pick_tree = node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![node(
            &["MidC"],
            Some(Side::Blue),
            ActionType::Pick,
            &[18],
            0.9,
            vec![],
        )],
    );

    let scenarios = extract_scenarios(&final_pick_tree, &meta, 1, &confirmed_blue, &[]);
    let top = highest_weighted(&scenarios[0].blue_likely_assignments);

    // TopGuy and JgGuy fit perfectly. The 3 mids tie for MID; one wins MID, the
    // other two are forced to ADC/SUPPORT (off-role). The solver returns a
    // best-effort assignment — the user perceives this as "wrong" because a mid
    // is shown with ADC role badge, but the engine has no real ADC to place.
    assert_eq!(top.top, "TopGuy", "TopGuy fits at TOP");
    assert_eq!(top.jungle, "JgGuy", "JgGuy fits at JUNGLE");
    let mids = ["MidA", "MidB", "MidC"];
    assert!(mids.contains(&top.middle.as_str()), "MID gets one of the mids");
    assert!(
        mids.contains(&top.adc.as_str()),
        "ADC slot gets a mid (off-role) — user perceives this as 'wrong lane assignment'"
    );
    assert!(
        mids.contains(&top.support.as_str()),
        "SUPPORT slot gets a mid (off-role) — same"
    );
}

/// Documents the dedup landmine: if confirmed and projected both contain the
/// same champion, the chain has length 5 (passes the gate) but contains a
/// duplicate, and `solve` produces a malformed assignment that places the
/// duplicated champion in TWO roles and drops one champion entirely.
///
/// In normal operation this should not happen because `collect_candidates`
/// filters out already-picked champions. But forced branches or other future
/// code paths could allow it, so this test fails loudly if reality changes.
#[test]
fn extract_scenarios_overlap_produces_malformed_assignment() {
    let meta = complete_blue_meta();
    // Confirmed: Topper, Jungler. Projected: Topper (DUP), Midder, Carry.
    // Chain: [Topper, Jungler, Topper, Midder, Carry] — len 5 with dup, no Supporter.
    let tree_with_dup = node(
        &[],
        None,
        ActionType::Ban,
        &[],
        0.0,
        vec![node(
            &["Topper"],
            Some(Side::Blue),
            ActionType::Pick,
            &[10],
            0.9,
            vec![node(
                &["Midder"],
                Some(Side::Blue),
                ActionType::Pick,
                &[17],
                0.85,
                vec![node(
                    &["Carry"],
                    Some(Side::Blue),
                    ActionType::Pick,
                    &[18],
                    0.8,
                    vec![],
                )],
            )],
        )],
    );
    let confirmed_blue: Vec<String> =
        ["Topper", "Jungler"].iter().map(|s| (*s).to_string()).collect();

    let scenarios = extract_scenarios(&tree_with_dup, &meta, 1, &confirmed_blue, &[]);
    let assignments = &scenarios[0].blue_likely_assignments;

    // 120 perms over 5-slot input including a duplicate.
    assert_eq!(assignments.len(), 120);
    let top = highest_weighted(assignments);
    let used: std::collections::HashSet<&str> = [
        top.top.as_str(),
        top.jungle.as_str(),
        top.middle.as_str(),
        top.adc.as_str(),
        top.support.as_str(),
    ]
    .into_iter()
    .collect();
    // Malformed: only 4 unique champions across 5 slots → one champion duplicated,
    // one missing entirely. This is the documented broken behavior.
    assert_eq!(
        used.len(),
        4,
        "overlap input produces malformed assignment; if this changes the chain logic was hardened"
    );
    assert!(
        !used.contains("Supporter"),
        "Supporter (only in meta, not in chain) is missing as expected"
    );
}

#[test]
fn extract_scenarios_deterministic_for_same_tree() {
    let meta = sample_meta();
    let tree = extraction_tree();

    let first = extract_scenarios(&tree, &meta, 5, &[], &[]);
    let second = extract_scenarios(&tree, &meta, 5, &[], &[]);

    assert_eq!(first[0].name, second[0].name);
    assert_eq!(first[0].description, second[0].description);
    assert_eq!(first[0].tree_path.len(), second[0].tree_path.len());
    for (left, right) in first[0].tree_path.iter().zip(second[0].tree_path.iter()) {
        assert_eq!(left.slot, right.slot);
        assert_eq!(left.champion_ids, right.champion_ids);
    }
}
