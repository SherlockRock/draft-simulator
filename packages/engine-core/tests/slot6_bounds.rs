//! The slot-6 state on production data: after Blue Pick 1 the next two turns
//! are BOTH pairs (Red 1+2, then Blue 2+3), so depth 2 is up to 500 root pairs
//! × a full pair expansion each. Before top-K pair recursion this did not
//! finish in 240 s (memory `project_engine_search_budget` § 5; the user waited
//! 3.5+ minutes live on 2026-09-07 and undid). The fixture is the probe's
//! request (`docs/plans/2026-09-07-slot6-pair-probe.cjs`): six bans, Zyra at
//! slot 6, full-roster pools, the backend's production config.
//!
//! Timing tests are `#[ignore]` and meaningful in release only:
//!
//!   cargo test -p engine-core --release --test slot6_bounds -- --ignored --nocapture

mod common;

use common::{eval_context, load_production_data};
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{DraftState, Side, TURN_SEQUENCE};
use engine_core::search::{search_with_stats, SearchParams};
use std::thread;
use std::time::{Duration, Instant};

fn slot6_state() -> DraftState {
    let state = DraftState {
        blue_bans: vec!["Aatrox".into(), "Ivern".into(), "Zilean".into()],
        red_bans: vec!["Thresh".into(), "Nidalee".into(), "Blitzcrank".into()],
        blue_picks: vec!["Zyra".into()],
        red_picks: vec![],
    };
    assert_eq!(state.turn_index(), 7);
    assert!(TURN_SEQUENCE[7].pair_start, "slot 7 is the Red 1+2 pair");
    assert!(TURN_SEQUENCE[9].pair_start, "slot 9 is the Blue 2+3 pair");
    state
}

/// backend/services/navigatorEngine.js:213-220, `maxDepth` overridden.
fn production_params(max_depth: usize, top_k: usize) -> SearchParams {
    SearchParams {
        branch_width: 5,
        pair_branch_width: 500,
        max_depth,
        disable_alpha_beta: false,
        single_pair_top_k: top_k,
        forced_branches: vec![],
    }
}

#[test]
#[ignore]
fn depth_two_completes_in_seconds_with_top_k_32_and_the_fan_still_lists_every_pair() {
    let (meta, champion_meta) = load_production_data();
    let state = slot6_state();
    let ctx = eval_context(&state, Side::Red, &champion_meta, &meta);

    let t0 = Instant::now();
    let (tree, stats) = search_with_stats(&state, &production_params(2, 32), &ctx, &CancelHandle::new())
        .expect("search ok");
    let elapsed = t0.elapsed();
    let searched = tree.children.iter().filter(|c| !c.unsearched).count();
    let unsearched = tree.children.iter().filter(|c| c.unsearched).count();
    eprintln!(
        "slot6 depth 2, K=32: {:?}, root children {} (searched {}, unsearched {}), leaf evals {}",
        elapsed,
        tree.children.len(),
        searched,
        unsearched,
        stats.leaf_evaluations
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "depth 2 at slot 6 must complete in under 10 s with K=32; took {elapsed:?}"
    );
    assert_eq!(searched, 32);
    assert!(unsearched > 0, "the root fan still lists the pairs beyond K");
    assert!(
        tree.children.iter().filter(|c| !c.unsearched).all(|c| !c.children.is_empty()),
        "every searched root pair has the Blue 2+3 pair below it"
    );
}

/// Cancel latency: how long after `cancel()` the search returns. Target ≤ 1 s
/// at this state (it measured 10–17 s through the napi probe before this
/// slice). Measured against an UNBOUNDED search (K=0, depth 2) so the stretch
/// between wake points is the thing under test, not the total runtime.
#[test]
#[ignore]
fn an_external_cancel_returns_within_a_second_at_slot_6() {
    let (meta, champion_meta) = load_production_data();
    let state = slot6_state();
    let ctx = eval_context(&state, Side::Red, &champion_meta, &meta);
    let params = production_params(2, 0);

    let cancel = CancelHandle::new();
    let worker = {
        let (cancel, state, params, ctx) = (cancel.clone(), state.clone(), params.clone(), ctx.clone());
        thread::spawn(move || search_with_stats(&state, &params, &ctx, &cancel).map(|_| ()))
    };
    thread::sleep(Duration::from_millis(1500));
    let t0 = Instant::now();
    cancel.cancel();
    let result = worker.join().expect("worker thread");
    let latency = t0.elapsed();
    eprintln!("slot6 cancel latency: {latency:?}");
    assert!(result.is_err(), "a cancelled search returns Err");
    assert!(
        latency < Duration::from_secs(1),
        "cancel must be honoured within 1 s; took {latency:?}"
    );
}

/// The same bound for the deadline path: the search returns within a second
/// of its deadline, and the external flag is untouched.
#[test]
#[ignore]
fn a_deadline_returns_within_a_second_at_slot_6() {
    let (meta, champion_meta) = load_production_data();
    let state = slot6_state();
    let ctx = eval_context(&state, Side::Red, &champion_meta, &meta);
    let params = production_params(2, 0);

    let outer = CancelHandle::new();
    let deadline = Instant::now() + Duration::from_millis(1500);
    let handle = outer.with_deadline(deadline);
    let result = search_with_stats(&state, &params, &ctx, &handle);
    let overshoot = Instant::now().saturating_duration_since(deadline);
    eprintln!("slot6 deadline overshoot: {overshoot:?}");
    assert!(result.is_err(), "a search past its deadline returns Err (Timeout)");
    assert!(!outer.is_cancelled(), "the deadline never trips the external flag");
    assert!(
        overshoot < Duration::from_secs(1),
        "deadline must be honoured within 1 s; overshoot {overshoot:?}"
    );
}

#[test]
#[ignore]
fn streaming_at_slot_6_yields_a_depth_one_partial_within_two_seconds() {
    use engine_core::engine::{ComputeRequest, Engine};
    use engine_core::pools::Penalties;
    let (meta, champion_meta) = load_production_data();
    let pool = common::full_roster_pool(&champion_meta);
    let req = ComputeRequest {
        state: slot6_state(),
        our_side: Side::Red,
        our_pool: pool.clone(),
        opp_pool: pool,
        cross_game_exclusions: vec![],
        search_params: production_params(8, 32),
        latency_budget_ms: 5000,
        min_completed_depth: None,
        champion_meta: champion_meta.clone(),
        meta_overrides: Some(meta.clone()),
        phase_weights_blue: common::phase_weights_blue(),
        phase_weights_red: common::phase_weights_red(),
        penalties: Penalties { out_of_role: 0.25, out_of_pool: 0.75 },
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
    };
    let engine = Engine::new(meta, champion_meta);
    let cancel = CancelHandle::new();
    let t0 = Instant::now();
    let mut first_partial_at: Option<Duration> = None;
    let resp = engine
        .compute_streaming(req, &cancel, &mut |p| {
            if first_partial_at.is_none() {
                first_partial_at = Some(t0.elapsed());
                assert_eq!(p.depth_reached, 1);
            }
        })
        .unwrap();
    let first = first_partial_at.expect("depth 1 completes and depth 2 starts at slot 6");
    println!("first partial at {:?}, final depth {} in {:?}", first, resp.depth_reached, t0.elapsed());
    assert!(first < Duration::from_secs(2), "depth 1 must paint within 2 s (measured 0.7 s)");
    assert!(resp.depth_reached >= 2);
}
