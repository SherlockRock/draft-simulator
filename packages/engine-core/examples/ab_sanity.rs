//! v4 alpha-beta sanity wrapper. Calls production `search` against the same
//! EvalContext the spike uses, then emits the root tree's top-K children
//! directly — no aggregation, no max/mean dedup. With v4's pair-aware MCTS,
//! both engines produce the same shape of top-K (singletons at non-pair
//! turns, pairs at pair_start turns), so the comparison is apples-to-apples.
//!
//! Output labels match `MoveId::label()`: `P:champ` for singletons,
//! `P:first+second` for pairs (canonical alphabetical order). `B:` prefix
//! for bans. `sanity_compare.rs` consumes the same labels.

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side};
use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx_full_pool as build_spike_eval_ctx;
use engine_core::mcts_spike::procedural_fixture::procedural_fixture;
use engine_core::mcts_spike::SpikeFixture;
use engine_core::search::{search, SearchParams, TreeNode};

fn position_label(idx: usize) -> &'static str {
    match idx {
        0 => "empty",
        1 => "after_bans1",
        2 => "mid_pick1",
        3 => "late",
        _ => "?",
    }
}

fn make_position(idx: usize) -> DraftState {
    match idx {
        0 => DraftState::default(),
        1 => DraftState {
            blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
            red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
            ..Default::default()
        },
        2 => DraftState {
            blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
            red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
            blue_picks: vec!["T01".into()],
            red_picks: vec!["J00".into(), "M04".into()],
            ..Default::default()
        },
        3 => DraftState {
            blue_bans: vec!["T00".into(), "J04".into(), "M08".into(), "T08".into()],
            red_bans: vec!["A00".into(), "S00".into(), "M00".into(), "J08".into()],
            blue_picks: vec!["T01".into(), "M01".into(), "J01".into(), "A01".into()],
            red_picks: vec![
                "J00".into(),
                "M04".into(),
                "T04".into(),
                "A04".into(),
                "S04".into(),
            ],
            ..Default::default()
        },
        _ => unreachable!(),
    }
}

/// Convert a `TreeNode` child to the canonical MCTS label format. Pairs
/// emit `P:a+b` with a ≤ b alphabetically (matches MoveId::pair).
fn tree_node_label(node: &TreeNode) -> String {
    let prefix = match node.action_type {
        ActionType::Pick => "P",
        ActionType::Ban => "B",
    };
    let mut ids = node.champion_ids.clone();
    if ids.len() == 2 && ids[0] > ids[1] {
        ids.swap(0, 1);
    }
    format!("{}:{}", prefix, ids.join("+"))
}

fn ab_top_k(fixture: &SpikeFixture, state: DraftState, k: usize) -> Vec<(String, f64)> {
    let our_side = state.current_turn().map(|t| t.side).unwrap_or(Side::Blue);
    let ctx = build_spike_eval_ctx(fixture, &state, our_side);
    let params = SearchParams {
        branch_width: k.max(5),
        // v3 finding: pair_branch_width >= 60 with max_depth=6 exceeds the
        // 10-min/position budget on Pick2 pair turns. Stick with v3's 20 so
        // AB stays tractable. MCTS sees the wider 200 candidate set; AB sees
        // 20 explored to depth-6 minimax. Both ⊆ same seed_pair_candidates
        // canonical set, so AB's top-1 is always reachable from MCTS's
        // shortlist (verified by the v4 smoke test).
        pair_branch_width: 20,
        max_depth: 6,
        disable_alpha_beta: false,
        forced_branches: Vec::new(),
    };
    let cancel = CancelHandle::new();
    let tree: TreeNode = search(&state, &params, &ctx, &cancel).expect("ab search ok");

    let mut scored: Vec<(String, f64)> = tree
        .children
        .iter()
        .map(|c| (tree_node_label(c), c.scores.composite))
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k);
    scored
}

fn label_top1(rows: &[(String, f64)]) -> String {
    rows.first()
        .map(|(l, _)| l.clone())
        .unwrap_or_else(|| "<none>".into())
}

fn label_set(rows: &[(String, f64)], n: usize) -> String {
    if rows.is_empty() {
        return "<none>".into();
    }
    rows.iter()
        .take(n)
        .map(|(l, _)| l.clone())
        .collect::<Vec<_>>()
        .join("|")
}

fn main() {
    let fixture = procedural_fixture();
    println!("position,ab_top1,ab_top3_set,ab_top5_set");
    for pos_idx in 0..4 {
        let label = position_label(pos_idx);
        let state = make_position(pos_idx);
        let top = ab_top_k(&fixture, state, 5);
        println!(
            "{},{},{},{}",
            label,
            label_top1(&top),
            label_set(&top, 3),
            label_set(&top, 5),
        );
    }
}
