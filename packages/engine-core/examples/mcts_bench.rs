//! MCTS spike benchmark harness.
//!
//! Run with: cargo run --release --example mcts_bench
//!
//! Emits CSV to stdout. Each row is one (position, budget, policy, feasibility_mode, seed) run.

use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::SpikeFixture;
use engine_core::pools::Role;
use engine_core::role_solver::ChampionMeta;
use std::collections::HashMap;
use std::time::Instant;

fn build_fixture() -> SpikeFixture {
    // Procedurally generate ~80 champions across roles, with some flex.
    // Names are synthetic but role distribution is roughly LoL-shaped.
    let role_layout: &[(Role, &[Role], usize)] = &[
        // (primary, optional flex, count)
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
            // Every 4th champion of a role gets a flex secondary.
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
            // Spread winrates 0.46..0.54 deterministically.
            let wr = 0.46 + (((i * 7) % 9) as f64) / 100.0;
            winrates.insert(id.clone(), wr);
            all_champions.push(id);
        }
    }

    SpikeFixture {
        meta,
        winrates,
        all_champions,
    }
}

fn position_empty() -> DraftState {
    DraftState::default()
}

fn position_after_bans1() -> DraftState {
    // Six bans done — about to start Pick 1.
    DraftState {
        blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
        red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
        ..Default::default()
    }
}

fn position_mid_pick1() -> DraftState {
    // Six bans + first three Pick 1 actions: B1, R1+R2 (pair), B2 (start of pair).
    DraftState {
        blue_bans: vec!["T00".into(), "J04".into(), "M08".into()],
        red_bans: vec!["A00".into(), "S00".into(), "M00".into()],
        blue_picks: vec!["T01".into()],
        red_picks: vec!["J00".into(), "M04".into()],
        ..Default::default()
    }
}

fn position_late() -> DraftState {
    // Through Pick1 + Ban2 + first Pick2 — two picks remaining (B5, R5).
    DraftState {
        blue_bans: vec!["T00".into(), "J04".into(), "M08".into(), "T08".into()],
        red_bans: vec!["A00".into(), "S00".into(), "M00".into(), "J08".into()],
        blue_picks: vec![
            "T01".into(),
            "M01".into(),
            "J01".into(),
            "A01".into(),
        ],
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

fn policy_label(p: RolloutPolicy) -> &'static str {
    match p {
        RolloutPolicy::UniformFeasible => "uniform",
        RolloutPolicy::WinrateWeightedFeasible => "winrate",
    }
}

fn fmode_label(f: FeasibilityMode) -> &'static str {
    match f {
        FeasibilityMode::Cached => "cached",
        FeasibilityMode::Uncached => "uncached",
    }
}

fn run_one(
    fixture: &SpikeFixture,
    state: DraftState,
    budget: u32,
    policy: RolloutPolicy,
    fmode: FeasibilityMode,
    seed: u64,
) -> (u128, String, u32, f64, String, f64) {
    let mut mcts = Mcts::new(
        fixture,
        state,
        McTsConfig {
            policy,
            feasibility_mode: fmode,
            seed,
        },
    );
    let start = Instant::now();
    for _ in 0..budget {
        mcts.iterate();
    }
    let wall_ms = start.elapsed().as_millis();

    let dist = mcts.root_visit_distribution();
    let total: u32 = dist.iter().map(|(_, v, _)| *v).sum();
    if dist.is_empty() {
        return (wall_ms, "<none>".into(), 0, 0.0, "<none>".into(), 0.0);
    }
    let top = &dist[0];
    let top1_share = if total > 0 {
        top.1 as f64 / total as f64
    } else {
        0.0
    };
    let top3: Vec<String> = dist
        .iter()
        .take(3)
        .map(|(mv, _, _)| {
            format!(
                "{}:{}",
                if mv.is_pick { "P" } else { "B" },
                mv.champion
            )
        })
        .collect();
    let top3_set = top3.join("|");
    (
        wall_ms,
        format!(
            "{}:{}",
            if top.0.is_pick { "P" } else { "B" },
            top.0.champion
        ),
        top.1,
        top1_share,
        top3_set,
        top.2.composite(),
    )
}

fn main() {
    let fixture = build_fixture();

    // Budget grid kept tight; uncached at high budgets blows out.
    // Spike-time matrix; widen if any cell looks promising and we want more
    // resolution.
    let cached_budgets = [2_000u32, 20_000];
    let uncached_budgets = [1_000u32];
    let policies = [
        RolloutPolicy::UniformFeasible,
        RolloutPolicy::WinrateWeightedFeasible,
    ];
    let seeds = [1u64, 42];
    let position_count = 4;

    println!(
        "position,budget,policy,feasibility_mode,seed,wall_ms,iters_per_sec,top1_move,top1_visits,top1_share,top3_set,top1_value"
    );

    for pos_idx in 0..position_count {
        let label = position_label(pos_idx);
        for &fmode in &[FeasibilityMode::Cached, FeasibilityMode::Uncached] {
            let budgets: &[u32] = match fmode {
                FeasibilityMode::Cached => &cached_budgets,
                FeasibilityMode::Uncached => &uncached_budgets,
            };
            for &budget in budgets {
                for &policy in &policies {
                    for &seed in &seeds {
                        let state = make_position(pos_idx);
                        let (wall_ms, top1, top1_visits, top1_share, top3_set, top1_value) =
                            run_one(&fixture, state, budget, policy, fmode, seed);
                        let ips = if wall_ms > 0 {
                            (budget as f64) * 1000.0 / (wall_ms as f64)
                        } else {
                            f64::INFINITY
                        };
                        println!(
                            "{},{},{},{},{},{},{:.0},{},{},{:.3},{},{:.4}",
                            label,
                            budget,
                            policy_label(policy),
                            fmode_label(fmode),
                            seed,
                            wall_ms,
                            ips,
                            top1,
                            top1_visits,
                            top1_share,
                            top3_set,
                            top1_value,
                        );
                    }
                }
            }
        }
    }
}
