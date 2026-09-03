//! Task 1b-b — measure cache-miss leaf evaluations per query and the per-leaf
//! depth histogram, using the backend's production search configuration.
//!
//! Two numbers, from two different places, deliberately:
//!
//!   * `SearchStats.leaf_evaluations` / `leaf_depth_histogram` are per
//!     `search_with_stats` call, i.e. per iterative-deepening ITERATION.
//!   * the achieved depth per QUERY is `ComputeResponse.depth_reached` —
//!     `maxDepth: 8` is only a cap, `AB_COMPUTE_BUDGET_MS` decides what is
//!     actually reached. It already exists; nothing was added for it.
//!
//! Feeds gate 5 (throughput: a batched neural leaf evaluator has to serve
//! `leaf_evaluations` per query inside the budget) and the achieved-depth
//! factor of the Task 1b-a mask table.
//!
//! Marked `#[ignore]`; it makes real 5 s budgeted searches. To capture:
//!
//!   cargo test --release --test leaf_eval_stats -- --ignored --nocapture

mod common;

use common::{eval_context, load_production_data, repo_root};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{ActionType, DraftState, Side, TOTAL_TURNS, TURN_SEQUENCE};
use engine_core::evaluator::EvalContext;
use engine_core::pools::Role;
use engine_core::role_solver::ChampionMeta;
use engine_core::search::{search_with_stats, SearchParams, LEAF_DEPTH_BUCKETS};
use std::collections::HashMap;
use std::thread;
use std::time::{Duration, Instant};

// backend/services/navigatorEngine.js:20
const AB_COMPUTE_BUDGET_MS: u64 = 5000;
// backend/services/navigatorEngine.js:150-158
const BRANCH_WIDTH: usize = 5;
const PAIR_BRANCH_WIDTH: usize = 500;
const MAX_DEPTH: usize = 8;

/// A legal draft prefix of `turn_index` actions, built from real champion-meta
/// aliases with one champion per role per side so feasibility pruning behaves
/// the way it does on a real draft.
fn draft_prefix(turn_index: usize, champion_meta: &HashMap<String, ChampionMeta>) -> DraftState {
    let roles = [Role::Top, Role::Jungle, Role::Middle, Role::Adc, Role::Support];
    let mut by_role: HashMap<Role, Vec<String>> = HashMap::new();
    let mut ids: Vec<&String> = champion_meta.keys().collect();
    ids.sort();
    for id in ids {
        if let Some(primary) = champion_meta[id].positions.first() {
            by_role.entry(*primary).or_default().push(id.clone());
        }
    }
    for role in roles {
        assert!(
            by_role.get(&role).map(|v| v.len()).unwrap_or(0) >= 4,
            "champion-meta has too few {role:?} primaries to build a fixture"
        );
    }

    // Bans come off the front of each role list, picks off the back, so a ban
    // never collides with a pick.
    let mut ban_cursor = 0usize;
    let mut pick_cursor: HashMap<Role, usize> = HashMap::new();
    let mut state = DraftState::default();

    for i in 0..turn_index.min(TOTAL_TURNS) {
        let turn = TURN_SEQUENCE[i];
        let champ = match turn.action_type {
            ActionType::Ban => {
                let role = roles[ban_cursor % roles.len()];
                let idx = ban_cursor / roles.len();
                ban_cursor += 1;
                by_role[&role][idx].clone()
            }
            ActionType::Pick => {
                // Give each side a distinct role per pick so the comp is legal.
                let side_picks = if turn.side == Side::Blue {
                    state.blue_picks.len()
                } else {
                    state.red_picks.len()
                };
                let role = roles[side_picks % roles.len()];
                let n = pick_cursor.entry(role).or_insert(0);
                let list = &by_role[&role];
                let champ = list[list.len() - 1 - *n].clone();
                *n += 1;
                champ
            }
        };
        match (turn.action_type, turn.side) {
            (ActionType::Ban, Side::Blue) => state.blue_bans.push(champ),
            (ActionType::Ban, Side::Red) => state.red_bans.push(champ),
            (ActionType::Pick, Side::Blue) => state.blue_picks.push(champ),
            (ActionType::Pick, Side::Red) => state.red_picks.push(champ),
        }
    }
    state
}

