//! MCTS spike v2 trajectory bench.
//!
//! Run with: cargo run --release --example mcts_bench
//!
//! Emits CSV to stdout. Each row is one (position, seed, sample-checkpoint)
//! observation — sub-1s checkpoints support the streaming-UI claim.

use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::procedural_fixture::procedural_fixture;
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::{SpikeFixture, ValueVector};
use std::time::{Duration, Instant};

const SAMPLE_SCHEDULE_MS: &[u128] = &[
    100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
    120_000, 180_000, 300_000,
];

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

fn run_trajectory(
    fixture: &SpikeFixture,
    state: DraftState,
    policy: RolloutPolicy,
    fmode: FeasibilityMode,
    seed: u64,
    position: &str,
    shortlist_k: Option<usize>,
) {
    use engine_core::mcts_spike::trajectory::{capture, entries_label, frontier_label, frontier_visits_summary};

    let mut mcts = Mcts::new(
        fixture,
        state,
        McTsConfig {
            policy,
            feasibility_mode: fmode,
            seed,
            root_shortlist_k: shortlist_k,
        },
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

            let sample = capture(&mcts, elapsed, ips_window);
            let top1_share = if sample.root_total_visits > 0 {
                sample.top1.as_ref().map(|t| t.visits).unwrap_or(0) as f64
                    / sample.root_total_visits as f64
            } else {
                0.0
            };
            let (t1_label, t1_visits, t1_value) = sample
                .top1
                .as_ref()
                .map(|t| (t.mv.label(), t.visits, t.mean_value))
                .unwrap_or_else(|| ("<none>".into(), 0, ValueVector::zero()));

            println!(
                "{},{},{},{},{:.0},{},{},{:.4},{},{},{},{},{},{:.4},{:.4},{:.4},{}",
                position,
                seed,
                elapsed,
                iters,
                ips_window,
                t1_label,
                t1_visits,
                top1_share,
                entries_label(&sample.top3),
                entries_label(&sample.top5),
                sample.frontier.len(),
                frontier_label(&sample.frontier),
                frontier_visits_summary(&sample.frontier),
                t1_value.winrate,
                t1_value.coverage,
                t1_value.flex,
                sample.shortlist_size,
            );
            next_sample_idx += 1;
            continue;
        }
        let deadline = start + Duration::from_millis(target as u64);
        while Instant::now() < deadline {
            mcts.iterate();
        }
    }
}

fn main() {
    let fixture = procedural_fixture();
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
                    run_trajectory(&fixture, state, policy, fmode, seed, label, Some(20));
                }
            }
        }
    }
}
