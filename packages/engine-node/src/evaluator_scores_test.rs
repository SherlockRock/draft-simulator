//! Task 5 — the CURRENT evaluator's scores, for the gate-1 sibling comparison
//! and the gate-5 throughput number.
//!
//! `eval_state` is private, but the public `search()` at a TERMINAL DraftState
//! returns the root `TreeNode` whose `scores.composite_per_side` IS
//! `eval_state` (`search.rs:194-196`: with no current turn the recursion takes
//! the leaf branch immediately). So no new engine-core API is needed — which
//! also makes this the regression harness Phase 3 reuses.
//!
//! Terminal means all 20 actions are present, so the drafts carry their bans.
//! Bans do not enter `side_total` — only the picks do — but without them
//! `turn_index` is 10 and `search()` would search rather than evaluate.
//!
//! Production `EvalContext`, per the plan: the backend's DEFAULT_PHASE_WEIGHTS,
//! all four multipliers 1.0, EMPTY pools with `Penalties { out_of_role: 0,
//! out_of_pool: 0 }` so `pool_multiplier` is exactly 1.0 for every champion
//! (`pools.rs:59-65`), and phase Pick2 (which is what `phase_for_state` returns
//! at a terminal state anyway).
//!
//!   cargo test -p engine-node --release evaluator_scores -- --ignored --nocapture

use std::collections::HashMap;
use std::fs;
use std::time::Instant;

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::evaluator::{score_pick, EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::pools::{Penalties, Role, RolePoolMap, TeamPool};
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search_with_stats, SearchParams};

use crate::data_loader::load_engine_data;
use crate::solver_roles_test::{load_meta_with_synthesis, repo_root, Csv, SLOT_COLUMNS};

const BAN_COLUMNS: [&str; 10] = [
    "ban_b0", "ban_b1", "ban_b2", "ban_b3", "ban_b4",
    "ban_r0", "ban_r1", "ban_r2", "ban_r3", "ban_r4",
];

/// backend/services/navigatorEngine.js:31-43
fn phase_weights_blue() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { comp: 0.35, info: 0.65, coverage: 0.0 },
        pick1: PhaseWeights { comp: 0.5, info: 0.5, coverage: 0.3 },
        ban2: PhaseWeights { comp: 0.6, info: 0.4, coverage: 0.4 },
        pick2: PhaseWeights { comp: 0.8, info: 0.2, coverage: 1.5 },
    }
}

fn phase_weights_red() -> PhaseWeightTable {
    PhaseWeightTable {
        ban1: PhaseWeights { comp: 0.3, info: 0.7, coverage: 0.0 },
        pick1: PhaseWeights { comp: 0.4, info: 0.6, coverage: 0.3 },
        ban2: PhaseWeights { comp: 0.5, info: 0.5, coverage: 0.4 },
        pick2: PhaseWeights { comp: 0.8, info: 0.2, coverage: 1.5 },
    }
}

fn empty_pool() -> TeamPool {
    TeamPool {
        display: RolePoolMap {
            top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![],
        },
        search: vec![],
    }
}

fn production_context(
    state: &DraftState,
    champion_meta: HashMap<String, ChampionMeta>,
    meta: MetaData,
) -> EvalContext {
    EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool: empty_pool(),
        opp_pool: empty_pool(),
        our_picks: state.blue_picks.clone(),
        opp_picks: state.red_picks.clone(),
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta,
        meta,
        phase_weights_blue: phase_weights_blue(),
        phase_weights_red: phase_weights_red(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
    }
}

/// (blue_total, red_total) — the static evaluation of a finished draft.
fn evaluate_terminal(state: &DraftState, ctx: &EvalContext) -> (f64, f64) {
    debug_assert!(state.is_complete(), "search() only evaluates at a terminal state");
    let params = SearchParams { max_depth: 0, ..SearchParams::default() };
    let cancel = CancelHandle::new();
    let (tree, _stats) =
        search_with_stats(state, &params, ctx, &cancel).expect("terminal search cannot fail");
    (tree.scores.composite_per_side.blue, tree.scores.composite_per_side.red)
}

