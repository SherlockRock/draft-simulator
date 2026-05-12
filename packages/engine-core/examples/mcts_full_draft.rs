//! Full 20-turn draft simulation. Runs MCTS for `BUDGET_MS` per turn, picks
//! per `RerootVariant`, reroots into the chosen child, runs again, until the
//! draft is complete. Emits a CSV row per turn × seed × variant.
//!
//! Two variants per seed:
//!  - top1: always reroot into the engine's top-1 move (happy path)
//!  - top3_random: uniformly pick one of the engine's top-3 moves
//!    (models "user chose a Pareto alternative").

use engine_core::draft_state::DraftState;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::procedural_fixture::procedural_fixture;
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::tree::MoveId;
use engine_core::mcts_spike::{SpikeFixture, ValueVector};
use std::time::{Duration, Instant};

const BUDGET_MS: u64 = 60_000;
const SHORTLIST_K: usize = 20;

#[derive(Clone, Copy, Debug)]
enum RerootVariant {
    Top1,
    Top3Random,
}

fn variant_label(v: RerootVariant) -> &'static str {
    match v {
        RerootVariant::Top1 => "top1",
        RerootVariant::Top3Random => "top3_random",
    }
}

fn move_label(mv: &MoveId) -> String {
    mv.label()
}

fn pick_chosen(
    dist: &[(MoveId, u32, ValueVector)],
    variant: RerootVariant,
    seed: u64,
    turn_idx: usize,
) -> Option<MoveId> {
    if dist.is_empty() {
        return None;
    }
    match variant {
        RerootVariant::Top1 => Some(dist[0].0.clone()),
        RerootVariant::Top3Random => {
            // Deterministic selection from top-3 keyed on (seed, turn_idx).
            let pool_len = dist.len().min(3);
            let key = seed.wrapping_mul(1000003).wrapping_add(turn_idx as u64);
            let idx = (key as usize) % pool_len;
            Some(dist[idx].0.clone())
        }
    }
}

fn run_one(seed: u64, variant: RerootVariant, fixture: &SpikeFixture) {
    let initial_state = DraftState::default();
    let mut mcts = Mcts::new(
        fixture,
        initial_state,
        McTsConfig {
            policy: RolloutPolicy::UniformFeasible,
            feasibility_mode: FeasibilityMode::Cached,
            seed,
            root_shortlist_k: Some(SHORTLIST_K),
            flex_weight: 1.0,
        },
    );

    let mut turn_idx = 0usize;
    while turn_idx < 20 {
        let turn_start = Instant::now();
        let inherited_visits = mcts.inherited_visits_at_reroot();
        let tree_visits_at_start = mcts.total_iterations();

        let deadline = turn_start + Duration::from_millis(BUDGET_MS);
        while Instant::now() < deadline {
            mcts.iterate();
        }

        let elapsed_ms = turn_start.elapsed().as_millis();
        let dist = mcts.root_visit_distribution();
        if dist.is_empty() {
            break;
        }
        let total: u32 = dist.iter().map(|(_, v, _)| *v).sum();
        let top1_share = if total > 0 { dist[0].1 as f64 / total as f64 } else { 0.0 };
        let frontier = engine_core::mcts_spike::pareto::root_pareto_frontier(&mcts);
        let frontier_size = frontier.len();
        let frontier_label = frontier
            .iter()
            .map(|f| f.mv.label())
            .collect::<Vec<_>>()
            .join("|");
        let frontier_visits_avg: u32 = if frontier.is_empty() {
            0
        } else {
            frontier.iter().map(|f| f.visits).sum::<u32>() / frontier.len() as u32
        };
        let total_visits_at_end = mcts.total_iterations();
        let new_visits = total_visits_at_end.saturating_sub(tree_visits_at_start);
        let tree_reuse_ratio = if total_visits_at_end > 0 {
            inherited_visits as f64 / (inherited_visits as f64 + new_visits as f64).max(1.0)
        } else {
            0.0
        };

        let top3: Vec<String> = dist.iter().take(3).map(|(mv, _, _)| move_label(mv)).collect();
        let top5: Vec<String> = dist.iter().take(5).map(|(mv, _, _)| move_label(mv)).collect();

        println!(
            "{},{},{},{},{},{:.4},{},{},{},{},{},{},{},{},{:.4}",
            turn_idx,
            seed,
            variant_label(variant),
            elapsed_ms,
            dist[0].1,
            top1_share,
            move_label(&dist[0].0),
            top3.join("|"),
            top5.join("|"),
            frontier_size,
            frontier_label,
            frontier_visits_avg,
            inherited_visits,
            new_visits,
            tree_reuse_ratio,
        );

        let chosen = match pick_chosen(&dist, variant, seed, turn_idx) {
            Some(m) => m,
            None => break,
        };
        if mcts.reroot_to(&chosen).is_err() {
            break;
        }
        turn_idx += 1;
    }
}

fn main() {
    let fixture = procedural_fixture();
    let seeds = [1u64, 42, 1337];
    let variants = [RerootVariant::Top1, RerootVariant::Top3Random];

    println!(
        "turn_idx,seed,variant,elapsed_ms,top1_visits,top1_share,\
         top1_move,top3_set,top5_set,\
         pareto_frontier_size,pareto_frontier_moves,visits_per_frontier_avg,\
         inherited_visits,new_visits,tree_reuse_ratio"
    );
    for &seed in &seeds {
        for &variant in &variants {
            run_one(seed, variant, &fixture);
        }
    }
}
