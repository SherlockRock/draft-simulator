//! One-shot diagnostic dump of SearchStats across a few representative
//! scenarios. Used for the engine article — captures pruning ratio,
//! transposition hit rate, node counts, and wall-clock timing.
//!
//! Marked `#[ignore]` so it doesn't run on default `cargo test`. To capture:
//!
//!   cargo test --release --test article_stats -- --ignored --nocapture

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side, TURN_SEQUENCE};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::rayon_pool::ensure_rayon_pool;
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search_with_stats, SearchParams};
use std::collections::HashMap;
use std::thread;
use std::time::{Duration, Instant};

fn pool_with(champs: &[String]) -> TeamPool {
    TeamPool {
        display: RolePoolMap {
            top: vec![],
            jungle: vec![],
            middle: vec![],
            adc: vec![],
            support: vec![],
        },
        search: champs.to_vec(),
    }
}

fn weights_blue() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.65, comp: 0.35, coverage: 0.0 },
        pick1: PhaseWeights { info: 0.5, comp: 0.5, coverage: 0.0 },
        ban2: PhaseWeights { info: 0.4, comp: 0.6, coverage: 0.0 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8, coverage: 0.0 },
    }
}

fn weights_red() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { info: 0.7, comp: 0.3, coverage: 0.0 },
        pick1: PhaseWeights { info: 0.6, comp: 0.4, coverage: 0.0 },
        ban2: PhaseWeights { info: 0.5, comp: 0.5, coverage: 0.0 },
        pick2: PhaseWeights { info: 0.2, comp: 0.8, coverage: 0.0 },
    }
}

fn fast_forward_to_slot(state: &mut DraftState, slot: usize) {
    for i in 0..slot {
        let id = format!("filler{i}");
        match (TURN_SEQUENCE[i].action_type, TURN_SEQUENCE[i].side) {
            (ActionType::Ban, Side::Blue) => state.blue_bans.push(id),
            (ActionType::Ban, Side::Red) => state.red_bans.push(id),
            (ActionType::Pick, Side::Blue) => state.blue_picks.push(id),
            (ActionType::Pick, Side::Red) => state.red_picks.push(id),
        }
    }
}

fn fixture(start_slot: usize) -> (DraftState, EvalContext) {
    let champs: Vec<String> = (0..171).map(|i| format!("c{i:03}")).collect();
    let roles = [Role::Top, Role::Jungle, Role::Middle, Role::Adc, Role::Support];
    let champion_meta: HashMap<String, ChampionMeta> = champs
        .iter()
        .enumerate()
        .map(|(i, champ)| {
            (
                champ.clone(),
                ChampionMeta {
                    id: champ.clone(),
                    positions: vec![roles[i % roles.len()]],
                    ..Default::default()
                },
            )
        })
        .collect();

    let pool = pool_with(&champs);
    let mut state = DraftState::default();
    fast_forward_to_slot(&mut state, start_slot);

    let ctx = EvalContext {
        side: Side::Blue,
        phase: Phase::Pick1,
        our_pool: pool.clone(),
        opp_pool: pool,
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.25, out_of_pool: 0.75 },
        champion_meta,
        meta: MetaData::default(),
        phase_weights_blue: weights_blue(),
        phase_weights_red: weights_red(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
    };

    (state, ctx)
}

fn run_and_print(label: &str, start_slot: usize, max_depth: usize, branch_width: usize, ab: bool) {
    let (state, ctx) = fixture(start_slot);
    let params = SearchParams {
        branch_width,
        max_depth,
        disable_alpha_beta: !ab,
        forced_branches: vec![],
    };
    let cancel = CancelHandle::new();
    let t0 = Instant::now();
    let (_tree, stats) =
        search_with_stats(&state, &params, &ctx, &cancel).expect("search should complete");
    let elapsed = t0.elapsed();

    let total = stats.nodes_evaluated + stats.nodes_pruned;
    let pruned_pct = if total > 0 {
        100.0 * stats.nodes_pruned as f64 / total as f64
    } else {
        0.0
    };
    let cache_hit_pct = if stats.cache_entries > 0 {
        100.0 * stats.transpositions_found as f64
            / (stats.transpositions_found + stats.cache_entries) as f64
    } else {
        0.0
    };

    eprintln!(
        "{label:50} | {ms:>7.1}ms | eval={ev:>7} pruned={pr:>7} ({pct:>5.1}%) | tx_hits={hits:>6} entries={ent:>6} ({hit_pct:>5.1}%)",
        ms = elapsed.as_secs_f64() * 1000.0,
        ev = stats.nodes_evaluated,
        pr = stats.nodes_pruned,
        pct = pruned_pct,
        hits = stats.transpositions_found,
        ent = stats.cache_entries,
        hit_pct = cache_hit_pct,
    );
}