fn backend_params(max_depth: usize) -> SearchParams {
    SearchParams {
        branch_width: BRANCH_WIDTH,
        pair_branch_width: PAIR_BRANCH_WIDTH,
        max_depth,
        disable_alpha_beta: false,
        forced_branches: vec![],
    }
}

// ---------------------------------------------------------------------------

/// Run one search on a worker thread and trip the cancel handle if it overruns.
///
/// Iterative deepening has NO per-iteration deadline: `deepen` decides whether
/// to *start* depth d, but once started the iteration runs to completion, and
/// the only thing that can stop it is the cancel handle. The backend arms that
/// handle on supersession only (navigatorEngine.js:243) — never on a clock — so
/// `AB_COMPUTE_BUDGET_MS` is a scheduling hint, not a cap. This harness enforces
/// it, because an unenforced measurement of "evaluations inside the budget" is
/// not a measurement of anything.
fn timed_search(
    state: &DraftState,
    params: SearchParams,
    ctx: &EvalContext,
    budget: Duration,
) -> Result<(engine_core::search::SearchStats, Duration), Duration> {
    let state = state.clone();
    let ctx = ctx.clone();
    let cancel = CancelHandle::new();
    let cancel_for_search = cancel.clone();
    let t0 = Instant::now();
    let handle = thread::spawn(move || search_with_stats(&state, &params, &ctx, &cancel_for_search));

    let deadline = t0 + budget;
    while Instant::now() < deadline && !handle.is_finished() {
        thread::sleep(Duration::from_millis(10));
    }
    if !handle.is_finished() {
        cancel.cancel();
        let _ = handle.join();
        return Err(t0.elapsed());
    }
    match handle.join().expect("search thread panicked") {
        Ok((_tree, stats)) => Ok((stats, t0.elapsed())),
        Err(_) => Err(t0.elapsed()),
    }
}

