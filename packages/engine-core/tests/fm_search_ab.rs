//! Merge-blocking FM search A/B (design §5). Real production-config searches on
//! 48 real draft prefixes, FM on vs off, two modes, four thresholds.
//!
//!   nohup cargo test -p engine-core --release --test fm_search_ab -- --ignored --nocapture \
//!        > data/training/fm_search_ab.log 2>&1 &
//!
//! `FM_AB_STATES` (default 48) truncates the fixture list, in stratum order, so
//! a dry run is cheap. A report written from a truncated run is not a result and
//! must not be committed.

mod common;

use common::{
    eval_context, full_roster_pool, load_production_data, phase_weights_blue, phase_weights_red,
    repo_root,
};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{is_taken, ActionType, DraftState, Side, TURN_SEQUENCE};
use engine_core::engine::{ComputeRequest, Engine};
use engine_core::evaluator::MetaData;
use engine_core::fm::FmWeights;
use engine_core::pools::Penalties;
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search_with_stats, SearchParams};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// design §5: four fill strata, by masked-pick count. A = 10 masked picks,
/// B = 7–9, C = 4–6, D = 1–3.
const STRATA: [&[usize]; 4] = [&[0, 2, 4, 6], &[7, 8, 9], &[10, 11, 12, 14, 16], &[17, 18, 19]];
const STRATUM_NAMES: [&str; 4] = ["A", "B", "C", "D"];
const PER_STRATUM: usize = 12;
const REPS: usize = 3;
const DEPTH_MODE_MAX_DEPTH: usize = 2;
/// Depth-controlled mode only. A depth-2 search rooted at a pair-start turn spans
/// two consecutive pair plies, so production's `pair_branch_width: 500` makes the
/// depth-mode tree ~500² ≈ 250k leaves — measured at ~5 minutes per call, which
/// puts the 48-state run past a day. The node-count threshold compares *pruning
/// behaviour between the two arms* on an identical tree shape, and a narrower pair
/// tree serves that comparison exactly as well; both arms pay the same width, so
/// the ratio is unaffected. The budget-controlled mode keeps the full production
/// `pair_branch_width` (500) because that arm carries the latency claim.
const DEPTH_MODE_PAIR_BRANCH_WIDTH: usize = 25;
const WATCHDOG_MS: u64 = 60_000;

// backend/services/navigatorEngine.js:150-158, :20
const BRANCH_WIDTH: usize = 5;
const PAIR_BRANCH_WIDTH: usize = 500;
const BUDGET_MAX_DEPTH: usize = 8;
const LATENCY_BUDGET_MS: u64 = 5000;

const OFF: usize = 0;
const ON: usize = 1;

struct HoldoutRow {
    blue: [String; 5],
    red: [String; 5],
    bans: [String; 10],
}

/// engine-core has no csv crate and cannot import engine-node's `Csv` helper.
/// `holdout_drafts.csv` has no quoted fields (verified: zero `"` characters), so
/// split each line on ',' and index by the header names; keep rows whose
/// `evaluable` column is "True".
fn read_holdout(root: &std::path::Path) -> Vec<HoldoutRow> {
    let text = std::fs::read_to_string(root.join("data/training/holdout_drafts.csv"))
        .expect("holdout_drafts.csv");
    let mut lines = text.lines();
    let header: Vec<&str> = lines.next().expect("header").split(',').collect();
    let col = |name: &str| {
        header
            .iter()
            .position(|h| *h == name)
            .unwrap_or_else(|| panic!("column {name}"))
    };
    let slots: Vec<usize> = [
        "b_TOP", "b_JUNGLE", "b_MIDDLE", "b_BOTTOM", "b_UTILITY", "r_TOP", "r_JUNGLE", "r_MIDDLE",
        "r_BOTTOM", "r_UTILITY",
    ]
    .iter()
    .map(|c| col(c))
    .collect();
    let bans: Vec<usize> = (0..10)
        .map(|i| col(&format!("ban_{}{}", if i < 5 { "b" } else { "r" }, i % 5)))
        .collect();
    let evaluable = col("evaluable");
    lines
        .filter_map(|line| {
            let f: Vec<&str> = line.split(',').collect();
            if f.get(evaluable).copied() != Some("True") {
                return None;
            }
            let get = |i: usize| f[i].to_string();
            Some(HoldoutRow {
                blue: std::array::from_fn(|k| get(slots[k])),
                red: std::array::from_fn(|k| get(slots[5 + k])),
                bans: std::array::from_fn(|k| get(bans[k])),
            })
        })
        .collect()
}

