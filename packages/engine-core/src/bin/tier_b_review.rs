//! The Tier B review runner's entry point (design docs/designs/tier-b-review-tool-design.md § 2, T9):
//! loads the production data and the fixture corpus, runs `tier_b_review::run_review`, and writes the
//! `tier-b-run/1` JSON. Never built for production (`backend/Dockerfile` builds `engine-node` only).
//!
//! Configured by environment, defaults in brackets:
//!   TIER_B_JSON          output path (required: a usage error before any search); `summary.txt` is
//!                        written beside it
//!   TIER_B_P             [0.08,0.09,0.095,0.1,0.105,0.11,0.12,0.15]
//!   TIER_B_Q             [0,0.02,0.05,0.08,0.1,0.15]
//!   TIER_B_W             [0.5,1,1.5,2,3]  synergy weights; each w other than the default 1 adds one
//!                        weighted arm at the reference P and Q, searched in its own universe. A
//!                        repeat, and 1, add nothing; `-0` is read as 0; a value the universe refuses
//!                        (negative, NaN, infinite) is a usage error before any search
//!   TIER_B_WIDTHS        [30,60,100]  singles, pairs, root off-pool
//!   TIER_B_HORIZON       [2]
//!   TIER_B_K             [10]
//!   TIER_B_JOBS          [max(1, cores - 2)]
//!   TIER_B_DEPTH_CHECK   [on]; `0` turns it off
//!   TIER_B_FIXTURES      [<repo>/packages/engine-core/fixtures/tier-b]
//!   TIER_B_RUN_ID        [the current UTC time, YYYY-MM-DDTHH:MM:SSZ]

#[path = "../../tests/common/mod.rs"]
mod common;

use engine_core::fm::FmWeights;
use engine_core::reference::live::{LiveUniverse, DEFAULT_SYNERGY_WEIGHT};
use engine_core::reference::search::Shortlist;
use engine_core::reference::tier_b::TierBFixture;
use engine_core::reference::tier_b_review::{
    render_summary, run_review_with, EngineStamp, ReviewConfig, NEAR_TIE_MARGIN,
};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_P: &str = "0.08,0.09,0.095,0.1,0.105,0.11,0.12,0.15";
const DEFAULT_Q: &str = "0,0.02,0.05,0.08,0.1,0.15";
const DEFAULT_W: &str = "0.5,1,1.5,2,3";
const DEFAULT_WIDTHS: &str = "30,60,100";
const NODE_BUDGET: u64 = 20_000_000;