/// The candidate's OWN `compStrength` at `state`, scored from its side's
/// perspective. This is what design §3's `scale` statistic averages the
/// within-set sd of; `side_total` composites are not it.
fn candidate_comp_strength(
    state: &DraftState,
    slot: usize,
    candidate: &str,
    ctx: &EvalContext,
    champion_meta: &HashMap<String, ChampionMeta>,
) -> f64 {
    let side = if slot < 5 { Side::Blue } else { Side::Red };
    let side_ctx = ctx.for_perspective(side, state, Phase::Pick2);
    let role = champion_meta
        .get(candidate)
        .and_then(|m| m.positions.first().copied())
        .unwrap_or(Role::Top);
    score_pick(candidate, role, state, &side_ctx, ActionType::Pick).compStrength
}

fn draft_from_row(csv: &Csv, row: &[String]) -> DraftState {
    let mut state = DraftState::default();
    for (i, col) in SLOT_COLUMNS.iter().enumerate() {
        let champ = csv.get(row, col).to_string();
        if i < 5 { state.blue_picks.push(champ) } else { state.red_picks.push(champ) }
    }
    for (i, col) in BAN_COLUMNS.iter().enumerate() {
        let v = csv.get(row, col);
        // A forfeited ban still has to occupy its turn or the state is not
        // terminal. `side_total` never reads bans, so a placeholder is inert.
        let champ = if v.is_empty() { format!("__noban{i}") } else { v.to_string() };
        if i < 5 { state.blue_bans.push(champ) } else { state.red_bans.push(champ) }
    }
    debug_assert_eq!(state.turn_index(), 20);
    state
}

