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
use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::evaluator::ScoreSet;
use engine_core::mcts_spike::pareto::frontier_membership;
use engine_core::mcts_spike::policy::{McTsConfig, Mcts, SubtreeWalkResult, VisitedSubtree};
use engine_core::mcts_spike::real_data_fixture::load_real_data_fixture;
use engine_core::mcts_spike::rollout::{FeasibilityMode, RolloutPolicy};
use engine_core::mcts_spike::tree::MoveId;
use engine_core::mcts_spike::{PoolContext, SpikeFixture, ValueVector};
use engine_core::pools::{RolePoolMap, TeamPool};
use engine_core::protocol_types as proto;

use crate::error;

/// Max tree depth `subtree_walk` recurses to. Beyond this is truncated.
const MAX_DEPTH: usize = 6;
/// Cap on root_children breadth. Honors request branch_width up to this.
const MAX_TOP_K_AT_ROOT: usize = 16;
/// Cap on per-level breadth at depth > 0.
const TOP_K_AT_DEPTH: usize = 8;
/// Hard cap on total rendered nodes (real + stubs) across the wire tree.
const MAX_NODES: usize = 512;
/// Synthetic scenario walks now follow the natural-depth tree to MAX_DEPTH.
const SCENARIO_DEPTH_CAP: usize = MAX_DEPTH;
/// Cancel polled every N iterations of the dispatch loop.
const POLL_EVERY: usize = 32;

/// Minimum visit threshold per depth. Returns 1 at every depth because the
/// MCTS spike's iterate has nonstandard visit accounting: intermediate nodes
/// only accumulate visits AFTER their own `untried` list is depleted (the
/// expansion path swaps `leaf` to the new child before backprop, so the
/// prior stopping point doesn't accrue). At pair-pick turns with hundreds
/// of untried candidates, even thousand-iter budgets leave most root_children
/// stuck at visits=1. A higher threshold (e.g. spec's `max(2, 4>>d)`) would
/// silently filter out the entire frontier. Phase 7b can revisit once the
/// spike's accounting matches standard MCTS.
fn default_min_visits(_depth: usize) -> u32 {
    1
}

/// Compute the maximum rendered depth in a forest. depth 1 = leaf only.
fn max_rendered_depth(siblings: &[VisitedSubtree]) -> usize {
    siblings
        .iter()
        .map(|s| {
            if s.children.is_empty() {
                1
            } else {
                1 + max_rendered_depth(&s.children)
            }
        })
        .max()
        .unwrap_or(0)
}

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
    let total_iter = mcts.total_iterations();

    let walk: SubtreeWalkResult = mcts.subtree_walk(
        MAX_DEPTH,
        top_k_at_root,
        TOP_K_AT_DEPTH,
        default_min_visits,
        MAX_NODES,
    );

    let wire_children = build_wire_tree_recursive(&walk.root_children, &state);
    let depth_reached = max_rendered_depth(&walk.root_children) as i64;
    let scenarios = extract_scenarios(&state, &wire_children);
    let root_node = build_wire_root(&state, wire_children);

    Ok(proto::EngineResponse {
        engine_id: format!("{}-mcts-spike", crate::projection::ENGINE_ID),
        protocol_version: crate::projection::PROTOCOL_VERSION.to_string(),
        request_id: None,
        meta: proto::EngineResponseMeta {
            cancelled,
            compute_time_ms: start.elapsed().as_millis() as f64,
            depth_reached,
            forced_branches_dropped: 0,
            nodes_evaluated: total_iter as i64,
            pruning_rate: 0.0,
            transpositions_found: 0,
            mcts_meta: Some(proto::EngineResponseMetaMctsMeta {
                algorithm: "mcts".to_string(),
                is_experimental: true,
                iterations: total_iter as i64,
                truncated: walk.truncated,
            }),
        },
        scenarios,
        tree: root_node,
    })
}

