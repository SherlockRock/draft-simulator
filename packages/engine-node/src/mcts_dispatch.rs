//! v5 phase 4 — engine-node dispatch into the experimental MCTS spike.
//!
//! When `EngineRequest.algorithm == Some("mcts")`, `Engine.compute` routes
//! through this module instead of the production αβ path. The output is
//! projected into the existing `proto::EngineResponse` shape with two
//! optional MCTS-specific fields:
//!   - `meta.mctsMeta` — `{ algorithm, iterations, isExperimental }`
//!   - `tree.children[*].mctsExtras` — `{ visits, visitShare }`
//!
//! Production αβ never sets these. Spike-shape allowed below the dispatch
//! boundary (`unwrap()` for assumed-present fields is fine; this is dev-only
//! tooling gated on a navigator env var).
//!
//! Cancellation is polled inside the iterate loop (`token.is_cancelled()`).
//! Phase 7 will deepen this with the production `cancellation::CancelHandle`
//! integration.
//!
//! Tree shape for phase 4: depth-2 (root → top-K children → top-K
//! grandchildren). Walking deeper requires multiple reroot calls and quickly
//! eats budget; phase 7 may revisit.
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
use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::evaluator::ScoreSet;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts};
use engine_core::mcts_spike::real_data_fixture::load_real_data_fixture;
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::tree::MoveId;
use engine_core::mcts_spike::{PoolContext, SpikeFixture, ValueVector};
use engine_core::pools::{RolePoolMap, TeamPool};
use engine_core::protocol_types as proto;

use crate::error;

/// `branch_width` from production search params is reused as MCTS top-K at
/// the root and at depth-1 expansion. αβ uses 5 for ban turns + first-pick;
/// the spike's `mcts_full_draft` uses `SHORTLIST_K=20` for pair turns. We
/// take the request's `branchWidth` directly so the navigator's tree-display
/// width (capped at `TREE_DISPLAY_WIDTH=32` in projection.rs) matches.
const DEFAULT_TOP_K: usize = 5;

/// How much of the latency budget to spend at the root vs splitting across
/// depth-1 children. Half-half is a defensible spike-quality default; phase 7
/// can tune (e.g. PUCB-style allocation).
const ROOT_BUDGET_FRACTION: f64 = 0.5;

/// Minimum per-child budget at depth 1. Avoids reduce-to-zero allocations
/// when top-K is large or total budget is small.
const MIN_CHILD_BUDGET_MS: u64 = 80;

