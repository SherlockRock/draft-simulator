//! Post-process MCTS trajectory CSV + AB sanity CSV (dual aggregation:
//! max-by-lead AND mean-by-lead) into a comparison row per (position, seed).
//! Reads from docs/spikes/v3-data/. Run after mcts_bench AND ab_sanity have
//! produced their outputs.

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
    max_top1: String,
    max_top3: Vec<String>,
    max_top5: Vec<String>,
    mean_top1: String,
    mean_top3: Vec<String>,
    mean_top5: Vec<String>,
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

fn main() {
    let traj = fs::read_to_string("docs/spikes/v3-data/2026-05-06-mcts-bench-trajectory.csv")
        .expect("trajectory csv missing — run mcts_bench first");
    let ab = fs::read_to_string("docs/spikes/v3-data/2026-05-06-ab-sanity.csv")
        .expect("ab sanity csv missing — run ab_sanity first");

    // AB CSV: position, ab_max_top1, ab_max_top3, ab_max_top5,
    //         ab_mean_top1, ab_mean_top3, ab_mean_top5
    let mut ab_top: HashMap<String, AbTopK> = HashMap::new();
    for (i, line) in ab.lines().enumerate() {
        if i == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 7 {
            continue;
        }
        ab_top.insert(
            cols[0].to_string(),
            AbTopK {
                max_top1: cols[1].to_string(),
                max_top3: parse_pipe_set(cols[2]),
                max_top5: parse_pipe_set(cols[3]),
                mean_top1: cols[4].to_string(),
                mean_top3: parse_pipe_set(cols[5]),
                mean_top5: parse_pipe_set(cols[6]),
            },
        );
    }

    // MCTS trajectory: keep latest sample per (position, seed). Same column
    // layout as v2 (mcts_bench unchanged except new sample checkpoints).
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
        let entry = McsTopK {
            top1: top1_label,
            top3,
            top5,
            shortlist_size,
        };
        let key = (position, seed);
        let existing = mcts_latest.get(&key).map(|(e, _)| *e).unwrap_or(0);
        if elapsed >= existing {
            mcts_latest.insert(key, (elapsed, entry));
        }
    }

    println!(
        "position,seed,mcts_top1,mcts_top3,mcts_top5,\
         ab_max_top1,ab_max_top3,ab_max_top5,\
         ab_mean_top1,ab_mean_top3,ab_mean_top5,\
         max_top1_match,max_top3_overlap,max_top5_overlap,\
         mean_top1_match,mean_top3_overlap,mean_top5_overlap,\
         shortlist_recall_vs_ab_max5,shortlist_recall_vs_ab_mean5,\
         shortlist_size"
    );

    let mut keys: Vec<(String, String)> = mcts_latest.keys().cloned().collect();
    keys.sort();
    for (position, seed) in keys {
        let (_, mcts) = &mcts_latest[&(position.clone(), seed.clone())];
        let Some(ab) = ab_top.get(&position) else {
            continue;
        };

        let max_top1_match = if mcts.top1 == ab.max_top1 { 1 } else { 0 };
        let mean_top1_match = if mcts.top1 == ab.mean_top1 { 1 } else { 0 };
        let max_top3_overlap = mcts.top3.iter().filter(|m| ab.max_top3.contains(m)).count();
        let mean_top3_overlap = mcts.top3.iter().filter(|m| ab.mean_top3.contains(m)).count();
        let max_top5_overlap = mcts.top5.iter().filter(|m| ab.max_top5.contains(m)).count();
        let mean_top5_overlap = mcts.top5.iter().filter(|m| ab.mean_top5.contains(m)).count();
        let recall_max = ab.max_top5.iter().filter(|m| mcts.top5.contains(*m)).count();
        let recall_mean = ab.mean_top5.iter().filter(|m| mcts.top5.contains(*m)).count();

        println!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            position,
            seed,
            mcts.top1,
            mcts.top3.join("|"),
            mcts.top5.join("|"),
            ab.max_top1,
            ab.max_top3.join("|"),
            ab.max_top5.join("|"),
            ab.mean_top1,
            ab.mean_top3.join("|"),
            ab.mean_top5.join("|"),
            max_top1_match,
            max_top3_overlap,
            max_top5_overlap,
            mean_top1_match,
            mean_top3_overlap,
            mean_top5_overlap,
            recall_max,
            recall_mean,
            mcts.shortlist_size,
        );
    }
}
