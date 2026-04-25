use crate::cancellation::{ensure_not_cancelled, CancelHandle};
use crate::draft_state::{ActionType, DraftState, Phase, Side, TurnInfo, TURN_SEQUENCE};
use crate::engine::EngineError;
use crate::evaluator::{score_pick, EvalContext, ScoreSet};
use crate::forced_branches::{resolve_path, ForcedBranch, ForcedMode, PathMatch};
use crate::pair_filter::{seed_pair_candidates, PairFilterConfig};
use crate::pools::{Role, TeamPool};
use crate::role_solver::ChampionMeta;
use crate::transposition::{StateHash, TranspositionCache};
use rayon::prelude::*;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct SearchParams {
    pub branch_width: usize,
    pub max_depth: usize,
    /// When true, alpha-beta cutoffs are disabled and every candidate within
    /// `branch_width` is fully explored. Used by the correctness property test
    /// to validate that pruning never changes the back-propagated root score.
    pub disable_alpha_beta: bool,
    /// Forced branches override or augment candidate sets at specific
    /// content-addressed paths. See `forced_branches.rs` and the spec section
    /// "Swap and Branch Semantics".
    pub forced_branches: Vec<ForcedBranch>,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            branch_width: 5,
            max_depth: 6,
            disable_alpha_beta: false,
            forced_branches: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TreeNode {
    pub champion_ids: Vec<String>,
    pub scores: ScoreSet,
    pub side: Option<Side>,
    pub slots: Vec<usize>,
    pub action_type: ActionType,
    pub phase: Phase,
    pub user_injected: bool,
    pub children: Vec<TreeNode>,
}

/// Mutable accumulators threaded through the recursion. Holds counters that
/// the caller may want to surface alongside the produced tree (in `SearchStats`).
#[derive(Clone, Debug, Default)]
struct SearchAccum {
    /// Indices of `forced_branches` that were applied at least once during the
    /// search. The final `forced_branches_dropped` is `total - applied`.
    applied_forced: HashSet<usize>,
    nodes_evaluated: usize,
    nodes_pruned: usize,
}

pub fn search(
    state: &DraftState,
    params: &SearchParams,
    eval_ctx: &EvalContext,
    cancel: &CancelHandle,
) -> Result<TreeNode, EngineError> {
    let (tree, _stats) = search_with_stats(state, params, eval_ctx, cancel)?;
    Ok(tree)
}

/// Like `search`, but also reports cache statistics (transposition hits, entries)
/// and the count of forced branches that did not resolve to any node in the tree.
pub fn search_with_stats(
    state: &DraftState,
    params: &SearchParams,
    eval_ctx: &EvalContext,
    cancel: &CancelHandle,
) -> Result<(TreeNode, SearchStats), EngineError> {
    validate_forced_branches(state, &params.forced_branches)?;

    let mut cache: TranspositionCache<TreeNode> = TranspositionCache::new();
    let mut accum = SearchAccum::default();
    let mut lineage: Vec<(usize, Vec<String>)> = Vec::new();
    let tree = search_recursive(
        state,
        params,
        params.max_depth,
        eval_ctx,
        cancel,
        &mut cache,
        &mut accum,
        &mut lineage,
        f64::NEG_INFINITY,
        f64::INFINITY,
    )?;
    let stats = SearchStats {
        transpositions_found: cache.hits(),
        cache_entries: cache.len(),
        nodes_evaluated: accum.nodes_evaluated,
        nodes_pruned: accum.nodes_pruned,
        forced_branches_dropped: params
            .forced_branches
            .len()
            .saturating_sub(accum.applied_forced.len()),
    };
    Ok((tree, stats))
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SearchStats {
    pub transpositions_found: usize,
    pub cache_entries: usize,
    pub nodes_evaluated: usize,
    pub nodes_pruned: usize,
    /// Forced branches whose `path` did not resolve against any actual lineage
    /// during the search. Spec: silent drop, telemetry-only.
    pub forced_branches_dropped: usize,
}

/// Up-front structural validation of forced branches. Currently catches the
/// reverse-fill pair case (forcing `pair_start` when state has already moved
/// past it — pair-end implicitly confirmed). Other illegal inputs (out-of-range
/// slot, unresolved path) fail soft in the search loop.
fn validate_forced_branches(
    state: &DraftState,
    branches: &[ForcedBranch],
) -> Result<(), EngineError> {
    for (idx, fb) in branches.iter().enumerate() {
        let target_turn = match TURN_SEQUENCE.get(fb.target_slot) {
            Some(t) => t,
            None => continue,
        };
        if target_turn.pair_start && fb.target_slot < state.turn_index() {
            return Err(EngineError::InvalidInput {
                path: vec!["forcedBranches".to_string(), idx.to_string()],
            });
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn search_recursive(
    state: &DraftState,
    params: &SearchParams,
    remaining_depth: usize,
    eval_ctx: &EvalContext,
    cancel: &CancelHandle,
    cache: &mut TranspositionCache<TreeNode>,
    accum: &mut SearchAccum,
    lineage: &mut Vec<(usize, Vec<String>)>,
    mut alpha: f64,
    mut beta: f64,
) -> Result<TreeNode, EngineError> {
    ensure_not_cancelled(cancel)?;

    // Transposition lookup. Cache key includes remaining_depth so that a
    // shallow cached result doesn't replace what a deeper search would compute.
    let cache_key = state_cache_key(state, remaining_depth);
    if let Some(hit) = cache.get(&cache_key) {
        return Ok(hit);
    }

    let turn_opt = state.current_turn();

    // Terminal or depth-bound: produce a leaf node carrying a static evaluation.
    if turn_opt.is_none() || remaining_depth == 0 {
        let value = eval_state(state, eval_ctx);
        let leaf = TreeNode {
            champion_ids: vec![],
            scores: ScoreSet {
                composite: value,
                ..Default::default()
            },
            side: turn_opt.map(|t| t.side),
            slots: vec![],
            action_type: turn_opt.map(|t| t.action_type).unwrap_or(ActionType::Pick),
            phase: turn_opt.map(|t| t.phase).unwrap_or(Phase::Pick2),
            user_injected: false,
            children: vec![],
        };
        cache.insert(cache_key, leaf.clone());
        return Ok(leaf);
    }

    let turn = turn_opt.expect("guarded above");

    // Pair-pick turns expand both halves as a single decision unit.
    if turn.pair_start {
        return expand_pair(
            state,
            params,
            remaining_depth,
            eval_ctx,
            cancel,
            cache,
            accum,
            lineage,
            alpha,
            beta,
            turn,
        );
    }

    accum.nodes_evaluated += 1;

    let our_turn = turn.side == eval_ctx.side;
    let candidates = collect_candidates(state, turn, eval_ctx);
    let ranked = score_and_rank(
        &candidates,
        state,
        turn,
        eval_ctx,
        our_turn,
        params.branch_width,
    );

    // Apply forced branches at this single-slot expansion.
    let current_slot = state.turn_index();
    let (forced_set, injected_ids) =
        apply_single_slot_forces(&params.forced_branches, current_slot, lineage, accum, &ranked);

    let mut children: Vec<TreeNode> = Vec::with_capacity(forced_set.len());
    let mut best_value = if our_turn {
        f64::NEG_INFINITY
    } else {
        f64::INFINITY
    };

    for (idx, (champ, _static_score)) in forced_set.iter().enumerate() {
        ensure_not_cancelled(cancel)?;

        let mut child_state = state.clone();
        push_action(&mut child_state, turn, champ);

        lineage.push((current_slot, vec![champ.clone()]));
        let child_tree = search_recursive(
            &child_state,
            params,
            remaining_depth - 1,
            eval_ctx,
            cancel,
            cache,
            accum,
            lineage,
            alpha,
            beta,
        )?;
        lineage.pop();
        let child_value = child_tree.scores.composite;

        let branch_node = TreeNode {
            champion_ids: vec![champ.clone()],
            scores: ScoreSet {
                composite: child_value,
                ..Default::default()
            },
            side: Some(turn.side),
            slots: vec![current_slot],
            action_type: turn.action_type,
            phase: turn.phase,
            user_injected: injected_ids.contains(champ.as_str()),
            children: child_tree.children,
        };
        children.push(branch_node);

        if our_turn {
            if child_value > best_value {
                best_value = child_value;
            }
            if best_value > alpha {
                alpha = best_value;
            }
        } else {
            if child_value < best_value {
                best_value = child_value;
            }
            if best_value < beta {
                beta = best_value;
            }
        }
        if !params.disable_alpha_beta && alpha >= beta {
            accum.nodes_pruned += forced_set.len().saturating_sub(idx + 1);
            break;
        }
    }

    if children.is_empty() {
        // No legal candidates (e.g., depleted pool). Treat as terminal.
        best_value = eval_state(state, eval_ctx);
    }

    // Sort children by composite descending so tree-builders/UI see best-first.
    children.sort_by(|a, b| {
        b.scores
            .composite
            .partial_cmp(&a.scores.composite)
            .unwrap_or(Ordering::Equal)
    });

    let result = TreeNode {
        champion_ids: vec![],
        scores: ScoreSet {
            composite: best_value,
            ..Default::default()
        },
        side: Some(turn.side),
        slots: vec![current_slot],
        action_type: turn.action_type,
        phase: turn.phase,
        user_injected: false,
        children,
    };
    cache.insert(cache_key, result.clone());
    Ok(result)
}

/// Returns the candidate list to actually expand at this single-slot turn,
/// after applying any matching forced branches. Also returns the set of
/// champion IDs that were injected by force (for `user_injected`).
///
/// A forced branch matches when its `path` resolves against `lineage` AND its
/// `target_slot` equals `current_slot`. Sole mode replaces the candidate set
/// with `[champion_id]`. Include mode appends `champion_id` after dedup.
/// Each application records the branch's index in `accum.applied_forced`.
fn apply_single_slot_forces(
    branches: &[ForcedBranch],
    current_slot: usize,
    lineage: &[(usize, Vec<String>)],
    accum: &mut SearchAccum,
    ranked: &[(String, f64)],
) -> (Vec<(String, f64)>, HashSet<String>) {
    let mut out: Vec<(String, f64)> = ranked.to_vec();
    let mut injected: HashSet<String> = HashSet::new();
    let mut sole_override: Option<(usize, String)> = None;

    for (idx, fb) in branches.iter().enumerate() {
        if fb.target_slot != current_slot {
            continue;
        }
        if !matches!(resolve_path(&fb.path, lineage), PathMatch::Resolved { .. }) {
            continue;
        }
        accum.applied_forced.insert(idx);
        match fb.mode {
            ForcedMode::Sole => {
                // Last sole-mode wins if multiple at same slot. (Multiple soles
                // at the same slot are not expected; this preserves determinism.)
                sole_override = Some((idx, fb.champion_id.clone()));
            }
            ForcedMode::Include => {
                if !out.iter().any(|(c, _)| c == &fb.champion_id) {
                    out.push((fb.champion_id.clone(), 0.0));
                }
                injected.insert(fb.champion_id.clone());
            }
        }
    }

    if let Some((_idx, id)) = sole_override {
        injected.insert(id.clone());
        return (vec![(id, 0.0)], injected);
    }
    (out, injected)
}

/// Cache key combines state hash with remaining depth so a shallow cached
/// result isn't reused at a deeper call where more search would have been done.
fn state_cache_key(state: &DraftState, remaining_depth: usize) -> StateHash {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    StateHash::from(state).hash(&mut hasher);
    remaining_depth.hash(&mut hasher);
    StateHash::from_u64(hasher.finish())
}

/// Static evaluation of a draft state from `ctx.side`'s perspective. Sums
/// composite score of each of our locked-in picks at their primary role.
/// Crude — Phase 7 wires a richer eval — but sufficient for minimax direction.
fn eval_state(state: &DraftState, ctx: &EvalContext) -> f64 {
    let our_picks = if ctx.side == Side::Blue {
        &state.blue_picks
    } else {
        &state.red_picks
    };
    let mut total = 0.0;
    for champ in our_picks {
        let role = primary_role(champ, &ctx.champion_meta).unwrap_or(Role::Top);
        let s = score_pick(champ, role, state, ctx);
        total += s.composite;
    }
    total
}

fn collect_candidates(state: &DraftState, turn: TurnInfo, ctx: &EvalContext) -> Vec<String> {
    let pool = pool_for(turn.side, ctx);
    let used: HashSet<&str> = state
        .blue_bans
        .iter()
        .map(String::as_str)
        .chain(state.red_bans.iter().map(String::as_str))
        .chain(state.blue_picks.iter().map(String::as_str))
        .chain(state.red_picks.iter().map(String::as_str))
        .collect();
    pool.search
        .iter()
        .filter(|c| !used.contains(c.as_str()))
        .cloned()
        .collect()
}

fn pool_for(turn_side: Side, ctx: &EvalContext) -> &TeamPool {
    if turn_side == ctx.side {
        &ctx.our_pool
    } else {
        &ctx.opp_pool
    }
}

fn score_and_rank(
    candidates: &[String],
    state: &DraftState,
    turn: TurnInfo,
    ctx: &EvalContext,
    our_turn: bool,
    branch_width: usize,
) -> Vec<(String, f64)> {
    let mut sub_ctx = ctx.clone();
    sub_ctx.side = turn.side;
    sub_ctx.phase = turn.phase;

    let mut scored: Vec<(String, f64)> = candidates
        .iter()
        .map(|c| {
            let role = primary_role(c, &ctx.champion_meta).unwrap_or(Role::Top);
            let s = score_pick(c, role, state, &sub_ctx);
            (c.clone(), s.composite)
        })
        .collect();

    // Move ordering: best-for-mover first improves alpha-beta pruning.
    if our_turn {
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    } else {
        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal));
    }
    scored.truncate(branch_width);
    scored
}

fn primary_role(champ: &str, meta: &HashMap<String, ChampionMeta>) -> Option<Role> {
    meta.get(champ).and_then(|m| m.positions.first().copied())
}

fn push_action(state: &mut DraftState, turn: TurnInfo, champ: &str) {
    match (turn.action_type, turn.side) {
        (ActionType::Ban, Side::Blue) => state.blue_bans.push(champ.into()),
        (ActionType::Ban, Side::Red) => state.red_bans.push(champ.into()),
        (ActionType::Pick, Side::Blue) => state.blue_picks.push(champ.into()),
        (ActionType::Pick, Side::Red) => state.red_picks.push(champ.into()),
    }
}

#[allow(clippy::too_many_arguments)]
fn expand_pair(
    state: &DraftState,
    params: &SearchParams,
    remaining_depth: usize,
    eval_ctx: &EvalContext,
    cancel: &CancelHandle,
    cache: &mut TranspositionCache<TreeNode>,
    accum: &mut SearchAccum,
    lineage: &mut Vec<(usize, Vec<String>)>,
    mut alpha: f64,
    mut beta: f64,
    turn: TurnInfo,
) -> Result<TreeNode, EngineError> {
    accum.nodes_evaluated += 1;

    let our_turn = turn.side == eval_ctx.side;
    let pair_start_slot = state.turn_index();
    let pair_end_slot = pair_start_slot + 1;
    let pair_end_turn = TURN_SEQUENCE[pair_end_slot];

    let candidates = collect_candidates(state, turn, eval_ctx);

    // Score every candidate as a single (used both to seed pair_filter and to score pairs).
    let mut sub_ctx = eval_ctx.clone();
    sub_ctx.side = turn.side;
    sub_ctx.phase = turn.phase;
    let scored_singles: Vec<(String, f64)> = candidates
        .par_iter()
        .filter_map(|c| {
            if cancel.is_cancelled() {
                None
            } else {
                let role = primary_role(c, &eval_ctx.champion_meta).unwrap_or(Role::Top);
                let s = score_pick(c, role, state, &sub_ctx);
                Some((c.clone(), s.composite))
            }
        })
        .collect();
    ensure_not_cancelled(cancel)?;

    // Detect pair-pick force: at most one sole-mode force per side of the pair
    // (pair_start or pair_end). Forces matching the lineage but with the wrong
    // mode for a pair node (include) are ignored.
    let pair_force = match_pair_force(
        &params.forced_branches,
        pair_start_slot,
        pair_end_slot,
        lineage,
        accum,
    );

    let scored_pairs = build_pair_candidates(
        &scored_singles,
        &pair_force,
        params.branch_width,
        our_turn,
    );

    let mut children: Vec<TreeNode> = Vec::with_capacity(scored_pairs.len());
    let mut best_value = if our_turn {
        f64::NEG_INFINITY
    } else {
        f64::INFINITY
    };

    let injected = pair_force.is_some();

    for (idx, (first, second, _static)) in scored_pairs.iter().enumerate() {
        ensure_not_cancelled(cancel)?;

        let mut child_state = state.clone();
        push_action(&mut child_state, turn, first);
        push_action(&mut child_state, pair_end_turn, second);

        lineage.push((pair_start_slot, vec![first.clone(), second.clone()]));
        let child_tree = search_recursive(
            &child_state,
            params,
            remaining_depth - 1,
            eval_ctx,
            cancel,
            cache,
            accum,
            lineage,
            alpha,
            beta,
        )?;
        lineage.pop();
        let child_value = child_tree.scores.composite;

        children.push(TreeNode {
            champion_ids: vec![first.clone(), second.clone()],
            scores: ScoreSet {
                composite: child_value,
                ..Default::default()
            },
            side: Some(turn.side),
            slots: vec![pair_start_slot, pair_end_slot],
            action_type: turn.action_type,
            phase: turn.phase,
            user_injected: injected,
            children: child_tree.children,
        });

        if our_turn {
            if child_value > best_value {
                best_value = child_value;
            }
            if best_value > alpha {
                alpha = best_value;
            }
        } else {
            if child_value < best_value {
                best_value = child_value;
            }
            if best_value < beta {
                beta = best_value;
            }
        }
        if !params.disable_alpha_beta && alpha >= beta {
            accum.nodes_pruned += scored_pairs.len().saturating_sub(idx + 1);
            break;
        }
    }

    if children.is_empty() {
        best_value = eval_state(state, eval_ctx);
    }
    children.sort_by(|a, b| {
        b.scores
            .composite
            .partial_cmp(&a.scores.composite)
            .unwrap_or(Ordering::Equal)
    });

    let result = TreeNode {
        champion_ids: vec![],
        scores: ScoreSet {
            composite: best_value,
            ..Default::default()
        },
        side: Some(turn.side),
        slots: vec![pair_start_slot, pair_end_slot],
        action_type: turn.action_type,
        phase: turn.phase,
        user_injected: false,
        children,
    };
    let cache_key = state_cache_key(state, remaining_depth);
    cache.insert(cache_key, result.clone());
    Ok(result)
}

/// Which slot of a pair is fixed by a forced branch, and to which champion.
/// `None` when no pair force matches the current lineage.
#[derive(Clone, Debug)]
enum PairForce {
    Start(String),
    End(String),
}

/// Finds at most one matching pair force at the current pair node. Sole mode
/// only — include-mode at a pair turn is dropped (and its index is NOT added
/// to `applied_forced`, so it'll count as dropped at the end).
fn match_pair_force(
    branches: &[ForcedBranch],
    pair_start_slot: usize,
    pair_end_slot: usize,
    lineage: &[(usize, Vec<String>)],
    accum: &mut SearchAccum,
) -> Option<PairForce> {
    for (idx, fb) in branches.iter().enumerate() {
        if fb.target_slot != pair_start_slot && fb.target_slot != pair_end_slot {
            continue;
        }
        if fb.mode != ForcedMode::Sole {
            continue;
        }
        if !matches!(resolve_path(&fb.path, lineage), PathMatch::Resolved { .. }) {
            continue;
        }
        accum.applied_forced.insert(idx);
        return Some(if fb.target_slot == pair_start_slot {
            PairForce::Start(fb.champion_id.clone())
        } else {
            PairForce::End(fb.champion_id.clone())
        });
    }
    None
}

/// Builds the pair candidate list for `expand_pair`, applying any pair force.
/// Without a force, falls back to `seed_pair_candidates`'s three-bucket
/// expansion. With a force, enumerates `forced × every other` directly so the
/// fixed slot is always the forced champion.
fn build_pair_candidates(
    scored_singles: &[(String, f64)],
    pair_force: &Option<PairForce>,
    branch_width: usize,
    our_turn: bool,
) -> Vec<(String, String, f64)> {
    let mut single_lookup: HashMap<&str, f64> = HashMap::with_capacity(scored_singles.len());
    for (id, score) in scored_singles {
        single_lookup.insert(id.as_str(), *score);
    }

    let mut scored_pairs: Vec<(String, String, f64)> = match pair_force {
        Some(PairForce::Start(forced)) => scored_singles
            .iter()
            .filter(|(c, _)| c != forced)
            .map(|(other, _)| {
                let value = single_lookup.get(forced.as_str()).copied().unwrap_or(0.0)
                    + single_lookup.get(other.as_str()).copied().unwrap_or(0.0);
                (forced.clone(), other.clone(), value)
            })
            .collect(),
        Some(PairForce::End(forced)) => scored_singles
            .iter()
            .filter(|(c, _)| c != forced)
            .map(|(other, _)| {
                let value = single_lookup.get(other.as_str()).copied().unwrap_or(0.0)
                    + single_lookup.get(forced.as_str()).copied().unwrap_or(0.0);
                (other.clone(), forced.clone(), value)
            })
            .collect(),
        None => {
            // pair_filter wants singles sorted DESC by score.
            let mut singles_desc: Vec<(String, f64)> = scored_singles.to_vec();
            singles_desc.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
            let scored_refs: Vec<(&str, f64)> = singles_desc
                .iter()
                .map(|(s, f)| (s.as_str(), *f))
                .collect();

            let cfg = PairFilterConfig {
                single_top_k: 32,
                per_role_top: 0,
                max_pairs: (branch_width * 4).max(branch_width),
            };
            let pairs = seed_pair_candidates(&scored_refs, &[], &[], None, &cfg);

            pairs
                .into_iter()
                .map(|p| {
                    let value = single_lookup.get(p.first.as_str()).copied().unwrap_or(0.0)
                        + single_lookup.get(p.second.as_str()).copied().unwrap_or(0.0);
                    (p.first, p.second, value)
                })
                .collect()
        }
    };

    if our_turn {
        scored_pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(Ordering::Equal));
    } else {
        scored_pairs.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(Ordering::Equal));
    }
    scored_pairs.truncate(branch_width);
    scored_pairs
}