/// Cap depth-1 expansion to this many children. Beyond this, returns the
/// remaining top-K children with empty grandchildren (the αβ tree projection
/// still caps at `TREE_DISPLAY_WIDTH=32`, so anything past that is invisible).
const MAX_EXPANDED_CHILDREN: usize = 8;

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
    let _ = our_side; // Mcts derives picking-side from state.current_turn(); kept for symmetry / future use.

    let total_budget_ms = req.config.search.latency_budget_ms.max(0) as u64;
    let top_k = (req.config.search.branch_width.max(1) as usize)
        .clamp(1, MAX_EXPANDED_CHILDREN.max(DEFAULT_TOP_K));
    let seed = derive_seed(&state);

    let cfg = McTsConfig {
        policy: RolloutPolicy::UniformFeasible,
        feasibility_mode: FeasibilityMode::Cached,
        seed,
        // Use top_k at the root so the visit budget concentrates on the same
        // candidates we'll surface in the tree. Spike's `mcts_full_draft`
        // shows the search converges much faster with shortlist than without.
        root_shortlist_k: Some(top_k.max(20).min(40)),
    };

    if state.is_complete() {
        // Defensive: the request shouldn't reach here, but match αβ's behavior
        // of returning a degenerate-but-valid tree rather than panicking.
        return Ok(empty_response(start.elapsed().as_millis() as u64, 0));
    }

    let mut mcts = Mcts::with_pools(fixture.as_ref(), state.clone(), &pools, cfg);

    // ----- Root search -----
    let root_budget = budget_split(total_budget_ms, ROOT_BUDGET_FRACTION);
    run_iterate_loop(&mut mcts, root_budget, cancel);

    let root_dist = mcts.root_visit_distribution();
    let root_total: u32 = root_dist.iter().map(|(_, v, _)| *v).sum();
    let root_total_iter_for_meta = mcts.total_iterations();
    let cancelled = cancel.is_cancelled();

    let top_children: Vec<&(MoveId, u32, ValueVector)> =
        root_dist.iter().take(top_k).collect();

    // ----- Depth-1 expansion: reroot per top-K child, run smaller budget -----
    let mut wire_children: Vec<proto::TreeNode> = Vec::with_capacity(top_children.len());
    let remaining_budget = total_budget_ms.saturating_sub(root_budget);
    let per_child_budget = if !top_children.is_empty() {
        (remaining_budget / top_children.len() as u64).max(MIN_CHILD_BUDGET_MS)
    } else {
        0
    };

    for (mv, visits, mean_value) in &top_children {
        // Project the child node's wire shape from the current state at this
        // MCTS root. Reroot, run a quick search, collect grandchildren.
        let child_state = state_after_move(&state, mv);
        let child_visits = *visits;
        let visit_share = if root_total > 0 {
            child_visits as f64 / root_total as f64
        } else {
            0.0
        };

        let mut grandchildren: Vec<proto::TreeNode> = Vec::new();
        if !child_state.is_complete() && per_child_budget > 0 && !cancelled {
            // Reroot only succeeds if the child is in the active root's
            // children list. With shortlisting + UCT, every visited child
            // qualifies — `root_visit_distribution` enumerates exactly those.
            if mcts.reroot_to(mv).is_ok() {
                run_iterate_loop(&mut mcts, per_child_budget, cancel);
                let grand_dist = mcts.root_visit_distribution();
                let grand_total: u32 = grand_dist.iter().map(|(_, v, _)| *v).sum();
                for (g_mv, g_visits, g_mean) in grand_dist.iter().take(top_k) {
                    grandchildren.push(build_wire_node(
                        &child_state,
                        g_mv,
                        *g_visits,
                        *g_mean,
                        g_visits_share(g_visits, grand_total),
                        Vec::new(), // no depth-3 expansion in phase 4
                    ));
                }
                // Walk back up so the next sibling reroots from the same
                // root we started at.
                let _ = mcts.uproot();
            }
        }

        wire_children.push(build_wire_node(
            &state,
            mv,
            child_visits,
            *mean_value,
            visit_share,
            grandchildren,
        ));
    }

    let root_node = build_wire_root(&state, wire_children);

    Ok(proto::EngineResponse {
        engine_id: format!("{}-mcts-spike", crate::projection::ENGINE_ID),
        protocol_version: crate::projection::PROTOCOL_VERSION.to_string(),
        request_id: None,
        meta: proto::EngineResponseMeta {
            cancelled,
            compute_time_ms: start.elapsed().as_millis() as f64,
            depth_reached: if !top_children.is_empty() { 2 } else { 1 },
            forced_branches_dropped: 0,
            nodes_evaluated: root_total_iter_for_meta as i64,
            pruning_rate: 0.0,
            transpositions_found: 0,
            mcts_meta: Some(proto::EngineResponseMetaMctsMeta {
                algorithm: "mcts".to_string(),
                is_experimental: true,
                iterations: root_total_iter_for_meta as i64,
            }),
        },
        // Spike does not extract scenarios — the navigator UI hides scenario
        // chrome when the array is empty (see frontend handleDraftUpdate).
        scenarios: Vec::new(),
        tree: root_node,
    })
}

