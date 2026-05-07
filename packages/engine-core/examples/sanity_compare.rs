//! v4 sanity comparison: joins MCTS trajectory CSV with AB sanity CSV into
//! a per-(position, seed) row of overlap metrics. Reads from
//! `docs/spikes/v4-data/`. Run after both `mcts_bench` and `ab_sanity` have
//! produced outputs.
//!
//! Drops v3's max-by-lead/mean-by-lead aggregation: with v4's pair-aware
//! MCTS, both engines produce the same shape of top-K (singletons or pairs
//! depending on turn type) and labels match `MoveId::label()` exactly. The
//! comparison is direct set-overlap over `top1` / `top3` / `top5`.

use std::collections::HashMap;
use std::fs;

#[derive(Default, Clone, Debug)]
struct McsTopK {
    top1: String,
    top3: Vec<String>,
    top5: Vec<String>,
    shortlist_size: usize,
}

#[derive(Default, Clone, Debug)]
struct AbTopK {
    top1: String,
    top3: Vec<String>,
    top5: Vec<String>,
}

fn parse_pipe_set(s: &str) -> Vec<String> {
    if s.is_empty() || s == "<none>" {
        return Vec::new();
    }
    s.split('|')
        .map(|p| {
            // Trajectory entries are `P:label:visits` — strip the trailing
            // `:visits` so the label matches AB's `P:label`. AB sanity rows
            // have only `P:label` to begin with so the strip is a no-op.
            let parts: Vec<&str> = p.split(':').collect();
            if parts.len() >= 2 {
                format!("{}:{}", parts[0], parts[1])
            } else {
                p.to_string()
            }
        })
        .collect()
}

fn main() {
    let traj = fs::read_to_string("docs/spikes/v4-data/2026-05-07-mcts-bench-trajectory.csv")
        .expect("trajectory csv missing — run mcts_bench first");
    let ab = fs::read_to_string("docs/spikes/v4-data/2026-05-07-ab-sanity.csv")
        .expect("ab sanity csv missing — run ab_sanity first");

    // AB CSV: position, ab_top1, ab_top3, ab_top5
    let mut ab_top: HashMap<String, AbTopK> = HashMap::new();
    for (i, line) in ab.lines().enumerate() {
        if i == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 4 {
            continue;
        }
        ab_top.insert(
            cols[0].to_string(),
            AbTopK {
                top1: cols[1].to_string(),
                top3: parse_pipe_set(cols[2]),
                top5: parse_pipe_set(cols[3]),
            },
        );
    }

    // MCTS trajectory: keep latest sample per (position, seed). Trajectory
    // CSV layout (mcts_bench): position,seed,elapsed_ms,iters,ips_window,
    // top1_label,top1_visits,top1_share,top3_set,top5_set,
    // pareto_*,top1_value_*,shortlist_size
    let mut mcts_latest: HashMap<(String, String), (u128, McsTopK)> = HashMap::new();
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
        let top1_label = cols[5].to_string();
        let top3 = parse_pipe_set(cols[8]);
        let top5 = parse_pipe_set(cols[9]);
        let shortlist_size: usize = cols[16].parse().unwrap_or(0);
        let entry = McsTopK { top1: top1_label, top3, top5, shortlist_size };
        let key = (position, seed);
        let existing = mcts_latest.get(&key).map(|(e, _)| *e).unwrap_or(0);
        if elapsed >= existing {
            mcts_latest.insert(key, (elapsed, entry));
        }
    }

    println!(
        "position,seed,mcts_top1,mcts_top3,mcts_top5,\
         ab_top1,ab_top3,ab_top5,\
         top1_match,top3_overlap,top5_overlap,\
         shortlist_recall_vs_ab_top5,shortlist_size"
    );

    let mut keys: Vec<(String, String)> = mcts_latest.keys().cloned().collect();
    keys.sort();
    for (position, seed) in keys {
        let (_, mcts) = &mcts_latest[&(position.clone(), seed.clone())];
        let Some(ab) = ab_top.get(&position) else {
            continue;
        };

        let top1_match = if mcts.top1 == ab.top1 { 1 } else { 0 };
        let top3_overlap = mcts.top3.iter().filter(|m| ab.top3.contains(m)).count();
        let top5_overlap = mcts.top5.iter().filter(|m| ab.top5.contains(m)).count();
        let recall = ab.top5.iter().filter(|m| mcts.top5.contains(*m)).count();

        println!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{}",
            position,
            seed,
            mcts.top1,
            mcts.top3.join("|"),
            mcts.top5.join("|"),
            ab.top1,
            ab.top3.join("|"),
            ab.top5.join("|"),
            top1_match,
            top3_overlap,
            top5_overlap,
            recall,
            mcts.shortlist_size,
        );
    }
}