fn die(message: &str) -> ! {
    eprintln!("tier_b_review: {message}");
    std::process::exit(2)
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn parse<T: FromStr>(name: &str, text: &str) -> T {
    text.trim()
        .parse()
        .unwrap_or_else(|_| die(&format!("{name}: cannot read {text:?}")))
}

fn list<T: FromStr>(name: &str, default: &str) -> Vec<T> {
    var(name)
        .unwrap_or_else(|| default.to_string())
        .split(',')
        .map(|part| parse(name, part))
        .collect()
}

fn scalar<T: FromStr>(name: &str, default: T) -> T {
    var(name).map_or(default, |v| parse(name, &v))
}

/// `YYYY-MM-DDTHH:MM:SSZ` of the current UTC time (days-to-civil, Hinnant's algorithm).
fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

/// Stdout of `git -C <root> <args>`, `None` where git is missing or the command fails.
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
    let Some(json_path) = var("TIER_B_JSON").map(PathBuf::from) else {
        die("TIER_B_JSON is required: the path the run JSON is written to");
    };
    let widths: Vec<usize> = list("TIER_B_WIDTHS", DEFAULT_WIDTHS);
    let [singles, pairs, root_off_pool] = widths[..] else {
        die("TIER_B_WIDTHS takes three widths: singles,pairs,root_off_pool");
    };
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    let root = common::repo_root();
    let fixtures = var("TIER_B_FIXTURES").map_or_else(
        || root.join("packages/engine-core/fixtures/tier-b"),
        PathBuf::from,
    );

    let meta_path = root.join("data/compiled/champion-meta.json");
    let fm = FmWeights::from_json_str(
        &std::fs::read_to_string(root.join("data/compiled/fm-weights.json"))
            .unwrap_or_else(|e| die(&format!("fm-weights.json: {e}"))),
    )
    .unwrap_or_else(|e| die(&format!("fm-weights.json: {e}")));
    let meta_json: Value = serde_json::from_str(
        &std::fs::read_to_string(&meta_path)
            .unwrap_or_else(|e| die(&format!("{}: {e}", meta_path.display()))),
    )
    .unwrap_or_else(|e| die(&format!("{}: {e}", meta_path.display())));
    let text_at = |path: &[&str]| {
        path.iter()
            .try_fold(&meta_json, |v, key| v.get(*key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let version = text_at(&["version"]).unwrap_or_else(|| die("champion-meta.json has no version"));
    let positions_patch = text_at(&["sources", "positions", "decidingPatch"])
        .unwrap_or_else(|| die("champion-meta.json has no sources.positions.decidingPatch"));
    let (_, meta) = common::load_production_data_from(&meta_path);
    let playable_rule = meta_json
        .get("sources")
        .and_then(|v| v.get("positions"))
        .and_then(|v| v.get("playableRule"))
        .cloned();
    // `-0` is read as 0 (`+ 0.0`), so it can never make a second arm id `w-0`; a repeat of any weight,
    // and the default, add no arm.
    let mut weights: Vec<f64> = Vec::new();
    for w in list::<f64>("TIER_B_W", DEFAULT_W) {
        let w = w + 0.0;
        if w != DEFAULT_SYNERGY_WEIGHT && !weights.contains(&w) {
            weights.push(w);
        }
    }
    let live = LiveUniverse::build_weighted(&fm, &version, &meta, DEFAULT_SYNERGY_WEIGHT)
        .unwrap_or_else(|e| die(&format!("the live universe: {e}")));
    let weighted: Vec<LiveUniverse> = weights
        .iter()
        .map(|w| {
            LiveUniverse::build_weighted(&fm, &version, &meta, *w)
                .unwrap_or_else(|e| die(&format!("TIER_B_W: {e}")))
        })
        .collect();
    let loaded = TierBFixture::load_dir(&fixtures, &live)
        .unwrap_or_else(|e| die(&format!("{}: {e}", fixtures.display())));

    let cfg = ReviewConfig {
        ps: list("TIER_B_P", DEFAULT_P),
        qs: list("TIER_B_Q", DEFAULT_Q),
        shortlist: Shortlist {
            singles,
            pairs,
            root_off_pool,
        },
        horizon: scalar("TIER_B_HORIZON", 2),
        k: scalar("TIER_B_K", 10),
        margin: NEAR_TIE_MARGIN,
        jobs: scalar("TIER_B_JOBS", cores.saturating_sub(2)).max(1),
        depth_check: var("TIER_B_DEPTH_CHECK").as_deref() != Some("0"),
        node_budget: NODE_BUDGET,
        run_id: var("TIER_B_RUN_ID").unwrap_or_else(utc_now),
        engine: EngineStamp {
            name: "reference".to_string(),
            commit: git(&root, &["rev-parse", "--short", "HEAD"]),
            // The fixtures are left out (`tier-b:apply` edits them between runs), and so is `.claude/`
            // (the main checkout always carries it untracked).
            dirty: git(
                &root,
                &[
                    "status",
                    "--porcelain",
                    "--",
                    ".",
                    ":!packages/engine-core/fixtures/tier-b",
                    ":!.claude",
                ],
            )
            .map(|status| !status.is_empty()),
        },
        positions_patch,
        playable_rule,
    };

    let started = Instant::now();
    let run = run_review_with(&loaded, &live, &weighted, &cfg);
    let file = std::fs::File::create(&json_path)
        .unwrap_or_else(|e| die(&format!("{}: {e}", json_path.display())));
    let mut out = std::io::BufWriter::new(file);
    serde_json::to_writer_pretty(&mut out, &run)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            writeln!(out)
                .and_then(|()| out.flush())
                .map_err(|e| e.to_string())
        })
        .unwrap_or_else(|e| die(&format!("{}: {e}", json_path.display())));
    // The summary lands beside the run JSON, so one directory holds one run's whole record.
    let summary_path = json_path.with_file_name("summary.txt");
    std::fs::write(&summary_path, render_summary(&run))
        .unwrap_or_else(|e| die(&format!("{}: {e}", summary_path.display())));
    eprintln!(
        "tier_b_review: {} positions, {} arms, {} load errors, {:.1} s on {} jobs, wrote {}",
        run.positions.len(),
        run.run.arms.len(),
        run.load_errors.len(),
        started.elapsed().as_secs_f64(),
        cfg.jobs,
        json_path.display()
    );
    for e in &run.load_errors {
        eprintln!("tier_b_review: load error: {e}");
    }
}