#[test]
#[ignore]
fn evaluator_scores_for_holdout_and_sibling_sets() {
    let root = repo_root();
    let (meta, champion_meta) = load_engine_data(
        &root.join("data/compiled/champion-meta.json"),
        &root.join("data/compiled/matchup-data.json"),
    )
    .expect("compiled engine data loads");

    let holdout = Csv::read(&root.join("data/training/holdout_drafts.csv"));
    println!("holdout rows: {}", holdout.rows.len());

    // ---- throughput FIRST: it is gate 5's number and it sizes N ----
    let sample: Vec<DraftState> = holdout
        .rows
        .iter()
        .take(100)
        .map(|r| draft_from_row(&holdout, r))
        .collect();
    let ctx = production_context(&sample[0], champion_meta.clone(), meta.clone());
    let t0 = Instant::now();
    let mut checksum = 0.0;
    for state in &sample {
        let (b, r) = evaluate_terminal(state, &ctx);
        checksum += b - r;
    }
    let elapsed = t0.elapsed();
    let per_eval = elapsed.as_secs_f64() / sample.len() as f64;
    println!(
        "\nGATE 5 — evaluator throughput: {} terminal evaluations in {:.1} ms \
         = {:.0} evaluations/second ({:.1} us each)  [checksum {:.3}]",
        sample.len(),
        elapsed.as_secs_f64() * 1e3,
        1.0 / per_eval,
        per_eval * 1e6,
        checksum
    );

    // Gate 5 reads the MEASURED rate from this file; benchmark.py refuses to
    // fall back to a constant.
    fs::write(
        root.join("data/training/evaluator_throughput.json"),
        format!(
            "{{\n  \"evals_per_second\": {:.1},\n  \"n\": {},\n  \"us_per_eval\": {:.1}\n}}\n",
            1.0 / per_eval,
            sample.len(),
            per_eval * 1e6
        ),
    )
    .expect("write evaluator_throughput.json");

    let siblings = Csv::read(&root.join("data/training/sibling_sets.csv"));
    let n_sets = siblings.rows.iter().filter(|r| siblings.get(r, "evaluable") == "True").count();
    let n_cand: usize = siblings
        .rows
        .first()
        .map(|r| siblings.get(r, "candidates").split_whitespace().count())
        .unwrap_or(0);
    println!(
        "sibling sets: {} evaluable of {}; N = {} candidates -> {} evaluations, \
         projected {:.1} s at the measured rate",
        n_sets,
        siblings.rows.len(),
        n_cand,
        n_sets * n_cand,
        n_sets as f64 * n_cand as f64 * per_eval
    );

    // ---- 1. full-draft scores over the EVALUABLE holdout rows ----
    let mut out = String::from("match_id,blue_total,red_total,score_blue_minus_red\n");
    let mut scored = 0usize;
    let t1 = Instant::now();
    for row in &holdout.rows {
        if holdout.get(row, "evaluable") != "True" {
            continue; // champion-meta cannot score a draft containing Locke
        }
        let state = draft_from_row(&holdout, row);
        let ctx = production_context(&state, champion_meta.clone(), meta.clone());
        let (b, r) = evaluate_terminal(&state, &ctx);
        out.push_str(&format!(
            "{},{b:.6},{r:.6},{:.6}\n",
            holdout.get(row, "match_id"),
            b - r
        ));
        scored += 1;
    }
    fs::write(root.join("data/training/evaluator_scores.csv"), &out).expect("write");
    println!("\nevaluator_scores.csv: {scored} drafts in {:.1} s", t1.elapsed().as_secs_f64());

    // ---- 2. sibling candidate scores ----
    let by_match: HashMap<&str, &Vec<String>> = holdout
        .rows
        .iter()
        .map(|r| (holdout.get(r, "match_id"), r))
        .collect();
    let mut sib_out = String::from(
        "match_id,slot,candidate,is_true_pick,blue_total,red_total,score_for_picker,comp_strength\n",
    );
    let mut sib_scored = 0usize;
    let t2 = Instant::now();
    for row in &siblings.rows {
        if siblings.get(row, "evaluable") != "True" {
            continue;
        }
        let match_id = siblings.get(row, "match_id");
        let Some(base_row) = by_match.get(match_id) else { continue };
        let slot: usize = siblings.get(row, "slot").parse().expect("slot");
        let true_pick = siblings.get(row, "true_alias").to_string();
        let base = draft_from_row(&holdout, base_row);

        for candidate in siblings.get(row, "candidate_aliases").split_whitespace() {
            let mut state = base.clone();
            if slot < 5 {
                state.blue_picks[slot] = candidate.to_string();
            } else {
                state.red_picks[slot - 5] = candidate.to_string();
            }
            let ctx = production_context(&state, champion_meta.clone(), meta.clone());
            let (b, r) = evaluate_terminal(&state, &ctx);
            // Value TO THE PICKING SIDE — that is what the pick is chosen for.
            let picker = if slot < 5 { b - r } else { r - b };
            let comp = candidate_comp_strength(&state, slot, candidate, &ctx, &champion_meta);
            sib_out.push_str(&format!(
                "{match_id},{slot},{candidate},{},{b:.6},{r:.6},{picker:.6},{comp:.6}\n",
                candidate == true_pick
            ));
            sib_scored += 1;
        }
    }
    fs::write(root.join("data/training/evaluator_sibling_scores.csv"), &sib_out).expect("write");
    println!(
        "evaluator_sibling_scores.csv: {sib_scored} candidate evaluations in {:.1} s",
        t2.elapsed().as_secs_f64()
    );
    assert!(scored > 0 && sib_scored > 0);
}

// --- guards ---------------------------------------------------------------

#[test]
fn terminal_search_returns_the_static_evaluation_not_a_search() {
    let root = repo_root();
    let (meta, champion_meta) = load_engine_data(
        &root.join("data/compiled/champion-meta.json"),
        &root.join("data/compiled/matchup-data.json"),
    )
    .expect("engine data");
    let mut state = DraftState::default();
    for c in ["Gnar", "Sejuani", "Ahri", "Jinx", "Thresh"] {
        state.blue_picks.push(c.into());
    }
    for c in ["Renekton", "Viego", "Orianna", "Ezreal", "Leona"] {
        state.red_picks.push(c.into());
    }
    for i in 0..5 {
        state.blue_bans.push(format!("__noban{i}"));
        state.red_bans.push(format!("__noban{}", i + 5));
    }
    assert!(state.is_complete());
    let ctx = production_context(&state, champion_meta, meta);

    let params = SearchParams { max_depth: 0, ..SearchParams::default() };
    let cancel = CancelHandle::new();
    let (tree, stats) = search_with_stats(&state, &params, &ctx, &cancel).unwrap();
    // Exactly one evaluation and no expansion: this is eval_state, not a search.
    assert_eq!(stats.leaf_evaluations, 1);
    assert_eq!(stats.nodes_evaluated, 0);
    assert!(tree.children.is_empty());
    assert!(tree.scores.composite_per_side.blue.is_finite());
    assert!(tree.scores.composite_per_side.red.is_finite());
}

