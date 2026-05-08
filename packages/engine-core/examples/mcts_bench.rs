//! MCTS spike v2 → v5 trajectory bench.
//!
//! Run with: cargo run --release --example mcts_bench
//!
//! Env config (v5 phase 1):
//!   SPIKE_FIXTURE=procedural|real    (default: procedural)
//!   SPIKE_POOL=full|narrow           (default: full)
//!   SPIKE_MAX_BUDGET_MS=<u64>        (default: 300000 — i.e. v4's 5 min)
//!   SPIKE_OUT=<path>                 (default: stdout)
//!
//! Emits CSV. Each row is one (position, seed, sample-checkpoint) observation.
//! Real-data positions use real champion ids from champion-meta.json.

use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::procedural_fixture::procedural_fixture;
use engine_core::mcts_spike::real_data_fixture::real_data_fixture;
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::{PoolContext, SpikeFixture, ValueVector};
use engine_core::pools::{RolePoolMap, TeamPool};
use std::io::Write;
use std::time::{Duration, Instant};

const FULL_SCHEDULE_MS: &[u128] = &[
    100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
    120_000, 180_000, 300_000,
];

fn position_label(idx: usize) -> &'static str {
    match idx {
        0 => "empty",
        1 => "after_bans1",
        2 => "mid_pick1",
        3 => "late",
        _ => "?",
    }
}

// --- Procedural fixture states (v4) ---

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

// --- Real-data fixture states (v5 phase 1) ---
//
// Picks/bans use real champion ids present in champion-meta.json. Slot
// indices match the procedural states (empty / after_bans1 / mid_pick1 =
// slot 9 = Blue pair_start / late = slot 17 = Blue pair_start).

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
            // 1 blue + 2 red = 3 picks done. Slot 9 = Blue pair_start.
            blue_picks: vec!["Camille".into()],
            red_picks: vec!["Graves".into(), "Syndra".into()],
            ..Default::default()
        },
        3 => DraftState {
            // 4 bans/side + 4 blue + 5 red = 17 events => slot 17 (B pair_start).
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

// --- Narrow-pool helpers ---

fn procedural_narrow_pool() -> TeamPool {
    // 5 champs per role from procedural fixture (i00..i04 across each role).
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
    // 5 champs per role × 5 roles = 25 champs. Pro-style pool of common
    // picks; both sides see it (mirrored). Champs all present in
    // champion-meta.json.
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

fn run_trajectory(
    fixture: &SpikeFixture,
    pools: &PoolContext,
    state: DraftState,
    policy: RolloutPolicy,
    fmode: FeasibilityMode,
    seed: u64,
    fixture_name: &str,
    pool_name: &str,
    position: &str,
    shortlist_k: Option<usize>,
    schedule: &[u128],
    out: &mut dyn Write,
) {
    use engine_core::mcts_spike::trajectory::{capture, entries_label, frontier_label, frontier_visits_summary};

    let mut mcts = Mcts::with_pools(
        fixture,
        state,
        pools,
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

    while next_sample_idx < schedule.len() {
        let elapsed = start.elapsed().as_millis();
        let target = schedule[next_sample_idx];
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

            writeln!(
                out,
                "{},{},{},{},{},{},{:.0},{},{},{:.4},{},{},{},{},{},{:.4},{:.4},{:.4},{}",
                fixture_name,
                pool_name,
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
            )
            .unwrap();
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
    let fixture_name = std::env::var("SPIKE_FIXTURE").unwrap_or_else(|_| "procedural".into());
    let pool_name = std::env::var("SPIKE_POOL").unwrap_or_else(|_| "full".into());
    let max_budget_ms: u128 = std::env::var("SPIKE_MAX_BUDGET_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300_000);
    let out_path = std::env::var("SPIKE_OUT").ok();

    // Truncate the sample schedule to fit max_budget_ms; always include the
    // final cap point so we get a budget-respecting endpoint sample.
    let mut schedule: Vec<u128> = FULL_SCHEDULE_MS
        .iter()
        .copied()
        .filter(|&t| t <= max_budget_ms)
        .collect();
    if schedule.last().copied() != Some(max_budget_ms) {
        schedule.push(max_budget_ms);
    }

    let (fixture, pools) = build_fixture_and_pools(&fixture_name, &pool_name);
    let policies = [RolloutPolicy::UniformFeasible];
    let fmodes = [FeasibilityMode::Cached];
    let seeds = [1u64, 42, 1337];
    let positions = 4usize;

    let mut writer: Box<dyn Write> = match out_path {
        Some(p) => Box::new(std::fs::File::create(p).expect("open out")),
        None => Box::new(std::io::stdout()),
    };

    writeln!(
        writer,
        "fixture,pool,position,seed,elapsed_ms,iters_completed,iter_per_sec_window,\
         top1_move,top1_visits,top1_share,top3_set,top5_set,\
         pareto_frontier_size,pareto_frontier_moves,visits_per_frontier_member,\
         top1_value_winrate,top1_value_coverage,top1_value_flex,shortlist_size"
    )
    .unwrap();

    for pos_idx in 0..positions {
        let label = position_label(pos_idx);
        for &fmode in &fmodes {
            for &policy in &policies {
                for &seed in &seeds {
                    let state = position_for(&fixture_name, pos_idx);
                    run_trajectory(
                        &fixture,
                        &pools,
                        state,
                        policy,
                        fmode,
                        seed,
                        &fixture_name,
                        &pool_name,
                        label,
                        Some(20),
                        &schedule,
                        writer.as_mut(),
                    );
                }
            }
        }
    }
}
