//! Post-process MCTS trajectory CSV + AB sanity CSV into a comparison row
//! per (position, seed). Reads from docs/spikes/v2-data/. Run after
//! mcts_bench AND ab_sanity have produced their outputs.

use std::collections::HashMap;
use std::fs;

#[derive(Default, Clone, Debug)]
struct McsTopK {
    top1: String,
    top3: Vec<String>,
    top5: Vec<String>,
    shortlist_size: usize,
}

/// Parse a pipe-separated set. Trajectory format is `P:CHAMP:VISITS|...`,
/// AB format is `P:CHAMP|...`. We strip the visit suffix if present so
/// both formats reduce to `P:CHAMP` for comparison.
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
    let traj = fs::read_to_string("docs/spikes/v2-data/2026-05-05-mcts-bench-trajectory.csv")
        .expect("trajectory csv missing — run mcts_bench first");
    let ab = fs::read_to_string("docs/spikes/v2-data/2026-05-05-ab-sanity.csv")
        .expect("ab sanity csv missing — run ab_sanity first");

    // Build AB lookup: position -> (top1, top3_set, top5_set).
    let mut ab_top: HashMap<String, (String, Vec<String>, Vec<String>)> = HashMap::new();
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
            (
                cols[1].to_string(),
                parse_pipe_set(cols[2]),
                parse_pipe_set(cols[3]),
            ),
        );
    }

    // Build MCTS lookup: keep latest sample per (position, seed).
    // Trajectory header: position,seed,elapsed_ms,iters_completed,
    //                    iter_per_sec_window,top1_move,top1_visits,top1_share,
    //                    top3_set,top5_set,pareto_frontier_size,
    //                    pareto_frontier_moves,visits_per_frontier_member,
    //                    top1_value_winrate,top1_value_coverage,top1_value_flex,
    //                    shortlist_size
    // Indices: 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16
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
         ab_top1,ab_top3,ab_top5,\
         top1_match,top3_overlap,top5_overlap,\
         mcts_top1_in_ab_top5,ab_top1_in_mcts_top5,\
         shortlist_recall_vs_ab_top5,shortlist_size"
    );

    let mut keys: Vec<(String, String)> = mcts_latest.keys().cloned().collect();
    keys.sort();
    for (position, seed) in keys {
        let (_, mcts) = &mcts_latest[&(position.clone(), seed.clone())];
        let Some((ab_t1, ab_t3, ab_t5)) = ab_top.get(&position) else {
            continue;
        };
        let top1_match = if &mcts.top1 == ab_t1 { 1 } else { 0 };
        let t3_overlap = mcts
            .top3
            .iter()
            .filter(|m| ab_t3.contains(m))
            .count();
        let t5_overlap = mcts
            .top5
            .iter()
            .filter(|m| ab_t5.contains(m))
            .count();
        let mcts_in_ab5 = if ab_t5.contains(&mcts.top1) { 1 } else { 0 };
        let ab_in_mcts5 = if mcts.top5.contains(ab_t1) { 1 } else { 0 };

        // Shortlist recall: of AB's top-5, how many appear in MCTS's top-5?
        // (Best-effort proxy for "did MCTS even consider these candidates" —
        // if shortlist_size>5 and MCTS visited them but ranked low, they
        // won't be here. Limitation noted in writeup.)
        let recall = ab_t5
            .iter()
            .filter(|m| mcts.top5.contains(*m))
            .count();

        println!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            position,
            seed,
            mcts.top1,
            mcts.top3.join("|"),
            mcts.top5.join("|"),
            ab_t1,
            ab_t3.join("|"),
            ab_t5.join("|"),
            top1_match,
            t3_overlap,
            t5_overlap,
            mcts_in_ab5,
            ab_in_mcts5,
            recall,
            mcts.shortlist_size,
        );
    }
}