#[test]
fn swapping_the_two_teams_swaps_the_two_totals() {
    // If it did not, "blue - red" would not be a side-consistent score and the
    // sibling ranking would be measuring the harness, not the evaluator.
    let root = repo_root();
    let (meta, champion_meta) = load_engine_data(
        &root.join("data/compiled/champion-meta.json"),
        &root.join("data/compiled/matchup-data.json"),
    )
    .expect("engine data");
    let blue = ["Gnar", "Sejuani", "Ahri", "Jinx", "Thresh"];
    let red = ["Renekton", "Viego", "Orianna", "Ezreal", "Leona"];
    let build = |b: &[&str; 5], r: &[&str; 5]| {
        let mut s = DraftState::default();
        b.iter().for_each(|c| s.blue_picks.push((*c).into()));
        r.iter().for_each(|c| s.red_picks.push((*c).into()));
        for i in 0..5 {
            s.blue_bans.push(format!("__noban{i}"));
            s.red_bans.push(format!("__noban{}", i + 5));
        }
        s
    };
    let s1 = build(&blue, &red);
    let s2 = build(&red, &blue);
    let (b1, r1) = evaluate_terminal(&s1, &production_context(&s1, champion_meta.clone(), meta.clone()));
    let (b2, r2) = evaluate_terminal(&s2, &production_context(&s2, champion_meta, meta));
    assert!((b1 - r2).abs() < 1e-9, "blue total did not follow its team: {b1} vs {r2}");
    assert!((r1 - b2).abs() < 1e-9, "red total did not follow its team: {r1} vs {b2}");
}

#[test]
fn empty_pools_with_zero_penalties_do_not_scale_any_champion() {
    let (meta, _) = load_meta_with_synthesis();
    let pool = empty_pool();
    let penalties = Penalties { out_of_role: 0.0, out_of_pool: 0.0 };
    for role in [
        engine_core::pools::Role::Top,
        engine_core::pools::Role::Support,
    ] {
        let (m, _tier) = engine_core::pools::pool_multiplier("Ahri", role, &pool, &penalties);
        assert_eq!(m, 1.0, "pool_multiplier must be exactly 1 for the benchmark context");
    }
    let _ = meta;
}

#[test]
fn candidate_comp_strength_is_the_win_rate_when_nothing_counters_it() {
    // Legacy comp_strength = clamp(win_rate + synergy - counter_risk); synergy is a
    // stub (0) and an empty counters map makes counter_risk 0, so the column must be
    // exactly the champion's winRate. Pins the helper to the candidate's OWN score,
    // not a side total.
    let (_, champion_meta) = load_engine_data(
        &repo_root().join("data/compiled/champion-meta.json"),
        &repo_root().join("data/compiled/matchup-data.json"),
    )
    .expect("engine data");
    let mut win_rates = HashMap::new();
    win_rates.insert("Ahri".to_string(), 0.5321);
    let meta = MetaData { win_rates, ..Default::default() };

    let mut state = DraftState::default();
    for c in ["Gnar", "Sejuani", "Ahri", "Jinx", "Thresh"] { state.blue_picks.push(c.into()); }
    for c in ["Renekton", "Viego", "Orianna", "Ezreal", "Leona"] { state.red_picks.push(c.into()); }
    for i in 0..5 { state.blue_bans.push(format!("__noban{i}")); state.red_bans.push(format!("__noban{}", i + 5)); }
    let ctx = production_context(&state, champion_meta.clone(), meta);

    let v = candidate_comp_strength(&state, 2, "Ahri", &ctx, &champion_meta);
    assert!((v - 0.5321).abs() < 1e-12, "got {v}");
}
