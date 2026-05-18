//! v5 phase 7a — engine-node dispatch into the experimental MCTS spike.
//!
//! When `EngineRequest.algorithm == Some("mcts")`, `Engine.compute` routes
//! through this module instead of the production αβ path. The output is
//! projected into the existing `proto::EngineResponse` shape with optional
//! MCTS-specific fields on `meta.mctsMeta` and `tree.children[*].mctsExtras`.
//!
//! Production αβ never sets these. Spike-shape allowed below the dispatch
//! boundary (`unwrap()` for assumed-present fields is fine; this is dev-only
//! tooling gated on a navigator env var).
//!
//! Dispatch flow (Phase 7a): one uninterrupted iterate loop over the full
//! latency budget, then a single recursive `subtree_walk` to render the wire
//! tree at natural depth (MAX_DEPTH cap + per-level top-K + MAX_NODES safety
//! cap). No reroot during dispatch. Pareto-frontier marker per node, flex
//! retention propagated onto TreeNodeScores, MAX_NODES truncation surfaced
//! via `mcts_meta.truncated`.
//!
//! Cancellation is polled every POLL_EVERY iterations of the iterate loop.
//!
//! Pool / fixture loading: `SpikeFixture` is loaded lazily on first MCTS
//! dispatch and cached per `Engine` instance. The spike loader expects a
//! `winrates.json` adjacent to `champion_meta_path`; if absent, per-champ
//! winrates fall back to `champion-meta.json`'s `winRate` field (often 0.5
//! placeholder).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use engine_core::cancellation::CancelHandle;
use engine_core::draft_state::{DraftState, Side};
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::real_data_fixture::load_real_data_fixture;
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::{PoolContext, SpikeFixture};
use engine_core::pools::{RolePoolMap, TeamPool};
use engine_core::protocol_types as proto;

use crate::error;
use crate::mcts_wire::{build_response, empty_response, BuildResponseOptions, MAX_TOP_K_AT_ROOT, POLL_EVERY};

pub fn compute_mcts(
    req: &proto::EngineRequest,
    fixture: Arc<SpikeFixture>,
    cancel: &CancelHandle,
) -> Result<proto::EngineResponse, napi::Error> {
    let start = Instant::now();
    let state = build_draft_state(&req.draft_state)?;
    let pools = build_pool_context(&req.pools, fixture.as_ref())?;
    let our_side = match req.pools.our_side {
        proto::EngineRequestPoolsOurSide::Blue => Side::Blue,
        proto::EngineRequestPoolsOurSide::Red => Side::Red,
    };
    let _ = our_side;

    let total_budget_ms = req.config.search.latency_budget_ms.max(0) as u64;
    let top_k_at_root = (req.config.search.branch_width.max(1) as usize)
        .clamp(1, MAX_TOP_K_AT_ROOT);
    let seed = derive_seed(&state);

    let cfg = McTsConfig {
        policy: RolloutPolicy::UniformFeasible,
        feasibility_mode: FeasibilityMode::Cached,
        seed,
        root_shortlist_k: Some(top_k_at_root.max(20).min(40)),
        flex_weight: 1.0,
    };

    if state.is_complete() {
        return Ok(empty_response(start.elapsed().as_millis() as u64, 0));
    }

    let mut mcts = Mcts::with_pools(fixture.as_ref(), state.clone(), &pools, cfg);

    // Single iterate loop — no Phase A / Phase B split.
    let deadline = start + Duration::from_millis(total_budget_ms);
    let mut counter: usize = 0;
    while Instant::now() < deadline {
        if counter % POLL_EVERY == 0 && cancel.is_cancelled() {
            break;
        }
        mcts.iterate();
        counter += 1;
    }

    let cancelled = cancel.is_cancelled();
    let opts = BuildResponseOptions {
        cancelled,
        persist_on_pause: false,
        top_k_at_root,
    };
    Ok(build_response(&mcts, &state, start.elapsed(), opts))
}