fn run_iterate_loop(mcts: &mut Mcts<'_>, budget_ms: u64, cancel: &CancelHandle) {
    if budget_ms == 0 {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(budget_ms);
    // Poll cancel every N iterations to keep the hot loop tight while still
    // staying responsive to supersession (≤50ms latency target per the
    // production gate).
    const POLL_EVERY: usize = 32;
    let mut counter: usize = 0;
    while Instant::now() < deadline {
        if counter % POLL_EVERY == 0 && cancel.is_cancelled() {
            return;
        }
        mcts.iterate();
        counter += 1;
    }
}

fn budget_split(total_ms: u64, root_fraction: f64) -> u64 {
    let raw = (total_ms as f64 * root_fraction) as u64;
    raw.max(1)
}

fn g_visits_share(visits: &u32, total: u32) -> f64 {
    if total == 0 {
        0.0
    } else {
        *visits as f64 / total as f64
    }
}

/// Apply a MoveId to a state. Mirrors `mcts_spike::policy::apply_move` (which
/// is `pub(crate)`). Duplicated here because the spike's `apply_move` isn't
/// publicly exported.
fn state_after_move(base: &DraftState, mv: &MoveId) -> DraftState {
    let mut next = base.clone();
    let Some(turn) = next.current_turn() else {
        return next;
    };
    for c in &mv.champion_ids {
        match (turn.side, mv.is_pick) {
            (Side::Blue, true) => next.blue_picks.push(c.clone()),
            (Side::Red, true) => next.red_picks.push(c.clone()),
            (Side::Blue, false) => next.blue_bans.push(c.clone()),
            (Side::Red, false) => next.red_bans.push(c.clone()),
        }
    }
    next
}

/// Build the wire `TreeNode` for a non-root node — the move was applied to
/// `parent_state` to reach this node.
fn build_wire_node(
    parent_state: &DraftState,
    mv: &MoveId,
    visits: u32,
    mean_value: ValueVector,
    visit_share: f64,
    children: Vec<proto::TreeNode>,
) -> proto::TreeNode {
    let parent_turn = parent_state.current_turn();
    let action_type = match parent_turn.map(|t| t.action_type) {
        Some(ActionType::Ban) => proto::TreeNodeActionType::Ban,
        _ => proto::TreeNodeActionType::Pick,
    };
    let phase = match parent_turn.map(|t| t.phase) {
        Some(Phase::Ban1) => proto::TreeNodePhase::Ban1,
        Some(Phase::Pick1) => proto::TreeNodePhase::Pick1,
        Some(Phase::Ban2) => proto::TreeNodePhase::Ban2,
        Some(Phase::Pick2) | None => proto::TreeNodePhase::Pick2,
    };
    let side = parent_turn.map(|t| match t.side {
        Side::Blue => proto::TreeNodeSide::Blue,
        Side::Red => proto::TreeNodeSide::Red,
    });
    let parent_idx = parent_state.turn_index();
    let slots: Vec<i64> = (0..mv.champion_ids.len())
        .map(|i| (parent_idx + i) as i64)
        .collect();
    let composite_mean = if visits > 0 {
        mean_value.composite()
    } else {
        0.0
    };
    proto::TreeNode {
        action_type,
        assignment_distribution: vec![],
        champion_ids: mv.champion_ids.clone(),
        children,
        phase,
        scores: scores_from_value_vector(composite_mean, &mean_value),
        side,
        slots,
        user_injected: false,
        mcts_extras: Some(proto::TreeNodeMctsExtras {
            visits: visits as i64,
            visit_share,
        }),
    }
}

fn build_wire_root(state: &DraftState, children: Vec<proto::TreeNode>) -> proto::TreeNode {
    let turn = state.current_turn();
    let phase = match turn.map(|t| t.phase) {
        Some(Phase::Ban1) => proto::TreeNodePhase::Ban1,
        Some(Phase::Pick1) => proto::TreeNodePhase::Pick1,
        Some(Phase::Ban2) => proto::TreeNodePhase::Ban2,
        Some(Phase::Pick2) | None => proto::TreeNodePhase::Pick2,
    };
    let action_type = match turn.map(|t| t.action_type) {
        Some(ActionType::Ban) => proto::TreeNodeActionType::Ban,
        _ => proto::TreeNodeActionType::Pick,
    };
    let side = turn.map(|t| match t.side {
        Side::Blue => proto::TreeNodeSide::Blue,
        Side::Red => proto::TreeNodeSide::Red,
    });
    proto::TreeNode {
        action_type,
        assignment_distribution: vec![],
        champion_ids: vec![],
        children,
        phase,
        scores: zero_scores(),
        side,
        slots: vec![],
        user_injected: false,
        mcts_extras: None,
    }
}

#[allow(non_snake_case)]
fn scores_from_value_vector(composite: f64, _v: &ValueVector) -> proto::TreeNodeScores {
    // Phase 4: project the spike's 3-axis ValueVector DOWN to composite only.
    // Other ScoreSet fields are zero — phase 7 will surface the full vector
    // alongside Pareto rank.
    let s = ScoreSet {
        composite,
        ..Default::default()
    };
    proto::TreeNodeScores {
        comp_strength: s.compStrength,
        composite: s.composite,
        flex_retention: s.flexRetention,
        information_value: s.informationValue,
        reveal_cost: s.revealCost,
        role_coverage: s.roleCoverage,
    }
}

#[allow(non_snake_case)]
fn zero_scores() -> proto::TreeNodeScores {
    let s = ScoreSet::default();
    proto::TreeNodeScores {
        comp_strength: s.compStrength,
        composite: s.composite,
        flex_retention: s.flexRetention,
        information_value: s.informationValue,
        reveal_cost: s.revealCost,
        role_coverage: s.roleCoverage,
    }
}

fn empty_response(elapsed_ms: u64, iterations: u32) -> proto::EngineResponse {
    proto::EngineResponse {
        engine_id: format!("{}-mcts-spike", crate::projection::ENGINE_ID),
        protocol_version: crate::projection::PROTOCOL_VERSION.to_string(),
        request_id: None,
        meta: proto::EngineResponseMeta {
            cancelled: false,
            compute_time_ms: elapsed_ms as f64,
            depth_reached: 0,
            forced_branches_dropped: 0,
            nodes_evaluated: iterations as i64,
            pruning_rate: 0.0,
            transpositions_found: 0,
            mcts_meta: Some(proto::EngineResponseMetaMctsMeta {
                algorithm: "mcts".to_string(),
                is_experimental: true,
                iterations: iterations as i64,
            }),
        },
        scenarios: Vec::new(),
        tree: proto::TreeNode {
            action_type: proto::TreeNodeActionType::Pick,
            assignment_distribution: vec![],
            champion_ids: vec![],
            children: vec![],
            phase: proto::TreeNodePhase::Pick2,
            scores: zero_scores(),
            side: None,
            slots: vec![],
            user_injected: false,
            mcts_extras: None,
        },
    }
}

fn build_draft_state(ds: &proto::EngineRequestDraftState) -> Result<DraftState, napi::Error> {
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

fn build_pool_context(
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
fn derive_seed(state: &DraftState) -> u64 {
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
