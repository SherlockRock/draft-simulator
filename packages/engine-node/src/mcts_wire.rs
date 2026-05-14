//! Shared wire-build helpers for the MCTS dispatch surface.
//!
//! Both `mcts_dispatch::compute_mcts` (one-shot path) and the Phase 7b
//! NavigatorSession iterate loop project the same `Mcts::subtree_walk` output
//! into the wire `proto::EngineResponse` shape. Extracting the helpers here
//! avoids duplication across those two entry points.
//!
//! Spike-shape allowed below the dispatch boundary (`unwrap()` for
//! assumed-present fields is fine; this is dev-only tooling gated on a
//! navigator env var).

use std::time::Duration;

use engine_core::draft_state::{ActionType, DraftState, Phase, Side};
use engine_core::evaluator::ScoreSet;
use engine_core::mcts_spike::pareto::frontier_membership;
use engine_core::mcts_spike::policy::{Mcts, SubtreeWalkResult, VisitedSubtree};
use engine_core::mcts_spike::tree::MoveId;
use engine_core::mcts_spike::ValueVector;
use engine_core::protocol_types as proto;

/// Max tree depth `subtree_walk` recurses to. Beyond this is truncated.
pub(crate) const MAX_DEPTH: usize = 6;
/// Cap on root_children breadth. Honors request branch_width up to this.
pub(crate) const MAX_TOP_K_AT_ROOT: usize = 16;
/// Cap on per-level breadth at depth > 0.
pub(crate) const TOP_K_AT_DEPTH: usize = 8;
/// Hard cap on total rendered nodes (real + stubs) across the wire tree.
pub(crate) const MAX_NODES: usize = 512;
/// Synthetic scenario walks now follow the natural-depth tree to MAX_DEPTH.
pub(crate) const SCENARIO_DEPTH_CAP: usize = MAX_DEPTH;
/// Cancel polled every N iterations of the dispatch loop.
pub(crate) const POLL_EVERY: usize = 32;
/// First partial emit fires only after total iterations cross this floor —
/// avoids broadcasting a snapshot before MCTS has accrued enough visits for
/// the natural-depth render to be meaningful. See Phase 7b §Decision 6.
/// Consumed by NavigatorSession (T6); kept here so both dispatch paths share
/// the constant when the partial-emit logic lands.
#[allow(dead_code)]
pub(crate) const FIRST_EMIT_THRESHOLD: u32 = 1024;
/// Minimum wall-clock gap between consecutive partial emits. Pairs with the
/// visit-doubling cadence to throttle wire traffic on long-running sessions.
#[allow(dead_code)]
pub(crate) const MIN_EMIT_INTERVAL_MS: u64 = 100;

/// Minimum visit threshold per depth: max(2, 4 >> depth).
/// depth 0 = 4, depth >= 1 = 2. Phase 7b §Decision 5.
pub(crate) fn default_min_visits(depth: usize) -> u32 {
    2u32.max(4u32.checked_shr(depth as u32).unwrap_or(0))
}

/// Compute the maximum rendered depth in a forest. depth 1 = leaf only.
pub(crate) fn max_rendered_depth(siblings: &[VisitedSubtree]) -> usize {
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

/// Recursive wire-tree builder. For each sibling group, computes Pareto
/// frontier membership oriented by the parent's side-to-move and descends
/// only into non-stub children. Stubs are emitted as leaves (visits=0,
/// paretoOnFrontier=Some(false), zeroed scores).
pub(crate) fn build_wire_tree_recursive(
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
pub(crate) fn extract_scenarios(
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
pub(crate) fn walk_deepest_path(
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
pub(crate) fn state_after_ids(base: &DraftState, champion_ids: &[String]) -> DraftState {
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
pub(crate) fn build_wire_node(
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

pub(crate) fn build_wire_root(state: &DraftState, children: Vec<proto::TreeNode>) -> proto::TreeNode {
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
pub(crate) fn scores_from_value_vector(
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
pub(crate) fn zero_scores() -> proto::TreeNodeScores {
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

/// Render an `Mcts` snapshot into the wire `EngineResponse` shape used by
/// both `mcts_dispatch::compute_mcts` (one-shot) and `NavigatorSession`'s
/// iterate loop (final snapshot). `state` is the projected draft state at
/// the active root — callers pass `mcts.active_root_state()` for the session
/// path and the constant root state for the one-shot path (they coincide
/// when no reroot has occurred).
///
/// Caller-provided `cancelled` so the persistence matrix is honored:
/// dispatch sets it from `cancel.is_cancelled()`, the session path sets it
/// to `false` on a stop-initiated exit and `cancel.is_cancelled()` otherwise.
pub(crate) fn build_response(
    mcts: &Mcts<'_>,
    state: &DraftState,
    elapsed: Duration,
    cancelled: bool,
    top_k_at_root: usize,
) -> proto::EngineResponse {
    let total_iter = mcts.total_iterations();
    let walk: SubtreeWalkResult = mcts.subtree_walk(
        MAX_DEPTH,
        top_k_at_root,
        TOP_K_AT_DEPTH,
        default_min_visits,
        MAX_NODES,
    );
    let wire_children = build_wire_tree_recursive(&walk.root_children, state);
    let depth_reached = max_rendered_depth(&walk.root_children) as i64;
    let scenarios = extract_scenarios(state, &wire_children);
    let root_node = build_wire_root(state, wire_children);

    proto::EngineResponse {
        engine_id: format!("{}-mcts-spike", crate::projection::ENGINE_ID),
        protocol_version: crate::projection::PROTOCOL_VERSION.to_string(),
        request_id: None,
        meta: proto::EngineResponseMeta {
            cancelled,
            compute_time_ms: elapsed.as_millis() as f64,
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
            // Phase 7b Decision 6/7: T9 will plumb session-supplied values
            // through here. For T8 the schema additions are wired but the
            // call sites still default — partial=None (final), root_path empty.
            partial: None,
            root_path: Vec::new(),
        },
        scenarios,
        tree: root_node,
    }
}

pub(crate) fn empty_response(elapsed_ms: u64, iterations: u32) -> proto::EngineResponse {
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
            // Phase 7b: empty_response is the no-iterations short-circuit; it
            // is a final snapshot with no reroot, so partial=None and
            // root_path stays empty.
            partial: None,
            root_path: Vec::new(),
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