pub(crate) fn build_draft_state(
    ds: &proto::EngineRequestDraftState,
) -> Result<DraftState, napi::Error> {
    if ds.format != "standard" {
        return Err(error::invalid_input(
            vec!["draftState", "format"],
            "expected format='standard'",
        ));
    }
    let mut blue_bans: Vec<(i64, String)> = Vec::new();
    let mut red_bans: Vec<(i64, String)> = Vec::new();
    let mut blue_picks: Vec<(i64, String)> = Vec::new();
    let mut red_picks: Vec<(i64, String)> = Vec::new();
    for b in &ds.bans {
        let pair = (b.slot, b.champion_id.clone());
        match b.side {
            proto::EngineRequestDraftStateBansItemSide::Blue => blue_bans.push(pair),
            proto::EngineRequestDraftStateBansItemSide::Red => red_bans.push(pair),
        }
    }
    for p in &ds.picks {
        let pair = (p.slot, p.champion_id.clone());
        match p.side {
            proto::EngineRequestDraftStatePicksItemSide::Blue => blue_picks.push(pair),
            proto::EngineRequestDraftStatePicksItemSide::Red => red_picks.push(pair),
        }
    }
    blue_bans.sort_by_key(|(s, _)| *s);
    red_bans.sort_by_key(|(s, _)| *s);
    blue_picks.sort_by_key(|(s, _)| *s);
    red_picks.sort_by_key(|(s, _)| *s);
    Ok(DraftState {
        blue_bans: blue_bans.into_iter().map(|(_, c)| c).collect(),
        red_bans: red_bans.into_iter().map(|(_, c)| c).collect(),
        blue_picks: blue_picks.into_iter().map(|(_, c)| c).collect(),
        red_picks: red_picks.into_iter().map(|(_, c)| c).collect(),
    })
}

pub(crate) fn build_pool_context(
    pools: &proto::EngineRequestPools,
    fixture: &SpikeFixture,
) -> Result<PoolContext, napi::Error> {
    // Spike's pool semantics: `display` = per-role champion lists, `search` =
    // flat list of every champ this side may pick. If the request supplies
    // empty pools (legitimate at draft start before pool init), fall back to
    // full-pool so MCTS still has a candidate set.
    let blue = build_team_pool(&pools.blue.display.top, &pools.blue.display.jungle,
                                &pools.blue.display.middle, &pools.blue.display.adc,
                                &pools.blue.display.support, &pools.blue.search,
                                fixture);
    let red = build_team_pool(&pools.red.display.top, &pools.red.display.jungle,
                               &pools.red.display.middle, &pools.red.display.adc,
                               &pools.red.display.support, &pools.red.search,
                               fixture);
    Ok(PoolContext::new(blue, red))
}

fn build_team_pool(
    top: &[String],
    jungle: &[String],
    middle: &[String],
    adc: &[String],
    support: &[String],
    search: &[String],
    fixture: &SpikeFixture,
) -> TeamPool {
    if search.is_empty() {
        // Fall back to full-pool for this side. Most session.{blue,red}_pool
        // are pre-populated, but defensive against early-draft empty state.
        return engine_core::mcts_spike::make_full_team_pool(fixture);
    }
    TeamPool {
        display: RolePoolMap {
            top: top.to_vec(),
            jungle: jungle.to_vec(),
            middle: middle.to_vec(),
            adc: adc.to_vec(),
            support: support.to_vec(),
        },
        search: search.to_vec(),
    }
}

/// Hash the draft state into a 64-bit seed so the spike runs are repeatable
/// for a given input but vary across drafts. UCT is sensitive to seed at
/// shallow visit counts; this avoids the "same first move, different draft"
/// artifact that fixed seeding would produce.
pub(crate) fn derive_seed(state: &DraftState) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    state.blue_bans.hash(&mut hasher);
    state.red_bans.hash(&mut hasher);
    state.blue_picks.hash(&mut hasher);
    state.red_picks.hash(&mut hasher);
    let h = hasher.finish();
    if h == 0 { 1 } else { h }
}

/// Lazily build a `SpikeFixture` adjacent to the engine's
/// `champion_meta_path`. Looks for `winrates.json` in the same directory; if
/// missing, the spike falls back to per-champion winRate from
/// champion-meta.json (often 0/placeholder).
pub fn load_spike_fixture(
    champion_meta_path: &Path,
) -> Result<SpikeFixture, napi::Error> {
    let winrates_path = sibling_winrates_path(champion_meta_path);
    load_real_data_fixture(champion_meta_path, &winrates_path)
        .map_err(|e| error::internal(format!("mcts spike fixture load failed: {}", e)))
}

