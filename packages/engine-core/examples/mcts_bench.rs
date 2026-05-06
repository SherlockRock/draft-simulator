//! MCTS spike v2 trajectory bench.
//!
//! Run with: cargo run --release --example mcts_bench
//!
//! Emits CSV to stdout. Each row is one (position, seed, sample-checkpoint)
//! observation — sub-1s checkpoints support the streaming-UI claim.

use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::tree::MoveId;
use engine_core::mcts_spike::{SpikeFixture, ValueVector};
use engine_core::pools::Role;
use engine_core::role_solver::ChampionMeta;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const SAMPLE_SCHEDULE_MS: &[u128] = &[
    100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
];

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
                ChampionMeta {
                    id: id.clone(),
                    positions,
                    ..Default::default()
                },
            );
            let wr = 0.46 + (((i * 7) % 9) as f64) / 100.0;
            winrates.insert(id.clone(), wr);
            all_champions.push(id);
        }
    }

    SpikeFixture { meta, winrates, all_champions }
}

fn position_empty() -> DraftState { DraftState::default() }

fn position_after_bans1() -> DraftState {
    DraftState {
        blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
        red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
        ..Default::default()
    }
}

fn position_mid_pick1() -> DraftState {
    DraftState {
        blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
        red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
        blue_picks: vec!["T01".into()],
        red_picks: vec!["J00".into(), "M04".into()],
        ..Default::default()
    }
}

fn position_late() -> DraftState {
    DraftState {
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
        0 => position_empty(),
        1 => position_after_bans1(),
        2 => position_mid_pick1(),
        3 => position_late(),
        _ => unreachable!(),
    }
}

fn move_label(mv: &MoveId) -> String {
    format!("{}:{}", if mv.is_pick { "P" } else { "B" }, mv.champion)
}

fn topk_label(dist: &[(MoveId, u32, ValueVector)], k: usize) -> String {
    dist.iter()
        .take(k)
        .map(|(mv, _, _)| move_label(mv))
        .collect::<Vec<_>>()
        .join("|")
}

fn run_trajectory(
    fixture: &SpikeFixture,
    state: DraftState,
    policy: RolloutPolicy,
    fmode: FeasibilityMode,
    seed: u64,
    position: &str,
) {
    let mut mcts = Mcts::new(
        fixture,
        state,
        McTsConfig { policy, feasibility_mode: fmode, seed, root_shortlist_k: None },
    );

    let start = Instant::now();
    let mut next_sample_idx = 0usize;
    let mut last_iters: u32 = 0;
    let mut last_sample_at = start;

    while next_sample_idx < SAMPLE_SCHEDULE_MS.len() {
        let elapsed = start.elapsed().as_millis();
        let target = SAMPLE_SCHEDULE_MS[next_sample_idx];
        if elapsed >= target {
            let iters = mcts.total_iterations();
            let window_secs = last_sample_at.elapsed().as_secs_f64().max(1e-6);
            let ips_window = (iters - last_iters) as f64 / window_secs;
            last_iters = iters;
            last_sample_at = Instant::now();

            let dist = mcts.root_visit_distribution();
            let total_root_visits: u32 = dist.iter().map(|(_, v, _)| *v).sum();
            let top1_share = if total_root_visits > 0 && !dist.is_empty() {
                dist[0].1 as f64 / total_root_visits as f64
            } else {
                0.0
            };
            let top1_value = dist
                .first()
                .map(|(_, _, v)| *v)
                .unwrap_or(ValueVector::zero());
            let top1_move = dist
                .first()
                .map(|(mv, _, _)| move_label(mv))
                .unwrap_or_else(|| "<none>".into());
            let top1_visits = dist.first().map(|(_, v, _)| *v).unwrap_or(0);

            // Pareto + shortlist columns reserved; filled by Task 11.
            let pareto_size = 0u32;
            let pareto_moves = String::new();
            let visits_per_frontier_member = String::new();
            let shortlist_size = 0u32;

            println!(
                "{},{},{},{},{:.0},{},{},{:.4},{},{},{},{},{},{:.4},{:.4},{:.4},{}",
                position,
                seed,
                elapsed,
                iters,
                ips_window,
                top1_move,
                top1_visits,
                top1_share,
                topk_label(&dist, 3),
                topk_label(&dist, 5),
                pareto_size,
                pareto_moves,
                visits_per_frontier_member,
                top1_value.winrate,
                top1_value.coverage,
                top1_value.flex,
                shortlist_size,
            );
            next_sample_idx += 1;
            continue;
        }
        // Iterate until next checkpoint OR the budget expires.
        let deadline = start + Duration::from_millis(target as u64);
        while Instant::now() < deadline {
            mcts.iterate();
        }
    }
}

fn main() {
    let fixture = build_fixture();
    let policies = [RolloutPolicy::UniformFeasible];
    let fmodes = [FeasibilityMode::Cached];
    let seeds = [1u64, 42, 1337];
    let positions = 4usize;

    println!(
        "position,seed,elapsed_ms,iters_completed,iter_per_sec_window,\
         top1_move,top1_visits,top1_share,top3_set,top5_set,\
         pareto_frontier_size,pareto_frontier_moves,visits_per_frontier_member,\
         top1_value_winrate,top1_value_coverage,top1_value_flex,shortlist_size"
    );

    for pos_idx in 0..positions {
        let label = position_label(pos_idx);
        for &fmode in &fmodes {
            for &policy in &policies {
                for &seed in &seeds {
                    let state = make_position(pos_idx);
                    run_trajectory(&fixture, state, policy, fmode, seed, label);
                }
            }
        }
    }
}