#[test]
#[ignore]
fn leaf_evaluation_stats_across_root_turns() {
    let (meta, champion_meta) = load_production_data();
    let budget = Duration::from_millis(AB_COMPUTE_BUDGET_MS);
    println!("champion-meta champions: {}", champion_meta.len());
    println!(
        "config: branch_width={BRANCH_WIDTH} pair_branch_width={PAIR_BRANCH_WIDTH} \
         max_depth={MAX_DEPTH} budget={AB_COMPUTE_BUDGET_MS}ms penalties=0.25/0.75"
    );
    println!(
        "\nDepth ladder per root turn. Each row is ONE iteration searched from scratch,\n\
         so the query cost of reaching depth d is the CUMULATIVE time of rows 1..d —\n\
         that is what iterative deepening pays.\n"
    );

    struct Row {
        root_turn: usize,
        depth_within_budget: usize,
        leaf_evals_at_depth: usize,
        cumulative_ms: u128,
        hist: [usize; LEAF_DEPTH_BUCKETS],
        timed_out_at: Option<usize>,
    }
    let mut rows: Vec<Row> = Vec::new();

    for root_turn in 0..TOTAL_TURNS {
        let state = draft_prefix(root_turn, &champion_meta);
        let our_side = state.current_turn().map(|t| t.side).unwrap_or(Side::Blue);
        let ctx = eval_context(&state, our_side, &champion_meta, &meta);

        let mut cumulative = Duration::ZERO;
        let mut best = Row {
            root_turn,
            depth_within_budget: 0,
            leaf_evals_at_depth: 0,
            cumulative_ms: 0,
            hist: [0; LEAF_DEPTH_BUCKETS],
            timed_out_at: None,
        };

        for depth in 1..=MAX_DEPTH {
            match timed_search(&state, backend_params(depth), &ctx, budget) {
                Ok((stats, elapsed)) => {
                    cumulative += elapsed;
                    let evals_per_s = stats.leaf_evaluations as f64 / elapsed.as_secs_f64().max(1e-6);
                    println!(
                        "root {:>2}  d{:<2} leaf_evals {:>9}  iter {:>7} ms  cum {:>7} ms  \
                         {:>9.0} evals/s  expanded {:>8}  transp {:>8}",
                        root_turn,
                        depth,
                        stats.leaf_evaluations,
                        elapsed.as_millis(),
                        cumulative.as_millis(),
                        evals_per_s,
                        stats.nodes_evaluated,
                        stats.transpositions_found,
                    );
                    if cumulative <= budget {
                        best.depth_within_budget = depth;
                        best.leaf_evals_at_depth = stats.leaf_evaluations;
                        best.cumulative_ms = cumulative.as_millis();
                        best.hist = stats.leaf_depth_histogram;
                    } else {
                        println!(
                            "root {:>2}  -> cumulative exceeded the {} ms budget at d{}",
                            root_turn, AB_COMPUTE_BUDGET_MS, depth
                        );
                        break;
                    }
                }
                Err(elapsed) => {
                    println!(
                        "root {:>2}  d{:<2} CANCELLED after {:>7} ms — a single iteration \
                         exceeds the whole budget",
                        root_turn,
                        depth,
                        elapsed.as_millis()
                    );
                    best.timed_out_at = Some(depth);
                    break;
                }
            }
        }
        println!(
            "root {:>2}  ==> depth within budget: {}  leaf_evals {}  ({} ms)\n",
            root_turn, best.depth_within_budget, best.leaf_evals_at_depth, best.cumulative_ms
        );
        rows.push(best);
    }

    // --- summary ---------------------------------------------------------
    println!("\nper-leaf depth histogram at the deepest iteration that fits the budget:");
    print!("{:>6}", "root");
    for d in 0..=MAX_DEPTH {
        print!("{:>9}", format!("d{d}"));
    }
    println!("{:>10}", "reached");
    for r in &rows {
        print!("{:>6}", r.root_turn);
        for d in 0..=MAX_DEPTH {
            print!("{:>9}", r.hist[d]);
        }
        println!("{:>10}", r.depth_within_budget);
    }

    let mut depth_counts: HashMap<usize, usize> = HashMap::new();
    for r in &rows {
        *depth_counts.entry(r.depth_within_budget).or_default() += 1;
    }
    let n = rows.len() as f64;
    println!("\nachieved-depth distribution over {} root turns", rows.len());
    println!("(uniform-root assumption; this is the second factor of the Task 1b-a mask table):");
    let mut depths: Vec<_> = depth_counts.keys().copied().collect();
    depths.sort();
    let mut json_pairs = Vec::new();
    for d in &depths {
        let p = depth_counts[d] as f64 / n;
        println!("  depth {d}: {} roots  p={p:.4}", depth_counts[d]);
        json_pairs.push(format!("\"{d}\": {p}"));
    }

    let mut evals: Vec<usize> = rows.iter().map(|r| r.leaf_evals_at_depth).collect();
    evals.sort();
    println!(
        "\nGATE 5 INPUT — cache-miss leaf evaluations per query (deepest iteration only):\n  \
         min {}  median {}  max {}  mean {:.0}",
        evals[0],
        evals[evals.len() / 2],
        evals[evals.len() - 1],
        evals.iter().sum::<usize>() as f64 / n,
    );
    println!(
        "  NOTE: iterative deepening re-searches from scratch, so a query's TOTAL evaluations\n  \
         are the sum over depths 1..d, not this number alone."
    );
    let timed_out: Vec<usize> = rows.iter().filter_map(|r| r.timed_out_at.map(|_| r.root_turn)).collect();
    if !timed_out.is_empty() {
        println!(
            "\n  Root turns whose NEXT iteration alone exceeds the whole {} ms budget: {:?}\n  \
             Iterative deepening declines to start these, so on its own this is normal.\n  \
             What is not normal: the engine cannot abandon an iteration once started\n  \
             (deepen only chooses whether to BEGIN one) and the backend arms its\n  \
             CancelToken on supersession only (navigatorEngine.js:243), never on a clock.\n  \
             So when deepen's 2x estimate under-predicts, the query overruns unbounded:\n  \
             an unenforced run of this same harness measured real compute() times of\n  \
             9.5 s and 12.6 s at roots 0 and 1 against the same {} ms budget.",
            AB_COMPUTE_BUDGET_MS, timed_out, AB_COMPUTE_BUDGET_MS
        );
    }

    let out = repo_root().join("scripts/model/leaf_eval_stats.json");
    let per_root: Vec<String> = rows
        .iter()
        .map(|r| {
            format!(
                "    {{\"root_turn\": {}, \"depth_within_budget\": {}, \"leaf_evaluations\": {}, \
                 \"cumulative_ms\": {}, \"timed_out_at_depth\": {}, \"leaf_depth_histogram\": {:?}}}",
                r.root_turn,
                r.depth_within_budget,
                r.leaf_evals_at_depth,
                r.cumulative_ms,
                r.timed_out_at.map(|d| d.to_string()).unwrap_or("null".into()),
                &r.hist[..=MAX_DEPTH]
            )
        })
        .collect();
    let doc = format!(
        "{{\n  \"source\": \"cargo test --release --test leaf_eval_stats -- --ignored\",\n  \
         \"config\": {{\"branch_width\": {BRANCH_WIDTH}, \"pair_branch_width\": {PAIR_BRANCH_WIDTH}, \
         \"max_depth\": {MAX_DEPTH}, \"budget_ms\": {AB_COMPUTE_BUDGET_MS}}},\n  \
         \"achieved_depth_distribution\": {{{}}},\n  \"per_root\": [\n{}\n  ]\n}}\n",
        json_pairs.join(", "),
        per_root.join(",\n")
    );
    std::fs::write(&out, doc).expect("write leaf_eval_stats.json");
    println!("\nwrote {}", out.display());

    assert!(
        evals.iter().sum::<usize>() > 0,
        "the leaf counter never fired — instrumentation is wrong"
    );
}