/// An empty ban cell is a real "no ban" in the source data. The engine has no
/// null ban, so it gets a placeholder that no champion table contains — the same
/// convention as `engine-node/src/evaluator_scores_test.rs:133`.
fn ban_or_placeholder(v: &str, i: usize) -> String {
    if v.is_empty() {
        format!("__noban{i}")
    } else {
        v.to_string()
    }
}

fn prefix(row: &HoldoutRow, turn_index: usize) -> DraftState {
    let mut s = DraftState::default();
    let (mut b, mut r, mut bb, mut rb) = (0, 0, 0, 0);
    for t in &TURN_SEQUENCE[..turn_index] {
        match (t.action_type, t.side) {
            (ActionType::Pick, Side::Blue) => {
                s.blue_picks.push(row.blue[b].clone());
                b += 1;
            }
            (ActionType::Pick, Side::Red) => {
                s.red_picks.push(row.red[r].clone());
                r += 1;
            }
            (ActionType::Ban, Side::Blue) => {
                s.blue_bans.push(ban_or_placeholder(&row.bans[bb], bb));
                bb += 1;
            }
            (ActionType::Ban, Side::Red) => {
                s.red_bans.push(ban_or_placeholder(&row.bans[5 + rb], 5 + rb));
                rb += 1;
            }
        }
    }
    s
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

/// Population (ddof 0) standard deviation.
fn sd(v: &[f64]) -> f64 {
    let m = v.iter().sum::<f64>() / v.len() as f64;
    (v.iter().map(|x| (x - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt()
}

/// The production `ComputeRequest`: same pools, penalties, phase weights and
/// multipliers `eval_context` builds, with the backend's `maxDepth 8` and
/// `AB_COMPUTE_BUDGET_MS`. `meta_overrides` carries the arm.
fn production_request(
    state: &DraftState,
    our_side: Side,
    champion_meta: &HashMap<String, ChampionMeta>,
    meta: MetaData,
) -> ComputeRequest {
    let pool = full_roster_pool(champion_meta);
    ComputeRequest {
        state: state.clone(),
        our_side,
        our_pool: pool.clone(),
        opp_pool: pool,
        cross_game_exclusions: vec![],
        search_params: SearchParams {
            branch_width: BRANCH_WIDTH,
            pair_branch_width: PAIR_BRANCH_WIDTH,
            max_depth: BUDGET_MAX_DEPTH,
            disable_alpha_beta: false,
            forced_branches: vec![],
        },
        latency_budget_ms: LATENCY_BUDGET_MS,
        champion_meta: champion_meta.clone(),
        meta_overrides: Some(meta),
        phase_weights_blue: phase_weights_blue(),
        phase_weights_red: phase_weights_red(),
        // backend/services/navigatorEngine.js:167
        penalties: Penalties { out_of_role: 0.25, out_of_pool: 0.75 },
        // backend/services/navigatorEngine.js:168-171
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
    }
}

/// Returns `(wall_ms, depth_reached, top_move, timed_out, errored)`. `errored`
/// is a distinct flag from `timed_out` — controller ruling (fix round 1,
/// finding 3): an `Err` from `Engine::compute` must not silently masquerade as
/// an ordinary 60 s timeout. It still contributes `WATCHDOG_MS` to the wall
/// sum (conservative, as before), but is now printed and counted separately.
fn budget_run(
    engine: &Engine,
    req: ComputeRequest,
    state_idx: usize,
    arm_label: &str,
    rep: usize,
) -> (u64, usize, Vec<String>, bool, bool) {
    let cancel = CancelHandle::new();
    let watchdog = cancel.clone();
    let t0 = Instant::now();
    let guard = std::thread::spawn(move || {
        while t0.elapsed() < Duration::from_millis(WATCHDOG_MS) {
            std::thread::sleep(Duration::from_millis(50));
            if watchdog.is_cancelled() {
                return;
            }
        }
        watchdog.cancel();
    });
    let out = engine.compute(req, &cancel);
    let timed_out = cancel.is_cancelled();
    cancel.cancel();
    let _ = guard.join();
    match out {
        Ok(r) => (
            if timed_out { WATCHDOG_MS } else { r.compute_time_ms },
            r.depth_reached,
            r.tree.children.first().map(|c| c.champion_ids.clone()).unwrap_or_default(),
            timed_out,
            false,
        ),
        Err(err) => {
            eprintln!(
                "engine error: state {state_idx} arm {arm_label} rep {rep}: {err}"
            );
            (WATCHDOG_MS, 0, vec![], true, true)
        }
    }
}

fn how_many_states() -> usize {
    match std::env::var("FM_AB_STATES") {
        Ok(v) => v.trim().parse::<usize>().expect("FM_AB_STATES must be a number"),
        Err(_) => STRATA.len() * PER_STRATUM,
    }
}

#[test]
#[ignore]
fn fm_search_ab_thresholds() {
    let root = repo_root();
    let (meta_off, champion_meta) = load_production_data();
    let load = |p: &str| {
        Arc::new(
            FmWeights::from_json_str(&std::fs::read_to_string(root.join(p)).unwrap()).unwrap(),
        )
    };
    let seeds = [
        load("data/compiled/fm-weights.json"),
        load("data/training/fm-weights-seed1.json"),
        load("data/training/fm-weights-seed2.json"),
    ];
    let meta_on = MetaData { fm: Some(seeds[0].clone()), ..meta_off.clone() };
    seeds[0].reset_clamp_stats();

    // fixtures
    let rows = read_holdout(&root);
    let mut states = vec![]; // (stratum, turn, DraftState)
    let mut row_i = 0;
    for (si, turns) in STRATA.iter().enumerate() {
        for k in 0..PER_STRATUM {
            states.push((si, turns[k % turns.len()], prefix(&rows[row_i], turns[k % turns.len()])));
            row_i += 1;
        }
    }
    let wanted = how_many_states();
    let truncated = wanted < states.len();
    states.truncate(wanted);
    assert!(!states.is_empty(), "FM_AB_STATES must be at least 1");
    println!(
        "fm {} scale {:.6} | {} states ({} per stratum, {} reps) | depth mode d{} pair_bw {} | budget mode d{} {}ms",
        seeds[0].version,
        seeds[0].scale,
        states.len(),
        PER_STRATUM,
        REPS,
        DEPTH_MODE_MAX_DEPTH,
        DEPTH_MODE_PAIR_BRANCH_WIDTH,
        BUDGET_MAX_DEPTH,
        LATENCY_BUDGET_MS
    );
    if truncated {
        println!("*** FM_AB_STATES={wanted}: TRUNCATED RUN — not a result, do not commit the report ***");
    }

    // candidate-set spread + noise floor (no search)
    let roster = full_roster_pool(&champion_meta).search;
    let mut spreads = vec![];
    let mut floors = vec![];
    for (_, _, st) in &states {
        let side = st.current_turn().unwrap().side;
        let (team, opp) = if side == Side::Blue {
            (&st.blue_picks, &st.red_picks)
        } else {
            (&st.red_picks, &st.blue_picks)
        };
        let persp: Vec<_> = seeds.iter().map(|w| w.perspective(team, opp)).collect();
        let cands: Vec<&String> = roster
            .iter()
            .filter(|c| !is_taken(c, st) && seeds.iter().all(|w| w.champion(c).is_some()))
            .collect();
        let by_seed: Vec<Vec<f64>> = (0..3)
            .map(|k| {
                cands
                    .iter()
                    .map(|c| seeds[k].marginal(seeds[k].champion(c).unwrap(), &persp[k], false))
                    .collect()
            })
            .collect();
        spreads.push(sd(&by_seed[0]));
        let per_cand: Vec<f64> = (0..cands.len())
            .map(|j| sd(&[by_seed[0][j], by_seed[1][j], by_seed[2][j]]))
            .collect();
        floors.push(per_cand.iter().sum::<f64>() / per_cand.len() as f64);
    }
    let global_floor = floors.iter().sum::<f64>() / floors.len() as f64;
    let below_floor =
        spreads.iter().filter(|s| **s < global_floor).count() as f64 / spreads.len() as f64;

    // depth-controlled + budget-controlled, 3 reps, alternating order
    let engine = Engine::new(meta_off.clone(), champion_meta.clone());
    let mut nodes = vec![[vec![], vec![]]; states.len()]; // [off, on] per state
    let mut leaves = vec![[vec![], vec![]]; states.len()]; // stats.leaf_evaluations, [off, on]
    let mut pruned = vec![[vec![], vec![]]; states.len()]; // stats.nodes_pruned, [off, on]
    let mut walls = vec![[vec![], vec![]]; states.len()];
    let mut depths = vec![[vec![], vec![]]; states.len()];
    let mut timeouts: Vec<[Vec<bool>; 2]> = vec![[vec![], vec![]]; states.len()];
    let mut errored: Vec<[Vec<bool>; 2]> = vec![[vec![], vec![]]; states.len()];
    let mut agree_per_state: Vec<Vec<bool>> = vec![vec![]; states.len()];
    let mut top_agree = 0usize;
    for (i, (_, _, st)) in states.iter().enumerate() {
        let side = st.current_turn().unwrap().side;
        for rep in 0..REPS {
            let order: [usize; 2] = if (i + rep) % 2 == 0 { [OFF, ON] } else { [ON, OFF] };
            let mut tops: [Vec<String>; 2] = [vec![], vec![]];
            for arm in order {
                let meta = if arm == OFF { &meta_off } else { &meta_on };
                let ctx = eval_context(st, side, &champion_meta, meta);
                let params = SearchParams {
                    branch_width: BRANCH_WIDTH,
                    pair_branch_width: DEPTH_MODE_PAIR_BRANCH_WIDTH,
                    max_depth: DEPTH_MODE_MAX_DEPTH,
                    disable_alpha_beta: false,
                    forced_branches: vec![],
                };
                let (_, stats) = search_with_stats(st, &params, &ctx, &CancelHandle::new()).unwrap();
                nodes[i][arm].push(stats.nodes_evaluated as f64);
                leaves[i][arm].push(stats.leaf_evaluations as f64);
                pruned[i][arm].push(stats.nodes_pruned as f64);
                let req = production_request(st, side, &champion_meta, meta.clone());
                let arm_label = if arm == OFF { "off" } else { "on" };
                let (ms, depth, top, timed_out, arm_errored) =
                    budget_run(&engine, req, i, arm_label, rep);
                walls[i][arm].push(ms as f64);
                depths[i][arm].push(depth as f64);
                timeouts[i][arm].push(timed_out);
                errored[i][arm].push(arm_errored);
                tops[arm] = top;
            }
            let agreed = tops[OFF] == tops[ON];
            agree_per_state[i].push(agreed);
            if agreed {
                top_agree += 1;
            }
        }
        println!(
            "state {i:>2} turn {:>2}: nodes off/on {:?}/{:?} wall off/on {:?}/{:?}",
            st.turn_index(),
            nodes[i][OFF],
            nodes[i][ON],
            walls[i][OFF],
            walls[i][ON]
        );
    }
    let sum_med = |m: &Vec<[Vec<f64>; 2]>, arm: usize| {
        m.iter().map(|s| median(&mut s[arm].clone())).sum::<f64>()
    };
    let node_ratio = sum_med(&nodes, ON) / sum_med(&nodes, OFF);
    let wall_ratio = sum_med(&walls, ON) / sum_med(&walls, OFF);
    // Recorded, not gated (fix round 1, finding 2): at branch_width 5 / max_depth 2,
    // `nodes_evaluated` is fixed by the width configuration, so `node_ratio` is
    // structurally 1.000 and cannot fail. `leaf_evaluations` (actual `eval_state`
    // cache misses) is the quantity that can actually differ between arms.
    let leaf_ratio = sum_med(&leaves, ON) / sum_med(&leaves, OFF);
    let (scored, clamped) = seeds[0].clamp_stats();
    let clamp_frac = clamped as f64 / scored.max(1) as f64;
    let agreement = top_agree as f64 / (states.len() * REPS) as f64;

    // ---- report -----------------------------------------------------------
    let idx_sum_med = |m: &Vec<[Vec<f64>; 2]>, arm: usize, idx: &[usize]| {
        idx.iter().map(|&i| median(&mut m[i][arm].clone())).sum::<f64>()
    };
    let mut per_stratum = Vec::new();
    for (si, name) in STRATUM_NAMES.iter().enumerate() {
        let idx: Vec<usize> = states
            .iter()
            .enumerate()
            .filter(|(_, (s, _, _))| *s == si)
            .map(|(i, _)| i)
            .collect();
        if idx.is_empty() {
            continue;
        }
        let n_agree = idx.iter().map(|&i| agree_per_state[i].iter().filter(|a| **a).count()).sum::<usize>();
        per_stratum.push(json!({
            "stratum": name,
            "turns": STRATA[si],
            "n_states": idx.len(),
            "node_ratio": idx_sum_med(&nodes, ON, &idx) / idx_sum_med(&nodes, OFF, &idx),
            "leaf_ratio": idx_sum_med(&leaves, ON, &idx) / idx_sum_med(&leaves, OFF, &idx),
            "wall_ratio": idx_sum_med(&walls, ON, &idx) / idx_sum_med(&walls, OFF, &idx),
            "agreement": n_agree as f64 / (idx.len() * REPS) as f64,
            "mean_spread": idx.iter().map(|&i| spreads[i]).sum::<f64>() / idx.len() as f64,
            "mean_floor": idx.iter().map(|&i| floors[i]).sum::<f64>() / idx.len() as f64,
            "below_floor": idx.iter().filter(|&&i| spreads[i] < global_floor).count() as f64
                / idx.len() as f64,
        }));
    }

    let per_state: Vec<serde_json::Value> = states
        .iter()
        .enumerate()
        .map(|(i, (si, turn, _))| {
            json!({
                "index": i,
                "stratum": STRATUM_NAMES[*si],
                "turn": turn,
                "spread": spreads[i],
                "floor": floors[i],
                "nodes_off": nodes[i][OFF],
                "nodes_on": nodes[i][ON],
                "leaves_off": leaves[i][OFF],
                "leaves_on": leaves[i][ON],
                "pruned_off": pruned[i][OFF],
                "pruned_on": pruned[i][ON],
                "walls_off": walls[i][OFF],
                "walls_on": walls[i][ON],
                "depths_off": depths[i][OFF],
                "depths_on": depths[i][ON],
                "timed_out_off": timeouts[i][OFF],
                "timed_out_on": timeouts[i][ON],
                // Controller ruling (fix round 1, finding 3): counts, not per-rep
                // arrays like timed_out_off/on — a distinct signal from an
                // ordinary watchdog timeout. An errored run still counts as
                // timed_out above (conservative, unchanged), but is now visible
                // here and via the eprintln at the point of failure.
                "errored_off": errored[i][OFF].iter().filter(|x| **x).count(),
                "errored_on": errored[i][ON].iter().filter(|x| **x).count(),
                "top_move_agreement": agree_per_state[i],
            })
        })
        .collect();

    let timeouts_off: usize = timeouts.iter().map(|t| t[OFF].iter().filter(|x| **x).count()).sum();
    let timeouts_on: usize = timeouts.iter().map(|t| t[ON].iter().filter(|x| **x).count()).sum();
    let errored_off: usize = errored.iter().map(|t| t[OFF].iter().filter(|x| **x).count()).sum();
    let errored_on: usize = errored.iter().map(|t| t[ON].iter().filter(|x| **x).count()).sum();

    let thresholds = [
        ("clamp saturation", clamp_frac, 0.05, "<", clamp_frac < 0.05),
        ("candidate sets below the cross-seed floor", below_floor, 0.05, "<", below_floor < 0.05),
        ("depth-controlled node-count ratio (on/off)", node_ratio, 2.0, "<=", node_ratio <= 2.0),
        ("budget-controlled wall-time ratio (on/off)", wall_ratio, 1.5, "<=", wall_ratio <= 1.5),
    ];

    let doc = json!({
        "source": "cargo test -p engine-core --release --test fm_search_ab -- --ignored",
        "truncated_run": truncated,
        "fm_version": seeds[0].version,
        "fm_scale": seeds[0].scale,
        "config": {
            "strata": STRATA,
            "stratum_names": STRATUM_NAMES,
            "per_stratum": PER_STRATUM,
            "reps": REPS,
            "depth_mode_max_depth": DEPTH_MODE_MAX_DEPTH,
            "depth_mode_pair_branch_width": DEPTH_MODE_PAIR_BRANCH_WIDTH,
            "budget_mode_max_depth": BUDGET_MAX_DEPTH,
            "latency_budget_ms": LATENCY_BUDGET_MS,
            "watchdog_ms": WATCHDOG_MS,
            "branch_width": BRANCH_WIDTH,
            "pair_branch_width": PAIR_BRANCH_WIDTH,
            "penalties": {"out_of_role": 0.25, "out_of_pool": 0.75},
        },
        "global": {
            "clamp_frac": clamp_frac,
            "scored": scored,
            "clamped": clamped,
            "below_floor": below_floor,
            "global_floor": global_floor,
            "node_ratio": node_ratio,
            // Recorded, not gated — see the Deviations note in the .md report.
            "leaf_ratio": leaf_ratio,
            "wall_ratio": wall_ratio,
            "agreement": agreement,
            "n_states": states.len(),
            "reps": REPS,
            "depth_mode_max_depth": DEPTH_MODE_MAX_DEPTH,
            "timeouts_off": timeouts_off,
            "timeouts_on": timeouts_on,
            "errored_off": errored_off,
            "errored_on": errored_on,
        },
        "thresholds": thresholds.iter().map(|(name, value, limit, cmp, pass)| json!({
            "name": name, "value": value, "threshold": limit, "comparator": cmp, "pass": pass,
        })).collect::<Vec<_>>(),
        "per_stratum": per_stratum,
        "per_state": per_state,
    });

    let reports = root.join("scripts/model/reports");
    std::fs::create_dir_all(&reports).expect("create scripts/model/reports");
    std::fs::write(
        reports.join("fm_search_ab.json"),
        format!("{}\n", serde_json::to_string_pretty(&doc).expect("serialize report")),
    )
    .expect("write fm_search_ab.json");

    let mut md = String::new();
    md.push_str("# FM search A/B — merge-blocking thresholds (design §5)\n\n");
    md.push_str(&format!(
        "FM `{}` (scale {:.6}) vs the legacy evaluator, on {} real holdout draft prefixes,\n\
         {REPS} repetitions per state in alternating arm order, production search config.\n\n",
        seeds[0].version,
        seeds[0].scale,
        states.len()
    ));
    if truncated {
        md.push_str("> **TRUNCATED RUN** (`FM_AB_STATES`) — not a result.\n\n");
    }
    md.push_str(&format!(
        "**Deviations from the plan.** Depth-controlled mode uses `pair_branch_width {DEPTH_MODE_PAIR_BRANCH_WIDTH}` \
         instead of the plan's {PAIR_BRANCH_WIDTH}: a depth-2 search from a pair-start root spans two consecutive \
         pair plies, so 500 makes that tree ~500² leaves (~5 min per call, >1 day for the run). Both arms use the \
         same width, so the node-count ratio is unaffected. Budget-controlled mode is unchanged production config \
         (`branch_width {BRANCH_WIDTH}`, `pair_branch_width {PAIR_BRANCH_WIDTH}`, `max_depth {BUDGET_MAX_DEPTH}`, \
         {LATENCY_BUDGET_MS} ms budget, {WATCHDOG_MS} ms watchdog). At `branch_width {BRANCH_WIDTH}` / \
         `max_depth {DEPTH_MODE_MAX_DEPTH}`, `nodes_evaluated` is fixed by the width configuration, so gate 3 \
         is structurally 1.000 and cannot fail; the leaf-evaluation ratio below is the informative depth-mode \
         quantity, and re-pointing gate 3 at it is a design decision left to the user.\n\n"
    ));
    md.push_str("## Thresholds\n\n| check | value | threshold | result |\n| --- | ---: | ---: | --- |\n");
    for (name, value, limit, cmp, pass) in &thresholds {
        md.push_str(&format!(
            "| {name} | {value:.4} | {cmp} {limit:.2} | {} |\n",
            if *pass { "PASS" } else { "**FAIL**" }
        ));
    }
    md.push_str(&format!(
        "\nClamp counter: {clamped} clamped of {scored} scored. \
         Cross-seed noise floor: {global_floor:.5}.\n"
    ));
    md.push_str(&format!(
        "\n**Recorded, not gated** — root top-move agreement: {agreement:.4} \
         ({top_agree}/{} arm comparisons). Leaf-evaluation ratio (on/off): {leaf_ratio:.3}x \
         (sum over states of the per-state median of `leaf_evaluations`; see the Deviations note above). \
         Budget-mode watchdog timeouts: {timeouts_off} off, {timeouts_on} on (of {} runs each). \
         Engine errors: {errored_off} off, {errored_on} on.\n",
        states.len() * REPS,
        states.len() * REPS
    ));
    md.push_str("\n## Per stratum\n\n| stratum | turns | states | node ratio | leaf ratio | wall ratio | agreement | mean spread | mean floor | below floor |\n| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
    for s in &per_stratum {
        md.push_str(&format!(
            "| {} | `{}` | {} | {:.3} | {:.3} | {:.3} | {:.4} | {:.5} | {:.5} | {:.4} |\n",
            s["stratum"].as_str().unwrap_or("?"),
            s["turns"],
            s["n_states"],
            s["node_ratio"].as_f64().unwrap_or(f64::NAN),
            s["leaf_ratio"].as_f64().unwrap_or(f64::NAN),
            s["wall_ratio"].as_f64().unwrap_or(f64::NAN),
            s["agreement"].as_f64().unwrap_or(f64::NAN),
            s["mean_spread"].as_f64().unwrap_or(f64::NAN),
            s["mean_floor"].as_f64().unwrap_or(f64::NAN),
            s["below_floor"].as_f64().unwrap_or(f64::NAN),
        ));
    }
    md.push_str("\nEvery per-state number (nodes, leaves, pruned, walls, depths, timeouts, errors, per-rep agreement) is in `fm_search_ab.json`.\n");
    std::fs::write(reports.join("fm_search_ab.md"), md).expect("write fm_search_ab.md");
    println!("\nwrote {}", reports.join("fm_search_ab.md").display());
    println!(
        "clamp {clamp_frac:.4} | below_floor {below_floor:.4} (floor {global_floor:.5}) | \
         nodes {node_ratio:.3}x | wall {wall_ratio:.3}x | agreement {agreement:.4}"
    );

    assert!(clamp_frac < 0.05, "clamp saturation {clamp_frac:.4} ≥ 5%");
    assert!(below_floor < 0.05, "{below_floor:.4} of candidate sets have marginal spread below the cross-seed floor {global_floor:.5}");
    assert!(node_ratio <= 2.0, "depth-controlled node count ratio {node_ratio:.3} > 2×");
    assert!(wall_ratio <= 1.5, "budget-controlled wall-time ratio {wall_ratio:.3} > 1.5×");
}
