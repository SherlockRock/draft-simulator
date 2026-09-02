//! design §1(b)/§5: serving parity through the REAL leaf path
//! (`search_with_stats(max_depth 0)` → `eval_state` → `side_total` → `score_pick`),
//! with the `0.5 + scale×` mapping inverted under a fixture context whose phase
//! weights are comp = 1 / info = 0 / coverage = 0 and whose pools carry no penalty.
//! `eval_state` returns composites, so allocation sums are only observable with the
//! other terms zeroed — the fixture context is part of the test's definition.
use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{DraftState, Phase, Side};
use engine_core::evaluator::{EvalContext, MetaData, PhaseWeightTable, PhaseWeights};
use engine_core::fm::FmWeights;
use engine_core::pools::{Penalties, RolePoolMap, TeamPool};
use engine_core::search::{search_with_stats, SearchParams};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Deserialize)]
struct Fixture {
    blue: Vec<String>,
    red: Vec<String>,
    blue_allocation_sum: f64,
    red_allocation_sum: f64,
    logit: f64,
}

#[derive(Deserialize)]
struct ParityFile {
    version: String,
    tolerance: f64,
    fixtures: Vec<Fixture>,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf()
}

fn flat() -> PhaseWeightTable {
    let w = PhaseWeights { info: 0.0, comp: 1.0, coverage: 0.0 };
    PhaseWeightTable { ban1: w, pick1: w, ban2: w, pick2: w }
}

fn ctx(fm: Arc<FmWeights>) -> EvalContext {
    let pool = TeamPool {
        display: RolePoolMap { top: vec![], jungle: vec![], middle: vec![], adc: vec![], support: vec![] },
        search: vec![],
    };
    EvalContext {
        side: Side::Blue,
        phase: Phase::Pick2,
        our_pool: pool.clone(),
        opp_pool: pool,
        our_picks: vec![],
        opp_picks: vec![],
        penalties: Penalties { out_of_role: 0.0, out_of_pool: 0.0 },
        champion_meta: HashMap::new(),
        meta: MetaData { fm: Some(fm), ..Default::default() },
        phase_weights_blue: flat(),
        phase_weights_red: flat(),
        synergy_multiplier: 1.0,
        counter_multiplier: 1.0,
        flex_retention_weight: 1.0,
        reveal_cost_weight: 1.0,
        fm: None,
    }
}

#[test]
fn rust_leaf_sums_reproduce_the_python_serving_decomposition() {
    let root = repo_root();
    let weights = FmWeights::from_json_str(
        &std::fs::read_to_string(root.join("data/compiled/fm-weights.json")).expect("fm-weights.json"),
    )
    .expect("weights parse");
    let parity: ParityFile = serde_json::from_str(
        &std::fs::read_to_string(root.join("data/compiled/fm-parity.json")).expect("fm-parity.json"),
    )
    .expect("parity parse");
    assert_eq!(parity.version, weights.version, "fixtures and weights must come from the same export");
    assert!(parity.fixtures.len() >= 40);

    let scale = weights.scale;
    let ctx = ctx(Arc::new(weights));
    let params = SearchParams { max_depth: 0, ..SearchParams::default() };
    let cancel = CancelHandle::new();
    let mut partial = 0;
    for (i, f) in parity.fixtures.iter().enumerate() {
        let state = DraftState { blue_picks: f.blue.clone(), red_picks: f.red.clone(), ..Default::default() };
        if f.blue.len() + f.red.len() < 10 { partial += 1; }
        let (tree, stats) = search_with_stats(&state, &params, &ctx, &cancel).expect("depth-0 search");
        assert_eq!(stats.leaf_evaluations, 1, "fixture {i}: depth 0 must be one static evaluation");
        let per = tree.scores.composite_per_side;
        let blue_sum = (per.blue - 0.5 * f.blue.len() as f64) / scale;
        let red_sum = (per.red - 0.5 * f.red.len() as f64) / scale;
        assert!((blue_sum - f.blue_allocation_sum).abs() < parity.tolerance, "fixture {i} blue: {blue_sum} vs {}", f.blue_allocation_sum);
        assert!((red_sum - f.red_allocation_sum).abs() < parity.tolerance, "fixture {i} red: {red_sum} vs {}", f.red_allocation_sum);
        assert!(((blue_sum - red_sum) - f.logit).abs() < parity.tolerance, "fixture {i} logit");
    }
    assert!(partial > 0, "fixtures must include partial drafts");
}