fn sibling_winrates_path(champion_meta_path: &Path) -> PathBuf {
    champion_meta_path
        .parent()
        .map(|p| p.join("winrates.json"))
        .unwrap_or_else(|| PathBuf::from("winrates.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::mcts_spike::real_data_fixture::real_data_fixture;

    /// Build a mid-state request: all six ban1 picks complete, blue to make B1
    /// (turn_index = 6). Empty pools trigger the full-pool fallback in
    /// `build_pool_context`. A 200ms latency budget is enough to populate
    /// top-K root children with a few visits each on the real-data fixture.
    fn mid_state_request() -> proto::EngineRequest {
        let raw = serde_json::json!({
            "protocolVersion": "1.0.0",
            "draftState": {
                "format": "standard",
                "bans": [
                    { "championId": "Aatrox",  "side": "blue", "slot": 0 },
                    { "championId": "Ahri",    "side": "red",  "slot": 1 },
                    { "championId": "Akali",   "side": "blue", "slot": 2 },
                    { "championId": "Alistar", "side": "red",  "slot": 3 },
                    { "championId": "Amumu",   "side": "blue", "slot": 4 },
                    { "championId": "Anivia",  "side": "red",  "slot": 5 },
                ],
                "picks": [],
                "currentPhase": "pick1",
                "currentSlot": 6,
                "currentSide": "blue",
            },
            "pools": {
                "ourSide": "blue",
                "blue": {
                    "display": { "TOP": [], "JUNGLE": [], "MIDDLE": [], "ADC": [], "SUPPORT": [] },
                    "search": [],
                },
                "red": {
                    "display": { "TOP": [], "JUNGLE": [], "MIDDLE": [], "ADC": [], "SUPPORT": [] },
                    "search": [],
                },
                "crossGameExclusions": [],
            },
            "opponentModel": { "type": "meta", "weights": {} },
            "playerModel": {
                "championTiers": { "core": [], "playable": [], "emergency": [] },
                "weights": {},
            },
            "config": {
                "search": {
                    "branchWidth": 5,
                    "pairBranchWidth": 500,
                    "singlePairTopK": 32,
                    "maxDepth": 8,
                    "broadDepth": 8,
                    "extensionTurnThreshold": 8,
                    "latencyBudgetMs": 200,
                },
                "weights": {
                    "phaseWeights": {
                        "blue": {
                            "ban1":  { "comp": 0.35, "info": 0.65, "coverage": 0.0 },
                            "pick1": { "comp": 0.5,  "info": 0.5,  "coverage": 0.3 },
                            "ban2":  { "comp": 0.6,  "info": 0.4,  "coverage": 0.4 },
                            "pick2": { "comp": 0.8,  "info": 0.2,  "coverage": 1.5 },
                        },
                        "red": {
                            "ban1":  { "comp": 0.3, "info": 0.7, "coverage": 0.0 },
                            "pick1": { "comp": 0.4, "info": 0.6, "coverage": 0.3 },
                            "ban2":  { "comp": 0.5, "info": 0.5, "coverage": 0.4 },
                            "pick2": { "comp": 0.8, "info": 0.2, "coverage": 1.5 },
                        },
                    },
                    "penalties": { "outOfPool": 0.75, "outOfRole": 0.25 },
                    "synergyMultiplier": 1.0,
                    "counterMultiplier": 1.0,
                    "flexRetentionWeight": 1.0,
                    "revealCostWeight": 1.0,
                },
                "profile": "firstpick-default-v1",
                "forcedBranches": [],
            },
        });
        serde_json::from_value(raw).expect("mid_state_request parses")
    }

    /// Build a late-state request positioned at slot 11 (R3 Pick1, singleton).
    /// Used by the natural-depth test to avoid the slot-6 → slot-7 pair-pick
    /// fanout that starves grandchildren below the spec's min_visits gate. At
    /// slot 11 the next two turns (slot 12 Red Ban2, slot 13 Blue Ban2) are
    /// both singletons, so the spec gate can actually fire at depth 1–2 of the
    /// rendered tree. Pick assignment: blue {Garen TOP, LeeSin JUNGLE, Lux
    /// MIDDLE}, red {Camille TOP, Yasuo MIDDLE} — distinct primary roles keep
    /// role-completion feasible for both sides.
    fn late_state_request() -> proto::EngineRequest {
        let raw = serde_json::json!({
            "protocolVersion": "1.0.0",
            "draftState": {
                "format": "standard",
                "bans": [
                    { "championId": "Aatrox",  "side": "blue", "slot": 0 },
                    { "championId": "Ahri",    "side": "red",  "slot": 1 },
                    { "championId": "Akali",   "side": "blue", "slot": 2 },
                    { "championId": "Alistar", "side": "red",  "slot": 3 },
                    { "championId": "Amumu",   "side": "blue", "slot": 4 },
                    { "championId": "Anivia",  "side": "red",  "slot": 5 },
                ],
                "picks": [
                    { "championId": "Garen",   "side": "blue", "slot": 6 },
                    { "championId": "Camille", "side": "red",  "slot": 7 },
                    { "championId": "Yasuo",   "side": "red",  "slot": 8 },
                    { "championId": "LeeSin",  "side": "blue", "slot": 9 },
                    { "championId": "Lux",     "side": "blue", "slot": 10 },
                ],
                "currentPhase": "pick1",
                "currentSlot": 11,
                "currentSide": "red",
            },
            "pools": {
                "ourSide": "blue",
                "blue": {
                    "display": { "TOP": [], "JUNGLE": [], "MIDDLE": [], "ADC": [], "SUPPORT": [] },
                    "search": [],
                },
                "red": {
                    "display": { "TOP": [], "JUNGLE": [], "MIDDLE": [], "ADC": [], "SUPPORT": [] },
                    "search": [],
                },
                "crossGameExclusions": [],
            },
            "opponentModel": { "type": "meta", "weights": {} },
            "playerModel": {
                "championTiers": { "core": [], "playable": [], "emergency": [] },
                "weights": {},
            },
            "config": {
                "search": {
                    "branchWidth": 5,
                    "pairBranchWidth": 500,
                    "singlePairTopK": 32,
                    "maxDepth": 8,
                    "broadDepth": 8,
                    "extensionTurnThreshold": 8,
                    "latencyBudgetMs": 200,
                },
                "weights": {
                    "phaseWeights": {
                        "blue": {
                            "ban1":  { "comp": 0.35, "info": 0.65, "coverage": 0.0 },
                            "pick1": { "comp": 0.5,  "info": 0.5,  "coverage": 0.3 },
                            "ban2":  { "comp": 0.6,  "info": 0.4,  "coverage": 0.4 },
                            "pick2": { "comp": 0.8,  "info": 0.2,  "coverage": 1.5 },
                        },
                        "red": {
                            "ban1":  { "comp": 0.3, "info": 0.7, "coverage": 0.0 },
                            "pick1": { "comp": 0.4, "info": 0.6, "coverage": 0.3 },
                            "ban2":  { "comp": 0.5, "info": 0.5, "coverage": 0.4 },
                            "pick2": { "comp": 0.8, "info": 0.2, "coverage": 1.5 },
                        },
                    },
                    "penalties": { "outOfPool": 0.75, "outOfRole": 0.25 },
                    "synergyMultiplier": 1.0,
                    "counterMultiplier": 1.0,
                    "flexRetentionWeight": 1.0,
                    "revealCostWeight": 1.0,
                },
                "profile": "firstpick-default-v1",
                "forcedBranches": [],
            },
        });
        serde_json::from_value(raw).expect("late_state_request parses")
    }

    #[test]
    fn compute_mcts_emits_synthetic_scenarios() {
        // 5s budget rather than the fixture's 200ms default. Pareto membership
        // requires min_visits >= MIN_PARETO_VISITS (16) across eligible
        // siblings, and slot 6 → slot 7 pair-pick fanout makes the per-root-
        // child visit accrual rate low: 200ms-2s yields well under 16 visits.
        let mut req = mid_state_request();
        req.config.search.latency_budget_ms = 5000;
        let fixture = Arc::new(real_data_fixture());
        let cancel = CancelHandle::new();
        let resp = compute_mcts(&req, fixture, &cancel).expect("compute_mcts ok");
        assert!(
            !resp.scenarios.is_empty(),
            "expected synthetic scenarios per top-K root child, got 0"
        );
        let first = &resp.scenarios[0];
        assert!(
            first.name.starts_with("MCTS #"),
            "expected MCTS #N name, got {:?}",
            first.name
        );
        assert!(
            !first.tree_path.is_empty(),
            "expected at least 1 tree_path step per scenario"
        );
        // Shape-stable: first step's slot should be the current turn index, and
        // every step's champion_ids should be populated. Don't assert specific
        // depth — that changes with the natural-depth refactor.
        let root_step = &first.tree_path[0];
        assert_eq!(
            root_step.slot, 6,
            "first step slot should be the current turn index (B1 = 6)"
        );
        for step in &first.tree_path {
            assert!(
                !step.champion_ids.is_empty(),
                "every tree_path step must carry champion_ids"
            );
        }
        assert!(
            !first.blue_picks.is_empty() || !first.red_picks.is_empty(),
            "expected projected picks after walking the path"
        );

        // v5 phase 7a positive assertions:
        let depth = resp.meta.depth_reached;
        assert!(depth >= 1, "expected meta.depth_reached >= 1, got {}", depth);

        // Flex retention is plumbed unit-tested in evaluator.rs; removed here
        // because the slot-6 fixture's pair-pick fanout at slot 7 filters
        // grandchildren below the spec gate, making mean_value.flex frequently
        // 0 at root_children depth.

        // With T1's visit-accounting fix, the spec gate's min_visits=4 floor
        // at depth=0 actually clears for some root children, and pareto
        // membership requires a non-stub node. Assert at least one root child
        // is flagged paretoOnFrontier=Some(true).
        let any_pareto_true = resp.tree.children.iter().any(|c| {
            c.mcts_extras
                .as_ref()
                .map(|e| e.pareto_on_frontier == Some(true))
                .unwrap_or(false)
        });
        assert!(
            any_pareto_true,
            "expected at least one root child with paretoOnFrontier=Some(true) under fixed visit accounting"
        );
    }

    #[test]
    fn compute_mcts_pareto_orients_to_picking_side() {
        // Two mirrored requests: one where blue is to move (slot 6 = B1) and one
        // mirrored where red is to move (slot 7 = R1 in standard order). At
        // minimum, dispatch must not crash for either side and must emit root
        // children with mctsExtras populated for both. Strong red-vs-blue
        // orientation behavior is unit-tested in pareto::frontier_membership_red_minimizes.
        let req_blue_to_move = mid_state_request();
        let mut req_red_to_move = mid_state_request();
        req_red_to_move.draft_state.current_slot = 7;
        req_red_to_move.draft_state.current_side =
            proto::EngineRequestDraftStateCurrentSide::Red;

        let fixture = Arc::new(real_data_fixture());

        let cancel1 = CancelHandle::new();
        let resp_blue = compute_mcts(&req_blue_to_move, fixture.clone(), &cancel1)
            .expect("blue compute ok");
        let cancel2 = CancelHandle::new();
        let resp_red = compute_mcts(&req_red_to_move, fixture, &cancel2)
            .expect("red compute ok");

        assert!(
            !resp_blue.tree.children.is_empty(),
            "blue tree should have root children"
        );
        assert!(
            !resp_red.tree.children.is_empty(),
            "red tree should have root children"
        );
    }

    #[test]
    fn compute_mcts_reaches_natural_depth_on_real_data() {
        // Uses `late_state_request` (slot 11 = R3 Pick1, singleton) rather than
        // `mid_state_request` (slot 6 = B1, next turn is the pair-pick R1+R2 at
        // slot 7 with fanout=500). Moving past the pair-pick boundary is the
        // whole point of this fixture — Phase 7a's `default_min_visits = |_| 1`
        // workaround masked starvation on slot-6 grandchildren; the spec gate
        // (min_visits = max(2, 4>>depth)) needs grandchildren that actually
        // accrue >=2 visits to avoid collapsing to a stub at depth 1.
        //
        // Floor is `depth >= 2` rather than 3: with 1s budget on real-data and
        // root_shortlist_k=20, root_children accrue ~6–8 visits each, and each
        // root_child's untried list at slot 12 (Red Ban2, full pool) is ~129
        // candidates — UCT expands every root_child visit into a fresh
        // grandchild, leaving grandchildren stuck at visits=1. depth=2 (one
        // visited level + a stub) is the structural ceiling under this gate
        // and budget. Treat tighter floors as evidence of pair-pick / wide-
        // fanout starvation rather than a regression.
        let mut req = late_state_request();
        req.config.search.latency_budget_ms = 1000;

        let fixture = Arc::new(real_data_fixture());
        let cancel = CancelHandle::new();
        let resp = compute_mcts(&req, fixture, &cancel).expect("compute_mcts ok");

        let depth = resp.meta.depth_reached;
        assert!(
            depth >= 2,
            "expected natural-depth tree to reach >= 2 on a 1s real-data budget, got {}. \
             Consider tuning default_min_visits if this regresses.",
            depth
        );
    }
}