#[test]
#[ignore]
fn dump_stats_for_article() {
    ensure_rayon_pool();

    eprintln!();
    eprintln!(
        "{:50} | {:>9} | {:>34} | {:>32}",
        "scenario", "wall", "alpha-beta", "transposition"
    );
    eprintln!("{}", "-".repeat(140));

    // Pair-pick turns (slot 7 == pair_start in TURN_SEQUENCE)
    run_and_print("pair@7  bw=8 d=4 αβ=on",  7, 4, 8, true);
    run_and_print("pair@7  bw=8 d=4 αβ=OFF", 7, 4, 8, false);
    run_and_print("pair@7  bw=8 d=6 αβ=on",  7, 6, 8, true);
    run_and_print("pair@7  bw=8 d=8 αβ=on",  7, 8, 8, true);

    // Single-slot turns
    run_and_print("single@0  bw=8 d=4 αβ=on",  0, 4, 8, true);  // first ban
    run_and_print("single@0  bw=8 d=4 αβ=OFF", 0, 4, 8, false);
    run_and_print("single@12 bw=8 d=4 αβ=on",  12, 4, 8, true); // start of Ban2

    // Branch-width sensitivity
    run_and_print("pair@7  bw=4  d=4 αβ=on",  7, 4, 4, true);
    run_and_print("pair@7  bw=12 d=4 αβ=on",  7, 4, 12, true);

    eprintln!();
}

/// Runs the search on a separate thread with a watchdog `CancelHandle`. If the
/// search completes within `budget`, returns Ok((stats, elapsed)). If the
/// budget expires, fires the cancel and returns Err(elapsed_at_cancel).
fn run_with_budget(
    start_slot: usize,
    max_depth: usize,
    branch_width: usize,
    ab: bool,
    budget: Duration,
) -> Result<(engine_core::search::SearchStats, Duration), Duration> {
    let (state, ctx) = fixture(start_slot);
    let params = SearchParams {
        branch_width,
        max_depth,
        disable_alpha_beta: !ab,
        forced_branches: vec![],
    };
    let cancel = CancelHandle::new();
    let cancel_for_search = cancel.clone();

    let t0 = Instant::now();
    let handle = thread::spawn(move || {
        search_with_stats(&state, &params, &ctx, &cancel_for_search)
    });

    // Poll completion at fine granularity so wall-time on quick scenarios is accurate.
    let deadline = t0 + budget;
    while Instant::now() < deadline {
        if handle.is_finished() {
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }

    if !handle.is_finished() {
        cancel.cancel();
        let _ = handle.join();
        return Err(t0.elapsed());
    }

    match handle.join().expect("search thread panicked") {
        Ok((_, stats)) => Ok((stats, t0.elapsed())),
        Err(_) => Err(t0.elapsed()),
    }
}

fn print_ladder_row(label: &str, result: Result<(engine_core::search::SearchStats, Duration), Duration>) {
    match result {
        Ok((stats, elapsed)) => {
            let total = stats.nodes_evaluated + stats.nodes_pruned;
            let pruned_pct = if total > 0 {
                100.0 * stats.nodes_pruned as f64 / total as f64
            } else {
                0.0
            };
            let hit_pct = if stats.cache_entries + stats.transpositions_found > 0 {
                100.0 * stats.transpositions_found as f64
                    / (stats.transpositions_found + stats.cache_entries) as f64
            } else {
                0.0
            };
            eprintln!(
                "{label:36} | {ms:>9.1}ms | eval={ev:>9} pruned={pr:>10} ({pct:>5.1}%) | tx_hits={hits:>7} entries={ent:>8} ({hit_pct:>5.1}%)",
                ms = elapsed.as_secs_f64() * 1000.0,
                ev = stats.nodes_evaluated,
                pr = stats.nodes_pruned,
                pct = pruned_pct,
                hits = stats.transpositions_found,
                ent = stats.cache_entries,
            );
        }
        Err(elapsed) => {
            eprintln!(
                "{label:36} | TIMEOUT after {ms:.1}ms (cancelled, did not complete)",
                ms = elapsed.as_secs_f64() * 1000.0,
            );
        }
    }
}

/// "How deep can we go from slot 0?" Stops once a single scenario exceeds the
/// per-scenario budget, since deeper variants will only be slower.
#[test]
#[ignore]
fn depth_ladder_from_slot_zero() {
    ensure_rayon_pool();

    eprintln!();
    eprintln!("FULL-TREE FEASIBILITY — slot 0, 171-champ pool, αβ on");
    eprintln!("{}", "=".repeat(140));
    eprintln!(
        "{:36} | {:>11} | {:>40} | {:>34}",
        "scenario", "wall", "alpha-beta", "transposition"
    );
    eprintln!("{}", "-".repeat(140));

    let budget = Duration::from_secs(60);

    for &bw in &[4usize, 6, 8] {
        for &depth in &[4usize, 6, 8, 10, 12, 14, 17] {
            let label = format!("from@0  bw={bw:<2} d={depth:<2}");
            let result = run_with_budget(0, depth, bw, true, budget);
            let timed_out = result.is_err();
            print_ladder_row(&label, result);
            if timed_out {
                eprintln!("(skipping deeper bw={bw} variants — would also exceed budget)");
                break;
            }
        }
        eprintln!();
    }

    eprintln!("(budget per scenario: 60s; TIMEOUT means search was cancelled mid-flight)");
    eprintln!();
}
