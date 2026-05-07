//! Alpha-beta sanity comparison wrapper for the MCTS v3 spike. Calls the
//! production `search` against the same EvalContext shape as the MCTS
//! prior (via shared `mcts_spike::eval_ctx::build_spike_eval_ctx`),
//! extracts top-K root candidates per-champion-as-first-pick (singleton
//! ranking), and emits a CSV row per position.
//!
//! v3 alignment fix: pair-pick children get aggregated to per-champion
//! singleton scores via MEAN-BY-LEAD (the v2 wrapper used max-by-lead).
//! Both aggregations are emitted so the writeup can compare. `pair_branch_width`
//! bumped to 200 so the per-lead aggregate has a meaningful sample size.

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side};
use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx;
use engine_core::mcts_spike::SpikeFixture;
use engine_core::pools::Role;
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search, SearchParams, TreeNode};
use std::collections::HashMap;

fn build_fixture() -> SpikeFixture {
    let role_layout: &[(Role, &[Role], usize)] = &[
        (Role::Top, &[Role::Middle], 16),
        (Role::Jungle, &[Role::Top], 16),
        (Role::Middle, &[Role::Top], 16),
        (Role::Adc, &[Role::Middle], 14),
        (Role::Support, &[Role::Middle], 14),
    ];
    let mut meta: HashMap<String, ChampionMeta> = HashMap::new();
    let mut winrates: HashMap<String, f64> = HashMap::new();
    let mut all_champions: Vec<String> = Vec::new();
    let role_letter = |r: Role| match r {
        Role::Top => "T",
        Role::Jungle => "J",
        Role::Middle => "M",
        Role::Adc => "A",
        Role::Support => "S",
    };
    for (primary, flex_opts, count) in role_layout {
        for i in 0..*count {
            let id = format!("{}{:02}", role_letter(*primary), i);
            let positions = if i % 4 == 0 && !flex_opts.is_empty() {
                vec![*primary, flex_opts[0]]
            } else {
                vec![*primary]
            };
            meta.insert(
                id.clone(),
                ChampionMeta { id: id.clone(), positions, ..Default::default() },
            );
            let wr = 0.46 + (((i * 7) % 9) as f64) / 100.0;
            winrates.insert(id.clone(), wr);
            all_champions.push(id);
        }
    }
    SpikeFixture { meta, winrates, all_champions }
}

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

#[derive(Clone, Debug)]
struct Aggregated {
    champion: String,
    is_pick: bool,
    max_score: f64,
    mean_score: f64,
    sample_count: usize,
}

/// Aggregate AB tree's children into per-champion-as-first-pick singletons.
/// Production search emits singleton children with `champion_ids = [c]` and
/// pair children with `champion_ids = [first, second]`. We aggregate by
/// `champion_ids[0]` (the lead) under both is_pick variants, keeping max
/// AND mean across partners. Mean is the v3 alignment metric.
fn aggregate_singletons(tree: &TreeNode) -> Vec<Aggregated> {
    let mut bucket: HashMap<(String, bool), Vec<f64>> = HashMap::new();
    for child in &tree.children {
        let Some(c) = child.champion_ids.first() else { continue };
        let key = (c.clone(), matches!(child.action_type, ActionType::Pick));
        bucket
            .entry(key)
            .or_default()
            .push(child.scores.composite);
    }
    bucket
        .into_iter()
        .map(|((c, is_pick), scores)| {
            let n = scores.len();
            let max_s = scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let mean_s = scores.iter().sum::<f64>() / (n.max(1) as f64);
            Aggregated {
                champion: c,
                is_pick,
                max_score: max_s,
                mean_score: mean_s,
                sample_count: n,
            }
        })
        .collect()
}

fn ab_top_k_dual(
    fixture: &SpikeFixture,
    state: DraftState,
    k: usize,
) -> (Vec<Aggregated>, Vec<Aggregated>) {
    let our_side = state.current_turn().map(|t| t.side).unwrap_or(Side::Blue);
    let ctx = build_spike_eval_ctx(fixture, &state, our_side);
    let params = SearchParams {
        branch_width: k.max(5),
        // v3: bump from k.max(5)*4 = 20 to 200 so per-lead mean has signal.
        pair_branch_width: 200,
        max_depth: 6,
        disable_alpha_beta: false,
        forced_branches: Vec::new(),
    };
    let cancel = CancelHandle::new();
    let tree: TreeNode = search(&state, &params, &ctx, &cancel).expect("ab search ok");

    let aggregated = aggregate_singletons(&tree);

    let mut by_max = aggregated.clone();
    by_max.sort_by(|a, b| {
        b.max_score
            .partial_cmp(&a.max_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    by_max.truncate(k);

    let mut by_mean = aggregated;
    by_mean.sort_by(|a, b| {
        b.mean_score
            .partial_cmp(&a.mean_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    by_mean.truncate(k);

    (by_max, by_mean)
}

fn move_label(c: &str, is_pick: bool) -> String {
    format!("{}:{}", if is_pick { "P" } else { "B" }, c)
}

fn label_top1(rows: &[Aggregated]) -> String {
    rows.first()
        .map(|r| move_label(&r.champion, r.is_pick))
        .unwrap_or_else(|| "<none>".into())
}

fn label_set(rows: &[Aggregated], n: usize) -> String {
    if rows.is_empty() {
        return "<none>".into();
    }
    rows.iter()
        .take(n)
        .map(|r| move_label(&r.champion, r.is_pick))
        .collect::<Vec<_>>()
        .join("|")
}

fn main() {
    let fixture = build_fixture();
    println!(
        "position,\
         ab_max_top1,ab_max_top3_set,ab_max_top5_set,\
         ab_mean_top1,ab_mean_top3_set,ab_mean_top5_set"
    );
    for pos_idx in 0..4 {
        let label = position_label(pos_idx);
        let state = make_position(pos_idx);
        let (by_max, by_mean) = ab_top_k_dual(&fixture, state, 5);
        println!(
            "{},{},{},{},{},{},{}",
            label,
            label_top1(&by_max),
            label_set(&by_max, 3),
            label_set(&by_max, 5),
            label_top1(&by_mean),
            label_set(&by_mean, 3),
            label_set(&by_mean, 5),
        );
    }
}
