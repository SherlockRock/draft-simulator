//! v5 absolute-quality evaluation harness.
//!
//! Replaces `sanity_compare.rs` for v5 measurement. Reads MCTS trajectory
//! and AB sanity CSVs from `docs/spikes/v5-data/`, computes
//! `absolute_quality` per (position × seed × engine) cell, emits CSV.
//!
//! Phase 0 stub: scaffolding only — the actual scorer lives in
//! `mcts_spike::eval::absolute_quality` and lands in phase 2. Until then
//! this binary panics at score time so it can't accidentally produce
//! v3/v4-style overlap-as-verdict numbers.
//!
//! See `docs/spikes/v5-metrics.md` for the metric definitions this consumes.
//!
//! Run with: cargo run --release --example v5_eval

use std::collections::HashMap;
use std::fs;

#[derive(Default, Clone, Debug)]
struct EngineRecommendation {
    engine: String,
    position: String,
    seed: String,
    /// MoveId::label format: `P:champion` or `P:a+b`.
    top1_label: String,
    /// `mcts_bench`-only: visit share at final sample. AB has no concept.
    top1_share: Option<f64>,
}

fn parse_pipe_set(s: &str) -> Vec<String> {
    if s.is_empty() || s == "<none>" {
        return Vec::new();
    }
    s.split('|')
        .map(|p| {
            let parts: Vec<&str> = p.split(':').collect();
            if parts.len() >= 2 {
                format!("{}:{}", parts[0], parts[1])
            } else {
                p.to_string()
            }
        })
        .collect()
}

fn load_mcts_recs(path: &str) -> Vec<EngineRecommendation> {
    let Ok(traj) = fs::read_to_string(path) else {
        return Vec::new();
    };
    // mcts_bench CSV columns:
    // position,seed,elapsed_ms,iters_completed,iter_per_sec_window,
    // top1_move,top1_visits,top1_share,top3_set,top5_set,
    // pareto_*,top1_value_*,shortlist_size
    let mut latest: HashMap<(String, String), (u128, EngineRecommendation)> = HashMap::new();
    for (i, line) in traj.lines().enumerate() {
        if i == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 17 {
            continue;
        }
        let position = cols[0].to_string();
        let seed = cols[1].to_string();
        let elapsed: u128 = cols[2].parse().unwrap_or(0);
        let top1 = cols[5].to_string();
        let share: f64 = cols[7].parse().unwrap_or(0.0);
        let entry = EngineRecommendation {
            engine: "mcts".into(),
            position: position.clone(),
            seed: seed.clone(),
            top1_label: top1,
            top1_share: Some(share),
        };
        let key = (position, seed);
        let existing = latest.get(&key).map(|(e, _)| *e).unwrap_or(0);
        if elapsed >= existing {
            latest.insert(key, (elapsed, entry));
        }
    }
    latest.into_iter().map(|(_, (_, e))| e).collect()
}

fn load_ab_recs(path: &str) -> Vec<EngineRecommendation> {
    let Ok(ab) = fs::read_to_string(path) else {
        return Vec::new();
    };
    // ab_sanity CSV columns: position, ab_top1, ab_top3_set, ab_top5_set
    // AB doesn't seed-vary; we emit one rec per position with seed="-".
    let mut out = Vec::new();
    for (i, line) in ab.lines().enumerate() {
        if i == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 4 {
            continue;
        }
        out.push(EngineRecommendation {
            engine: "ab".into(),
            position: cols[0].to_string(),
            seed: "-".into(),
            top1_label: cols[1].to_string(),
            top1_share: None,
        });
        // Suppress unused warning until phase 2 wires the `top3` / `top5`
        // columns into per-engine differentiating_signal output.
        let _ = parse_pipe_set(cols[2]);
        let _ = parse_pipe_set(cols[3]);
    }
    out
}

fn score_recommendation(_rec: &EngineRecommendation) -> f64 {
    // Phase 2 wires this to mcts_spike::eval::absolute_quality. Until then
    // this binary is a scaffold — running it should fail loud, not produce
    // misleading output.
    panic!(
        "v5_eval scoring not yet implemented — ships in phase 2. \
         See docs/spikes/v5-metrics.md."
    );
}

fn main() {
    // Default paths; CLI flags land in phase 1 alongside --fixture / --pool.
    let mcts_path = "docs/spikes/v5-data/2026-05-XX-mcts-bench-trajectory.csv";
    let ab_path = "docs/spikes/v5-data/2026-05-XX-ab-sanity.csv";

    let mut all_recs: Vec<EngineRecommendation> = Vec::new();
    all_recs.extend(load_mcts_recs(mcts_path));
    all_recs.extend(load_ab_recs(ab_path));
    all_recs.sort_by(|a, b| {
        (a.position.clone(), a.engine.clone(), a.seed.clone()).cmp(&(
            b.position.clone(),
            b.engine.clone(),
            b.seed.clone(),
        ))
    });

    println!("position,engine,seed,top1_label,top1_share,absolute_quality");
    for rec in &all_recs {
        let q = score_recommendation(rec);
        let share = rec
            .top1_share
            .map(|s| format!("{:.4}", s))
            .unwrap_or_else(|| "-".into());
        println!(
            "{},{},{},{},{},{:.4}",
            rec.position, rec.engine, rec.seed, rec.top1_label, share, q
        );
    }
}