/// The counter must count evaluations, not expansions, and must not count
/// transposition hits (a hit returns before `eval_state`).
#[test]
fn leaf_counter_is_distinct_from_nodes_evaluated() {
    let (meta, champion_meta) = load_production_data();
    let state = draft_prefix(16, &champion_meta);
    let ctx = eval_context(&state, Side::Red, &champion_meta, &meta);
    let cancel = CancelHandle::new();
    let (_tree, stats) =
        search_with_stats(&state, &backend_params(2), &ctx, &cancel).expect("search completes");

    assert!(stats.leaf_evaluations > 0, "no leaves evaluated at depth 2");
    assert_eq!(
        stats.leaf_evaluations,
        stats.leaf_depth_histogram.iter().sum::<usize>(),
        "histogram total must equal the evaluation count"
    );
    // Depth 0 is the root; a depth-2 search cannot place a leaf below ply 2.
    assert_eq!(stats.leaf_depth_histogram[0], 0, "root is not a leaf here");
    for (d, n) in stats.leaf_depth_histogram.iter().enumerate() {
        assert!(d <= 2 || *n == 0, "leaf recorded at depth {d} in a depth-2 search");
    }
}

/// A terminal state evaluates exactly once, at depth 0, and expands nothing.
#[test]
fn terminal_state_evaluates_once() {
    let (meta, champion_meta) = load_production_data();
    let state = draft_prefix(TOTAL_TURNS, &champion_meta);
    assert!(state.is_complete());
    let ctx = eval_context(&state, Side::Blue, &champion_meta, &meta);
    let cancel = CancelHandle::new();
    let (_tree, stats) =
        search_with_stats(&state, &backend_params(MAX_DEPTH), &ctx, &cancel).expect("search");

    assert_eq!(stats.leaf_evaluations, 1);
    assert_eq!(stats.nodes_evaluated, 0, "a terminal state expands nothing");
    // max_depth 8, remaining_depth 8 at the root -> depth 0.
    assert_eq!(stats.leaf_depth_histogram[0], 1);
}