/// Recursive wire-tree builder. For each sibling group, computes Pareto
/// frontier membership oriented by the parent's side-to-move and descends
/// only into non-stub children. Stubs are emitted as leaves (visits=0,
/// paretoOnFrontier=Some(false), zeroed scores).
fn build_wire_tree_recursive(
    siblings: &[VisitedSubtree],
    parent_state: &DraftState,
) -> Vec<proto::TreeNode> {
    let parent_side = parent_state.current_turn().map(|t| t.side);
    let membership: Vec<Option<bool>> = match parent_side {
        Some(side) => frontier_membership(siblings, side),
        None => vec![None; siblings.len()],
    };
    let total_visits: u32 = siblings.iter().map(|s| s.visits).sum();

    let mut out: Vec<proto::TreeNode> = Vec::with_capacity(siblings.len());
    for (i, entry) in siblings.iter().enumerate() {
        let child_state = state_after_ids(parent_state, &entry.mv.champion_ids);
        let visit_share = if total_visits > 0 {
            entry.visits as f64 / total_visits as f64
        } else {
            0.0
        };
        let children = if entry.is_untried_stub || entry.children.is_empty() {
            Vec::new()
        } else {
            build_wire_tree_recursive(&entry.children, &child_state)
        };
        let composite = if entry.visits > 0 {
            entry.mean_value.composite()
        } else {
            0.0
        };
        let scores = scores_from_value_vector(composite, &entry.mean_value, entry.is_untried_stub);
        let pareto = if entry.is_untried_stub {
            Some(false)
        } else {
            membership[i]
        };
        out.push(build_wire_node(
            parent_state,
            &entry.mv,
            entry.visits,
            visit_share,
            pareto,
            scores,
            children,
        ));
    }
    out
}

/// Build synthetic scenarios — one per top-K root child — so the navigator UI
/// auto-expands the depth-2 tree along each top line. Each scenario walks the
/// highest-visit descendant of its root child down to `SCENARIO_DEPTH_CAP` and
/// accumulates the projected pick/ban state at the leaf.
///
/// Why a synthetic scenario per child: αβ emits scenarios that
/// `DecisionTree::expandForPaths` uses to seed the `expanded` set on the
/// frontend tree. Without them MCTS would render only the root with its
/// children collapsed — every fresh snapshot would re-collapse.
fn extract_scenarios(
    parent_state: &DraftState,
    wire_children: &[proto::TreeNode],
) -> Vec<proto::EngineResponseScenariosItem> {
    wire_children
        .iter()
        .enumerate()
        .map(|(idx, child)| {
            let rank = idx + 1;
            let (tree_path, leaf_state) =
                walk_deepest_path(child, parent_state, SCENARIO_DEPTH_CAP);
            let extras = child.mcts_extras.as_ref();
            let visits = extras.map(|e| e.visits).unwrap_or(0);
            let visit_share = extras.map(|e| e.visit_share).unwrap_or(0.0);
            let pct = (visit_share * 100.0).round() as i64;
            proto::EngineResponseScenariosItem {
                blue_bans: leaf_state.blue_bans.clone(),
                blue_picks: leaf_state.blue_picks.clone(),
                description: format!("Top by visit count: {}% · {} visits", pct, visits),
                indicators: Vec::new(),
                blue_likely_assignments: Vec::new(),
                red_likely_assignments: Vec::new(),
                name: format!("MCTS #{}", rank),
                // Reusing `Likely` rather than minting an `MctsTop` variant —
                // that'd cascade through zod-to-json-schema + typify regen +
                // frontend zod for purely cosmetic value. See design doc.
                perspective: proto::EngineResponseScenariosItemPerspective::Likely,
                red_bans: leaf_state.red_bans.clone(),
                red_picks: leaf_state.red_picks.clone(),
                scores: proto::EngineResponseScenariosItemScores {
                    comp_strength: 0.0,
                    composite: child.scores.composite,
                    information_value: 0.0,
                    role_coverage: 0.0,
                },
                tree_path,
            }
        })
        .collect()
}

/// Walk from `root_child` down the highest-visit descendant at each level
/// until a leaf or `depth_cap`. Returns the flat tree path along with the
/// projected draft state at the leaf (parent_state + each applied move).
///
/// "Highest-visit" relies on the spike's `root_visit_distribution` returning
/// children in DESC visit order — `build_wire_node` builds grandchildren in
/// that same order, so `children[0]` is the top-visit descendant.
///
/// Defensive: returns an empty path / unchanged state if the root child has
/// no champion_ids (shouldn't happen, but covers malformed input rather than
/// panicking).
fn walk_deepest_path(
    root_child: &proto::TreeNode,
    parent_state: &DraftState,
    depth_cap: usize,
) -> (Vec<proto::EngineResponseScenariosItemTreePathItem>, DraftState) {
    let mut path = Vec::with_capacity(depth_cap);
    let mut cursor_state = parent_state.clone();
    let mut cursor_node = root_child;

    for depth in 0..depth_cap {
        if cursor_node.champion_ids.is_empty() {
            break;
        }
        let slot = cursor_state.turn_index() as i64;
        path.push(proto::EngineResponseScenariosItemTreePathItem {
            slot,
            champion_ids: cursor_node.champion_ids.clone(),
        });
        cursor_state = state_after_ids(&cursor_state, &cursor_node.champion_ids);
        if depth + 1 >= depth_cap {
            break;
        }
        let next = cursor_node.children.iter().find(|c| {
            c.mcts_extras.as_ref().map(|e| e.visits > 0).unwrap_or(false)
        });
        match next {
            Some(n) => cursor_node = n,
            None => break,
        }
    }

    (path, cursor_state)
}

