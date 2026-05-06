//! Alpha-beta sanity comparison wrapper for the MCTS v2 spike. Calls the
//! production `search` against the same `SpikeFixture` shape used by
//! `mcts_bench.rs`, extracts top-K root candidates by composite score, and
//! emits a CSV row per position.
//!
//! Pair-pick caveat: production search expands pair turns; the spike treats
//! every move as a singleton. AB output here is the production view; MCTS
//! output is the singleton view. Mismatch is documented in the writeup.

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeights, PhaseWeightTable};
use engine_core::mcts_spike::SpikeFixture;
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
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

fn make_pool_for_side(fixture: &SpikeFixture, _side: Side) -> TeamPool {
    let mut top = Vec::new();
    let mut jg = Vec::new();
    let mut mid = Vec::new();
    let mut adc = Vec::new();
    let mut sup = Vec::new();
    for (id, m) in &fixture.meta {
        for r in &m.positions {
            match r {
                Role::Top => top.push(id.clone()),
                Role::Jungle => jg.push(id.clone()),
                Role::Middle => mid.push(id.clone()),
                Role::Adc => adc.push(id.clone()),
                Role::Support => sup.push(id.clone()),
            }
        }
    }
    TeamPool {
        display: RolePoolMap { top, jungle: jg, middle: mid, adc, support: sup },
        search: fixture.all_champions.clone(),
    }
}

fn neutral_phase_weights() -> PhaseWeightTable {
    let w = PhaseWeights { info: 0.0, comp: 1.0, coverage: 1.0 };
    PhaseWeightTable { ban1: w, pick1: w, ban2: w, pick2: w }
}

fn build_eval_ctx(fixture: &SpikeFixture, state: &DraftState, our_side: Side) -> EvalContext {
    let phase = state
        .current_turn()
        .map(|t| t.phase)
        .unwrap_or(Phase::Pick2);
    let (our_picks, opp_picks) = if our_side == Side::Blue {
        (state.blue_picks.clone(), state.red_picks.clone())
    } else {
        (state.red_picks.clone(), state.blue_picks.clone())
    };
    EvalContext {
        side: our_side,
        phase,
        our_pool: make_pool_for_side(fixture, our_side),
        opp_pool: make_pool_for_side(fixture, our_side.opposite()),
        our_picks,
        opp_picks,
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: fixture.meta.clone(),
        meta: MetaData {
            win_rates: fixture.winrates.clone(),
            synergies: Vec::new(),
            counters: HashMap::new(),
        },
        phase_weights_blue: neutral_phase_weights(),
        phase_weights_red: neutral_phase_weights(),
        synergy_multiplier: 0.0,
        counter_multiplier: 0.0,
        flex_retention_weight: 0.0,
        reveal_cost_weight: 0.0,
    }
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

fn ab_top_k(fixture: &SpikeFixture, state: DraftState, k: usize) -> Vec<(String, bool, f64)> {
    let our_side = state.current_turn().map(|t| t.side).unwrap_or(Side::Blue);
    let ctx = build_eval_ctx(fixture, &state, our_side);
    let params = SearchParams {
        branch_width: k.max(5),
        pair_branch_width: k.max(5) * 4,
        max_depth: 6,
        disable_alpha_beta: false,
        forced_branches: Vec::new(),
    };
    let cancel = CancelHandle::new();
    let tree: TreeNode = search(&state, &params, &ctx, &cancel).expect("ab search ok");

    // Dedupe by lead champion: production search emits one child per pair,
    // so multiple children can share the same first champion. Keep the
    // highest-scoring entry per (champion, is_pick) before truncating to K.
    let mut best: HashMap<(String, bool), f64> = HashMap::new();
    for child in &tree.children {
        let Some(c) = child.champion_ids.first() else { continue };
        let key = (c.clone(), matches!(child.action_type, ActionType::Pick));
        let score = child.scores.composite;
        best.entry(key)
            .and_modify(|v| {
                if score > *v {
                    *v = score;
                }
            })
            .or_insert(score);
    }
    let mut out: Vec<(String, bool, f64)> = best
        .into_iter()
        .map(|((c, p), s)| (c, p, s))
        .collect();
    out.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    out.truncate(k);
    out
}

fn move_label(c: &str, is_pick: bool) -> String {
    format!("{}:{}", if is_pick { "P" } else { "B" }, c)
}

fn main() {
    let fixture = build_fixture();
    println!("position,ab_top1,ab_top3_set,ab_top5_set");
    for pos_idx in 0..4 {
        let label = position_label(pos_idx);
        let state = make_position(pos_idx);
        let top = ab_top_k(&fixture, state, 5);
        if top.is_empty() {
            println!("{},<none>,<none>,<none>", label);
            continue;
        }
        let t1 = move_label(&top[0].0, top[0].1);
        let t3: Vec<String> = top.iter().take(3).map(|(c, p, _)| move_label(c, *p)).collect();
        let t5: Vec<String> = top.iter().take(5).map(|(c, p, _)| move_label(c, *p)).collect();
        println!("{},{},{},{}", label, t1, t3.join("|"), t5.join("|"));
    }
}
