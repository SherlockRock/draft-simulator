//! v4 alpha-beta sanity wrapper. Calls production `search` against the same
//! EvalContext the spike uses, then emits the root tree's top-K children
//! directly — no aggregation, no max/mean dedup. Output labels match
//! `MoveId::label()`: `P:champ` for singletons, `P:first+second` for pairs.
//!
//! v5 phase 1: same env config as `mcts_bench`:
//!   SPIKE_FIXTURE=procedural|real
//!   SPIKE_POOL=full|narrow
//!   SPIKE_OUT=<path>
//!
//! `sanity_compare.rs` consumed v4-shape labels; v5's `v5_eval.rs` (phase 2+)
//! is the consumer for the new shape (fixture/pool columns added).

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side};
use engine_core::mcts_spike::eval_ctx::build_spike_eval_ctx;
use engine_core::mcts_spike::procedural_fixture::procedural_fixture;
use engine_core::mcts_spike::real_data_fixture::real_data_fixture;
use engine_core::mcts_spike::{PoolContext, SpikeFixture};
use engine_core::pools::{RolePoolMap, TeamPool};
use engine_core::search::{search, SearchParams, TreeNode};
use std::io::Write;

fn position_label(idx: usize) -> &'static str {
    match idx {
        0 => "empty",
        1 => "after_bans1",
        2 => "mid_pick1",
        3 => "late",
        _ => "?",
    }
}

fn procedural_position(idx: usize) -> DraftState {
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

fn real_position(idx: usize) -> DraftState {
    match idx {
        0 => DraftState::default(),
        1 => DraftState {
            blue_bans: vec!["Aatrox".into(), "LeeSin".into(), "Yasuo".into()],
            red_bans: vec!["Jinx".into(), "Thresh".into(), "Ahri".into()],
            ..Default::default()
        },
        2 => DraftState {
            blue_bans: vec!["Aatrox".into(), "LeeSin".into(), "Yasuo".into()],
            red_bans: vec!["Jinx".into(), "Thresh".into(), "Ahri".into()],
            blue_picks: vec!["Camille".into()],
            red_picks: vec!["Graves".into(), "Syndra".into()],
            ..Default::default()
        },
        3 => DraftState {
            blue_bans: vec![
                "Aatrox".into(),
                "LeeSin".into(),
                "Yasuo".into(),
                "Akali".into(),
            ],
            red_bans: vec![
                "Jinx".into(),
                "Thresh".into(),
                "Ahri".into(),
                "Graves".into(),
            ],
            blue_picks: vec![
                "Camille".into(),
                "Viego".into(),
                "Syndra".into(),
                "Ezreal".into(),
            ],
            red_picks: vec![
                "Hecarim".into(),
                "Azir".into(),
                "Renekton".into(),
                "Kaisa".into(),
                "Lulu".into(),
            ],
            ..Default::default()
        },
        _ => unreachable!(),
    }
}

fn procedural_narrow_pool() -> TeamPool {
    let top = vec!["T00".into(), "T01".into(), "T02".into(), "T03".into(), "T04".into()];
    let jg = vec!["J00".into(), "J01".into(), "J02".into(), "J03".into(), "J04".into()];
    let mid = vec!["M00".into(), "M01".into(), "M02".into(), "M03".into(), "M04".into()];
    let adc = vec!["A00".into(), "A01".into(), "A02".into(), "A03".into(), "A04".into()];
    let sup = vec!["S00".into(), "S01".into(), "S02".into(), "S03".into(), "S04".into()];
    let mut search = Vec::new();
    for v in [&top, &jg, &mid, &adc, &sup] {
        search.extend(v.iter().cloned());
    }
    TeamPool { display: RolePoolMap { top, jungle: jg, middle: mid, adc, support: sup }, search }
}

fn real_narrow_pool() -> TeamPool {
    let top = vec![
        "Aatrox".into(),
        "Camille".into(),
        "Renekton".into(),
        "Sett".into(),
        "Garen".into(),
    ];
    let jg = vec![
        "Graves".into(),
        "LeeSin".into(),
        "Viego".into(),
        "Hecarim".into(),
        "Kindred".into(),
    ];
    let mid = vec![
        "Ahri".into(),
        "Syndra".into(),
        "Akali".into(),
        "Orianna".into(),
        "Yasuo".into(),
    ];
    let adc = vec![
        "Jinx".into(),
        "Caitlyn".into(),
        "Lucian".into(),
        "Aphelios".into(),
        "Ezreal".into(),
    ];
    let sup = vec![
        "Thresh".into(),
        "Lulu".into(),
        "Karma".into(),
        "Sona".into(),
        "Nautilus".into(),
    ];
    let mut search = Vec::new();
    for v in [&top, &jg, &mid, &adc, &sup] {
        search.extend(v.iter().cloned());
    }
    TeamPool { display: RolePoolMap { top, jungle: jg, middle: mid, adc, support: sup }, search }
}

fn build_fixture_and_pools(
    fixture_name: &str,
    pool_name: &str,
) -> (SpikeFixture, PoolContext) {
    let fixture = match fixture_name {
        "real" => real_data_fixture(),
        _ => procedural_fixture(),
    };
    let pools = match (fixture_name, pool_name) {
        (_, "full") => PoolContext::full(&fixture),
        ("real", _) => {
            let pool = real_narrow_pool();
            PoolContext::new(pool.clone(), pool)
        }
        (_, _) => {
            let pool = procedural_narrow_pool();
            PoolContext::new(pool.clone(), pool)
        }
    };
    (fixture, pools)
}

fn position_for(fixture_name: &str, idx: usize) -> DraftState {
    match fixture_name {
        "real" => real_position(idx),
        _ => procedural_position(idx),
    }
}

/// Convert a `TreeNode` child to the canonical MCTS label format.
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

fn ab_top_k(
    fixture: &SpikeFixture,
    pools: &PoolContext,
    state: DraftState,
    k: usize,
) -> Vec<(String, f64)> {
    let our_side = state.current_turn().map(|t| t.side).unwrap_or(Side::Blue);
    let ctx = build_spike_eval_ctx(fixture, &state, our_side, pools);
    let params = SearchParams {
        branch_width: k.max(5),
        // v4: pair_branch_width=20 keeps AB tractable at depth-6.
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
    let fixture_name = std::env::var("SPIKE_FIXTURE").unwrap_or_else(|_| "procedural".into());
    let pool_name = std::env::var("SPIKE_POOL").unwrap_or_else(|_| "full".into());
    let out_path = std::env::var("SPIKE_OUT").ok();

    let (fixture, pools) = build_fixture_and_pools(&fixture_name, &pool_name);

    let mut writer: Box<dyn Write> = match out_path {
        Some(p) => Box::new(std::fs::File::create(p).expect("open out")),
        None => Box::new(std::io::stdout()),
    };

    writeln!(writer, "fixture,pool,position,ab_top1,ab_top3_set,ab_top5_set").unwrap();
    for pos_idx in 0..4 {
        let label = position_label(pos_idx);
        let state = position_for(&fixture_name, pos_idx);
        let top = ab_top_k(&fixture, &pools, state, 5);
        writeln!(
            writer,
            "{},{},{},{},{},{}",
            fixture_name,
            pool_name,
            label,
            label_top1(&top),
            label_set(&top, 3),
            label_set(&top, 5),
        )
        .unwrap();
    }
}