/// Apply a sequence of champion IDs to `base` using the turn at `base`'s
/// current turn index. Pair moves stay on the same side+action (e.g. R2+R3
/// pair pick), so we read the turn once before pushing.
fn state_after_ids(base: &DraftState, champion_ids: &[String]) -> DraftState {
    let mut next = base.clone();
    let Some(turn) = next.current_turn() else {
        return next;
    };
    for c in champion_ids {
        match (turn.side, turn.action_type) {
            (Side::Blue, ActionType::Pick) => next.blue_picks.push(c.clone()),
            (Side::Red, ActionType::Pick) => next.red_picks.push(c.clone()),
            (Side::Blue, ActionType::Ban) => next.blue_bans.push(c.clone()),
            (Side::Red, ActionType::Ban) => next.red_bans.push(c.clone()),
        }
    }
    next
}

/// Build the wire `TreeNode` for a non-root node — the move was applied to
/// `parent_state` to reach this node. Caller supplies the pre-computed
/// scores and Pareto-frontier membership; this fn assembles the proto node.
fn build_wire_node(
    parent_state: &DraftState,
    mv: &MoveId,
    visits: u32,
    visit_share: f64,
    pareto_on_frontier: Option<bool>,
    scores: proto::TreeNodeScores,
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
    proto::TreeNode {
        action_type,
        assignment_distribution: vec![],
        champion_ids: mv.champion_ids.clone(),
        children,
        phase,
        scores,
        side,
        slots,
        user_injected: false,
        mcts_extras: Some(proto::TreeNodeMctsExtras {
            visits: visits as i64,
            visit_share,
            pareto_on_frontier,
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
fn scores_from_value_vector(
    composite: f64,
    v: &ValueVector,
    is_stub: bool,
) -> proto::TreeNodeScores {
    let s = if is_stub {
        ScoreSet::default()
    } else {
        ScoreSet {
            composite,
            flexRetention: v.flex,
            ..Default::default()
        }
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
                truncated: false,
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

    #[test]
    fn compute_mcts_emits_synthetic_scenarios() {
        let req = mid_state_request();
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

        // Flex retention is plumbed from mean_value.flex on every non-stub node.
        // The field is always populated; whether the value is non-zero depends
        // on rollout outcomes (flex_retention_for_picks computes entropy of role
        // assignments at terminal — could be 0 for unique assignments).
        fn any_nonzero_flex(node: &proto::TreeNode) -> bool {
            if node.scores.flex_retention != 0.0 {
                return true;
            }
            node.children.iter().any(any_nonzero_flex)
        }
        assert!(
            any_nonzero_flex(&resp.tree),
            "expected at least one node with non-zero flexRetention"
        );

        // At least one root child carries mctsExtras (paretoOnFrontier may be
        // None when the gate fails on visits=1 nodes — see Decision 4).
        let any_extras = resp
            .tree
            .children
            .iter()
            .any(|c| c.mcts_extras.is_some());
        assert!(any_extras, "expected at least one root child with mctsExtras set");
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
        // Realistic 1s budget on real-data fixture. Asserts the natural-depth
        // walk produces a tree with rendered depth >= 3. Guards against
        // default_min_visits choices that silently starve deep levels.
        let mut req = mid_state_request();
        req.config.search.latency_budget_ms = 1000;

        let fixture = Arc::new(real_data_fixture());
        let cancel = CancelHandle::new();
        let resp = compute_mcts(&req, fixture, &cancel).expect("compute_mcts ok");

        let depth = resp.meta.depth_reached;
        assert!(
            depth >= 3,
            "expected natural-depth tree to reach >= 3 on a 1s real-data budget, got {}. \
             Consider tuning default_min_visits if this regresses.",
            depth
        );
    }
}
