//! v5 absolute-quality evaluation harness.
//!
//! Reads MCTS trajectory CSVs and AB sanity CSVs from `docs/spikes/v5-data/`,
//! reconstructs the (state, recommendation) tuple from each row using
//! `mcts_spike::v5_states`, scores via `mcts_spike::eval::absolute_quality`,
//! and emits per-(fixture × pool × position × seed × engine) absolute-
//! quality scores.
//!
//! Run with:
//!   cargo run --release --example v5_eval -- \
//!     --mcts-glob 'docs/spikes/v5-data/2026-05-08-mcts-bench-*.csv' \
//!     --ab-glob   'docs/spikes/v5-data/2026-05-08-ab-sanity-*.csv' \
//!     --out       'docs/spikes/v5-data/2026-05-08-v5-eval.csv'
//!
//! Default paths land at the v5-data dir and 2026-05-08 captures so a
//! bare invocation produces the canonical phase-3 output.
//!
//! See `docs/spikes/v5-metrics.md` for the metric definition this consumes.

use engine_core::draft_state::{DraftState, Side};
use engine_core::mcts_spike::eval::{absolute_quality, Recommendation};
use engine_core::mcts_spike::v5_states::{position_for, position_label};
use engine_core::mcts_spike::SpikeFixture;
use engine_core::mcts_spike::procedural_fixture::procedural_fixture;
use engine_core::mcts_spike::real_data_fixture::real_data_fixture;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const POSITIONS: &[&str] = &["empty", "after_bans1", "mid_pick1", "late"];

#[derive(Clone, Debug)]
struct Cell {
    fixture: String,
    pool: String,
    position: String,
    engine: String,
    seed: String,
    /// MoveId::label format, e.g. "P:Jinx" or "P:Jinx+Thresh" or "B:Karma".
    top1_label: String,
    /// Only set for MCTS rows; AB has no concept.
    top1_share: Option<f64>,
    /// Only set for MCTS rows; final-sample elapsed_ms.
    final_elapsed_ms: Option<u128>,
}

fn parse_top1(label: &str) -> (bool, Vec<String>) {
    // `P:Champion` or `P:First+Second` or `B:Champion`.
    let mut parts = label.splitn(2, ':');
    let prefix = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("");
    let is_pick = prefix == "P";
    let champs: Vec<String> = body.split('+').map(|s| s.to_string()).collect();
    (is_pick, champs)
}

fn position_idx(label: &str) -> Option<usize> {
    POSITIONS.iter().position(|p| *p == label)
}

/// Pick the appropriate fixture for scoring. The scorer needs access to
/// champion-meta (positions, damage/cc/scaling/tags) and winrates. Both
/// fixtures contain those — the choice matters only because procedural
/// vs real have different champion ids in their states. (The scorer doesn't
/// pull from a pool; pools affect what was considered, not how it scores.)
fn fixture_for(name: &str) -> SpikeFixture {
    if name == "real" {
        real_data_fixture()
    } else {
        procedural_fixture()
    }
}

fn load_mcts_csv(path: &Path) -> Vec<Cell> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    // mcts_bench v5 columns:
    // fixture,pool,position,seed,elapsed_ms,iters_completed,iter_per_sec_window,
    // top1_move,top1_visits,top1_share,top3_set,top5_set,
    // pareto_*,top1_value_*,shortlist_size
    let mut latest: HashMap<(String, String, String, String, String), (u128, Cell)> =
        HashMap::new();
    for (i, line) in raw.lines().enumerate() {
        if i == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 18 {
            continue;
        }
        let fixture = cols[0].to_string();
        let pool = cols[1].to_string();
        let position = cols[2].to_string();
        let seed = cols[3].to_string();
        let elapsed: u128 = cols[4].parse().unwrap_or(0);
        let top1 = cols[7].to_string();
        let share: f64 = cols[9].parse().unwrap_or(0.0);
        let cell = Cell {
            fixture: fixture.clone(),
            pool: pool.clone(),
            position: position.clone(),
            engine: "mcts".into(),
            seed: seed.clone(),
            top1_label: top1,
            top1_share: Some(share),
            final_elapsed_ms: Some(elapsed),
        };
        let key = (fixture, pool, position, "mcts".into(), seed);
        let existing = latest.get(&key).map(|(e, _)| *e).unwrap_or(0);
        if elapsed >= existing {
            latest.insert(key, (elapsed, cell));
        }
    }
    latest.into_iter().map(|(_, (_, c))| c).collect()
}

fn load_ab_csv(path: &Path) -> Vec<Cell> {
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    // ab_sanity v5 columns: fixture,pool,position,ab_top1,ab_top3_set,ab_top5_set
    let mut out = Vec::new();
    for (i, line) in raw.lines().enumerate() {
        if i == 0 || line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 4 {
            continue;
        }
        out.push(Cell {
            fixture: cols[0].to_string(),
            pool: cols[1].to_string(),
            position: cols[2].to_string(),
            engine: "ab".into(),
            seed: "-".into(),
            top1_label: cols[3].to_string(),
            top1_share: None,
            final_elapsed_ms: None,
        });
    }
    out
}

/// Score one engine-recommendation cell against `absolute_quality`. The
/// scorer needs the picking-side perspective: state's `current_turn().side`
/// at the time of the recommendation. For ban recommendations we score the
/// post-ban state with no champion added (recommendation = no-op for our
/// picks — bans don't change blue_picks/red_picks).
fn score_cell(cell: &Cell) -> Option<f64> {
    let pos_idx = position_idx(&cell.position)?;
    let state = position_for(&cell.fixture, pos_idx);
    let our_side = state.current_turn().map(|t| t.side).unwrap_or(Side::Blue);
    let fixture = fixture_for(&cell.fixture);

    let (is_pick, champs) = parse_top1(&cell.top1_label);

    if is_pick {
        let recommendation = if champs.len() >= 2 {
            Recommendation::pair(champs[0].clone(), champs[1].clone(), our_side)
        } else if champs.len() == 1 {
            Recommendation::singleton(champs[0].clone(), our_side)
        } else {
            return None;
        };
        return Some(absolute_quality(
            &state,
            &recommendation,
            &fixture.meta,
            &fixture.winrates,
        ));
    }

    // Ban recommendation: append it to the appropriate side's bans, score
    // the picking side's existing partial comp (no pick added). This treats
    // a ban as a no-op-on-our-comp action — we score what our picks
    // currently look like, conditioned on the ban being effective.
    // Use a no-op recommendation: empty champion_ids on our side. Since
    // absolute_quality projects our picks then evaluates the projected
    // partial comp, an empty extension scores the pre-pick state.
    let mut state_after_ban = state.clone();
    if champs.len() == 1 {
        match our_side {
            Side::Blue => state_after_ban.blue_bans.push(champs[0].clone()),
            Side::Red => state_after_ban.red_bans.push(champs[0].clone()),
        }
    }
    let no_op = Recommendation {
        champion_ids: Vec::new(),
        side: our_side,
    };
    Some(absolute_quality(
        &state_after_ban,
        &no_op,
        &fixture.meta,
        &fixture.winrates,
    ))
}

fn arg_value(args: &[String], flag: &str) -> Option<String> {
    let mut iter = args.iter();
    while let Some(a) = iter.next() {
        if a == flag {
            return iter.next().cloned();
        }
        if let Some(stripped) = a.strip_prefix(&format!("{}=", flag)) {
            return Some(stripped.to_string());
        }
    }
    None
}

fn glob_resolve(pattern: &str) -> Vec<std::path::PathBuf> {
    // Cheap glob: support trailing `*` only. The v5 capture set has fixed
    // suffixes (procedural-full/narrow, real-full/narrow); a real glob
    // crate isn't worth a dependency here.
    if let Some(prefix) = pattern.strip_suffix("*.csv") {
        let dir_idx = prefix.rfind('/').unwrap_or(0);
        let (dir, file_prefix) = prefix.split_at(dir_idx + 1);
        let dir = if dir.is_empty() { "." } else { dir };
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with(file_prefix) && name.ends_with(".csv") {
                    out.push(p);
                }
            }
        }
        out.sort();
        out
    } else {
        // Treat as literal path.
        vec![std::path::PathBuf::from(pattern)]
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mcts_glob = arg_value(&args, "--mcts-glob")
        .unwrap_or_else(|| "docs/spikes/v5-data/2026-05-08-mcts-bench-*.csv".into());
    let ab_glob = arg_value(&args, "--ab-glob")
        .unwrap_or_else(|| "docs/spikes/v5-data/2026-05-08-ab-sanity-*.csv".into());
    let out_path = arg_value(&args, "--out");

    let mut cells: Vec<Cell> = Vec::new();
    for p in glob_resolve(&mcts_glob) {
        cells.extend(load_mcts_csv(&p));
    }
    for p in glob_resolve(&ab_glob) {
        cells.extend(load_ab_csv(&p));
    }
    cells.sort_by(|a, b| {
        (
            a.fixture.clone(),
            a.pool.clone(),
            a.position.clone(),
            a.engine.clone(),
            a.seed.clone(),
        )
            .cmp(&(
                b.fixture.clone(),
                b.pool.clone(),
                b.position.clone(),
                b.engine.clone(),
                b.seed.clone(),
            ))
    });

    let mut writer: Box<dyn std::io::Write> = match out_path {
        Some(p) => Box::new(std::fs::File::create(p).expect("open out")),
        None => Box::new(std::io::stdout()),
    };

    use std::io::Write;
    writeln!(
        writer,
        "fixture,pool,position,engine,seed,top1_label,top1_share,final_elapsed_ms,absolute_quality"
    )
    .unwrap();
    let mut scored = 0usize;
    let mut skipped = 0usize;
    for cell in &cells {
        let Some(q) = score_cell(cell) else {
            skipped += 1;
            continue;
        };
        let share = cell
            .top1_share
            .map(|s| format!("{:.4}", s))
            .unwrap_or_else(|| "-".into());
        let elapsed = cell
            .final_elapsed_ms
            .map(|e| e.to_string())
            .unwrap_or_else(|| "-".into());
        writeln!(
            writer,
            "{},{},{},{},{},{},{},{},{:.4}",
            cell.fixture,
            cell.pool,
            cell.position,
            cell.engine,
            cell.seed,
            cell.top1_label,
            share,
            elapsed,
            q,
        )
        .unwrap();
        scored += 1;
    }
    eprintln!(
        "v5_eval: scored {} cells, skipped {} (unparseable position label or empty CSV)",
        scored, skipped
    );
    let _ = (DraftState::default(), position_label(0)); // imports kept live
}
