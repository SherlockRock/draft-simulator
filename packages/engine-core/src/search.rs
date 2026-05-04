use crate::cancellation::{ensure_not_cancelled, CancelHandle};
use crate::coverage::{coverage_score, missing_roles};
use crate::draft_state::{is_taken, picks_remaining, ActionType, DraftState, Phase, Side, TurnInfo, TURN_SEQUENCE};
use crate::engine::EngineError;
use crate::feasibility::can_complete_roles;
use crate::evaluator::{phase_weight_for, score_pick, EvalContext, ScoreSet, SideValues};
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
    /// Pair-pick search budget. Pair turns (Pick1 R1/B2/B3, Pick2 B4/B5)
    /// expand candidate pairs separately from single picks; this is the
    /// final-truncate budget after the value-sort, and is also used to size
    /// the pair-seed `max_pairs` cap. Wired from `pairBranchWidth` on the
    /// wire format. Decoupled from `branch_width` because pair search has
    /// quadratic candidate space and benefits from more headroom (e.g.
    /// `branch_width: 5, pair_branch_width: 500` in production).
    pub pair_branch_width: usize,
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
            pair_branch_width: 500,
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
        let value: SideValues = eval_state(state, eval_ctx);
        let leaf = TreeNode {
            champion_ids: vec![],
            scores: ScoreSet {
                composite: value.for_side(eval_ctx.side),
                composite_per_side: value,
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
    let mut ranked = score_and_rank(
        &candidates,
        state,
        turn,
        eval_ctx,
        cancel,
        our_turn,
        params.branch_width,
    )?;

    // Pick2 single-pick bucket-2 protection. Mirrors expand_pair's bucket-2
    // logic. The branch_width truncation in score_and_rank uses static
    // composite, which can crowd out low-WR specialists at missing roles when
    // high-WR non-fills dominate. With N missing roles, append top-K
    // specialists per missing role to the explored set (deduped against the
    // existing top branch_width). The resulting candidate list can exceed
    // branch_width — that's intentional, matching pair-pick bucket-2 protection.
    if turn.phase == Phase::Pick2 && turn.action_type == ActionType::Pick {
        let our_picks_now: &[String] = if turn.side == Side::Blue {
            &state.blue_picks
        } else {
            &state.red_picks
        };
        let missing = missing_roles(our_picks_now, &eval_ctx.champion_meta, 0.9);
        if !missing.is_empty() {
            const PROTECTED_K: usize = 4;
            let mut already: HashSet<String> =
                ranked.iter().map(|(c, _)| c.clone()).collect();
            let sub_ctx = eval_ctx.for_perspective(turn.side, state, turn.phase);
            for role in &missing {
                let specialists =
                    top_k_for_role(*role, state, turn, eval_ctx, cancel, PROTECTED_K)?;
                for champ in specialists {
                    if already.insert(champ.clone()) {
                        let pri =
                            primary_role(&champ, &eval_ctx.champion_meta).unwrap_or(*role);
                        let s = score_pick(&champ, pri, state, &sub_ctx, turn.action_type);
                        ranked.push((champ, s.composite));
                    }
                }
            }
            // Always descending: turn.side's specialists sorted best-for-mover first.
            ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        }
    }

    // Feasibility prune: drop candidates whose hypothetical post-action state
    // leaves the picking side (or either side for bans) unable to complete a
    // 5-role comp from their remaining pool.
    accum.nodes_pruned += feasibility_filter_singles(&mut ranked, state, turn, eval_ctx);

    // Apply forced branches at this single-slot expansion.
    let current_slot = state.turn_index();
    let (forced_set, injected_ids) =
        apply_single_slot_forces(&params.forced_branches, current_slot, lineage, accum, &ranked);

    let mut children: Vec<TreeNode> = Vec::with_capacity(forced_set.len());
    let mut best_value_pair = SideValues { blue: f64::NEG_INFINITY, red: f64::NEG_INFINITY };

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
        let child_pair: SideValues = child_tree.scores.composite_per_side;

        let branch_node = TreeNode {
            champion_ids: vec![champ.clone()],
            scores: ScoreSet {
                composite: child_pair.for_side(eval_ctx.side),
                composite_per_side: child_pair,
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

        // Self-optimization: turn.side picks the child maximizing its own composite.
        // Both sides always maximize their own value — no minimax inversion.
        let turn_side_value = child_pair.for_side(turn.side);
        let best_turn_side_value = best_value_pair.for_side(turn.side);
        if turn_side_value > best_turn_side_value {
            best_value_pair = child_pair;
        }
        let best_value = best_value_pair.for_side(eval_ctx.side);
        if our_turn {
            if best_value > alpha {
                alpha = best_value;
            }
        } else {
            // Approximate: beta tracks opp's best so far as a pruning hint.
            let opp_best = best_value_pair.for_side(turn.side);
            if opp_best > beta {
                beta = opp_best;
            }
        }
        // Under self-optimization (Phase 2), alpha-beta pruning is no longer
        // strictly sound — it assumes minimax. Keep as approximate heuristic;
        // benchmark in Task 2.5 quantifies its contribution.
        if !params.disable_alpha_beta && alpha >= beta {
            accum.nodes_pruned += forced_set.len().saturating_sub(idx + 1);
            break;
        }
    }

    if children.is_empty() {
        // No legal candidates (e.g., depleted pool). Treat as terminal.
        best_value_pair = eval_state(state, eval_ctx);
    }

    // Sort children by composite descending so tree-builders/UI see best-first.
    children.sort_by(|a, b| {
        b.scores
            .composite
            .partial_cmp(&a.scores.composite)
            .unwrap_or(Ordering::Equal)
    });

    // best_value is derivative: the request-side's slice of best_value_pair.
    let best_value = best_value_pair.for_side(eval_ctx.side);
    let result = TreeNode {
        champion_ids: vec![],
        scores: ScoreSet {
            composite: best_value,
            composite_per_side: best_value_pair,
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

/// Drops candidates whose hypothetical post-action state leaves the picking
/// side (or either side for bans) unable to complete a 5-role comp from the
/// remaining pool. Returns the number of candidates pruned.
fn feasibility_filter_singles(
    ranked: &mut Vec<(String, f64)>,
    state: &DraftState,
    turn: TurnInfo,
    eval_ctx: &EvalContext,
) -> usize {
    let original_count = ranked.len();

    // Build per-side pools once (filtered against already-taken champions),
    // so the retain closure does not rebuild them per candidate.
    let blue_pool_full: Vec<String> = pool_for(Side::Blue, eval_ctx)
        .search
        .iter()
        .filter(|c| !is_taken(c, state))
        .cloned()
        .collect();
    let red_pool_full: Vec<String> = pool_for(Side::Red, eval_ctx)
        .search
        .iter()
        .filter(|c| !is_taken(c, state))
        .cloned()
        .collect();

    ranked.retain(|(cand, _score)| {
        let cand_str = cand.as_str();
        match turn.action_type {
            ActionType::Pick => {
                let side_pool_full = match turn.side {
                    Side::Blue => &blue_pool_full,
                    Side::Red => &red_pool_full,
                };
                let cand_pool_for_side: Vec<String> = side_pool_full
                    .iter()
                    .filter(|c| c.as_str() != cand_str)
                    .cloned()
                    .collect();
                let mut hypothetical_locked = match turn.side {
                    Side::Blue => state.blue_picks.clone(),
                    Side::Red => state.red_picks.clone(),
                };
                hypothetical_locked.push(cand.clone());
                let remaining = picks_remaining(state, turn.side).saturating_sub(1);
                can_complete_roles(
                    &hypothetical_locked,
                    &cand_pool_for_side,
                    remaining,
                    &eval_ctx.champion_meta,
                )
            }
            ActionType::Ban => {
                let blue_pool_minus: Vec<String> = blue_pool_full
                    .iter()
                    .filter(|c| c.as_str() != cand_str)
                    .cloned()
                    .collect();
                let red_pool_minus: Vec<String> = red_pool_full
                    .iter()
                    .filter(|c| c.as_str() != cand_str)
                    .cloned()
                    .collect();
                let blue_remaining = picks_remaining(state, Side::Blue);
                let red_remaining = picks_remaining(state, Side::Red);
                can_complete_roles(
                    &state.blue_picks,
                    &blue_pool_minus,
                    blue_remaining,
                    &eval_ctx.champion_meta,
                ) && can_complete_roles(
                    &state.red_picks,
                    &red_pool_minus,
                    red_remaining,
                    &eval_ctx.champion_meta,
                )
            }
        }
    });

    original_count - ranked.len()
}

/// Drops pair candidates whose hypothetical post-pick state leaves the
/// picking side unable to complete a 5-role comp from the remaining pool.
/// Returns the number of pairs pruned. Pair turns are always Pick (no Ban
/// pair turns exist in TURN_SEQUENCE), so we only check the picking side.
fn feasibility_filter_pairs(
    scored_pairs: &mut Vec<(String, String, f64)>,
    state: &DraftState,
    turn: TurnInfo,
    eval_ctx: &EvalContext,
) -> usize {
    let original_count = scored_pairs.len();

    let side_pool_full: Vec<String> = pool_for(turn.side, eval_ctx)
        .search
        .iter()
        .filter(|c| !is_taken(c, state))
        .cloned()
        .collect();

    scored_pairs.retain(|(first, second, _value)| {
        let first_str = first.as_str();
        let second_str = second.as_str();
        let cand_pool: Vec<String> = side_pool_full
            .iter()
            .filter(|c| c.as_str() != first_str && c.as_str() != second_str)
            .cloned()
            .collect();
        let mut hypothetical_locked = match turn.side {
            Side::Blue => state.blue_picks.clone(),
            Side::Red => state.red_picks.clone(),
        };
        hypothetical_locked.push(first.clone());
        hypothetical_locked.push(second.clone());
        let remaining = picks_remaining(state, turn.side).saturating_sub(2);
        can_complete_roles(
            &hypothetical_locked,
            &cand_pool,
            remaining,
            &eval_ctx.champion_meta,
        )
    });

    original_count - scored_pairs.len()
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

/// Static evaluation of a draft state from both sides' perspectives. Returns
/// a `SideValues` containing each side's composite score independently, using
/// per-side phase and pool context so neither perspective is conflated.
///
/// The per-pick `role_coverage` component returned by `score_pick` is 0 here
/// by construction: `coverage_marginal_gain` is called with `picks` already
/// containing `candidate`, so the per-role max is unchanged and the
/// "marginal" gain is zero. Coverage is properly a whole-comp property at
/// terminal/leaf states, so we add `weights.coverage * coverage_score(picks)`
/// once here. Without this, the back-propagated minimax value is coverage-
/// blind and prefers raw-win-rate-greedy comps over role-balanced ones.
fn eval_state(state: &DraftState, ctx: &EvalContext) -> SideValues {
    let blue_phase = phase_for_state(state, Side::Blue);
    let red_phase = phase_for_state(state, Side::Red);

    let blue_ctx = ctx.for_perspective(Side::Blue, state, blue_phase);
    let red_ctx = ctx.for_perspective(Side::Red, state, red_phase);

    SideValues {
        blue: side_total(state, &state.blue_picks, &blue_ctx),
        red: side_total(state, &state.red_picks, &red_ctx),
    }
}

/// Mirror engine.rs:128 — derive phase from state.current_turn().
/// Falls back to Pick2 only at terminal (no current turn). The `_side`
/// parameter is kept for API symmetry; future side-asymmetric phase
/// handling could use it.
fn phase_for_state(state: &DraftState, _side: Side) -> Phase {
    state.current_turn().map(|t| t.phase).unwrap_or(Phase::Pick2)
}

fn side_total(state: &DraftState, our_picks: &[String], ctx: &EvalContext) -> f64 {
    let mut total = 0.0;
    for champ in our_picks {
        let role = primary_role(champ, &ctx.champion_meta).unwrap_or(Role::Top);
        let s = score_pick(champ, role, state, ctx, ActionType::Pick);
        total += s.composite;
    }
    let weights = phase_weight_for(
        ctx.side,
        ctx.phase,
        &ctx.phase_weights_blue,
        &ctx.phase_weights_red,
    );
    let coverage = coverage_score(our_picks, &ctx.champion_meta);
    total += weights.coverage * coverage;
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
    cancel: &CancelHandle,
    _our_turn: bool,
    branch_width: usize,
) -> Result<Vec<(String, f64)>, EngineError> {
    // Full perspective swap so scoring uses turn.side's pools, picks, and phase —
    // not just the side/phase fields. Correct for self-opt move ordering.
    let sub_ctx = ctx.for_perspective(turn.side, state, turn.phase);

    let mut scored: Vec<(String, f64)> = candidates
        .par_iter()
        .filter_map(|c| {
            if cancel.is_cancelled() {
                None
            } else {
                let role = primary_role(c, &ctx.champion_meta).unwrap_or(Role::Top);
                let s = score_pick(c, role, state, &sub_ctx, turn.action_type);
                Some((c.clone(), s.composite))
            }
        })
        .collect();
    ensure_not_cancelled(cancel)?;

    // Move ordering: always descending (best-for-turn.side first).
    // Under self-opt every mover prefers its own max, so always sort DESC.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    scored.truncate(branch_width);
    Ok(scored)
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
    // Full perspective swap so turn.side's pools and picks are used — consistent with
    // score_and_rank's for_perspective call and the self-opt model.
    let sub_ctx = eval_ctx.for_perspective(turn.side, state, turn.phase);
    let scored_singles: Vec<(String, f64)> = candidates
        .par_iter()
        .filter_map(|c| {
            if cancel.is_cancelled() {
                None
            } else {
                let role = primary_role(c, &eval_ctx.champion_meta).unwrap_or(Role::Top);
                let s = score_pick(c, role, state, &sub_ctx, turn.action_type);
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

    // Pick2-only: identify roles where current picks have NO primary coverage
    // (threshold < 0.9). For each unordered pair of missing roles, populate a
    // per-role top-K bucket. With N missing, this produces C(N,2) bucket-2
    // groups so every role-completing pair shape is seeded. With < 2 missing
    // or non-Pick2 phase, bucket 2 is disabled (empty Vec).
    let our_picks_now: &[String] = if turn.side == Side::Blue {
        &state.blue_picks
    } else {
        &state.red_picks
    };
    let role_top_lists: Vec<Vec<String>> = if turn.phase == Phase::Pick2 {
        let missing = missing_roles(our_picks_now, &eval_ctx.champion_meta, 0.9);
        if missing.len() >= 2 {
            let mut lists = Vec::with_capacity(missing.len());
            for role in &missing {
                lists.push(top_k_for_role(*role, state, turn, eval_ctx, cancel, 8)?);
            }
            lists
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    // Enumerate all unordered pairs of role-buckets. Caller dedup happens in
    // `seed_pair_candidates` via the `protected: HashSet`.
    let role_bucket_pairs: Vec<(&[String], &[String])> = {
        let mut buckets = Vec::new();
        for i in 0..role_top_lists.len() {
            for j in (i + 1)..role_top_lists.len() {
                buckets.push((role_top_lists[i].as_slice(), role_top_lists[j].as_slice()));
            }
        }
        buckets
    };

    let mut scored_pairs = build_pair_candidates(
        &scored_singles,
        &pair_force,
        params.pair_branch_width,
        our_turn,
        &role_bucket_pairs,
    );
    accum.nodes_pruned += feasibility_filter_pairs(&mut scored_pairs, state, turn, eval_ctx);

    let mut children: Vec<TreeNode> = Vec::with_capacity(scored_pairs.len());
    let mut best_value_pair = SideValues { blue: f64::NEG_INFINITY, red: f64::NEG_INFINITY };

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
        let child_pair: SideValues = child_tree.scores.composite_per_side;

        children.push(TreeNode {
            champion_ids: vec![first.clone(), second.clone()],
            scores: ScoreSet {
                composite: child_pair.for_side(eval_ctx.side),
                composite_per_side: child_pair,
                ..Default::default()
            },
            side: Some(turn.side),
            slots: vec![pair_start_slot, pair_end_slot],
            action_type: turn.action_type,
            phase: turn.phase,
            user_injected: injected,
            children: child_tree.children,
        });

        // Self-optimization: turn.side picks the pair maximizing its own composite.
        let turn_side_value = child_pair.for_side(turn.side);
        let best_turn_side_value = best_value_pair.for_side(turn.side);
        if turn_side_value > best_turn_side_value {
            best_value_pair = child_pair;
        }
        let best_value = best_value_pair.for_side(eval_ctx.side);
        if our_turn {
            if best_value > alpha {
                alpha = best_value;
            }
        } else {
            // Approximate: beta tracks opp's best so far as a pruning hint.
            let opp_best = best_value_pair.for_side(turn.side);
            if opp_best > beta {
                beta = opp_best;
            }
        }
        // Under self-optimization (Phase 2), alpha-beta pruning is no longer
        // strictly sound — it assumes minimax. Keep as approximate heuristic;
        // benchmark in Task 2.5 quantifies its contribution.
        if !params.disable_alpha_beta && alpha >= beta {
            accum.nodes_pruned += scored_pairs.len().saturating_sub(idx + 1);
            break;
        }
    }

    if children.is_empty() {
        best_value_pair = eval_state(state, eval_ctx);
    }
    children.sort_by(|a, b| {
        b.scores
            .composite
            .partial_cmp(&a.scores.composite)
            .unwrap_or(Ordering::Equal)
    });

    // best_value is derivative: the request-side's slice of best_value_pair.
    let best_value = best_value_pair.for_side(eval_ctx.side);
    let result = TreeNode {
        champion_ids: vec![],
        scores: ScoreSet {
            composite: best_value,
            composite_per_side: best_value_pair,
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
    pair_branch_width: usize,
    _our_turn: bool,
    role_bucket_pairs: &[(&[String], &[String])],
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

            let role_buckets_refs: Vec<(Vec<&str>, Vec<&str>)> = role_bucket_pairs
                .iter()
                .map(|(a, b)| (
                    a.iter().map(String::as_str).collect(),
                    b.iter().map(String::as_str).collect(),
                ))
                .collect();
            let per_role_top = if role_buckets_refs.is_empty() { 0 } else { 8 };

            let cfg = PairFilterConfig {
                single_top_k: 32,
                per_role_top,
                // Oversample bucket-1 by 4x the keep size, so the value-sort
                // has surplus to choose from. Bucket-2/3 are protected by
                // `seed_pair_candidates` regardless of this cap.
                max_pairs: (pair_branch_width * 4).max(pair_branch_width),
            };
            let pairs = seed_pair_candidates(&scored_refs, &role_buckets_refs, None, &cfg);

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

    // Always descending: best-for-turn.side pairs first (self-opt move ordering).
    scored_pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(Ordering::Equal));
    scored_pairs.truncate(pair_branch_width);
    scored_pairs
}

/// Score every candidate from `pool.display.for_role(role)` (filtered against
/// used set) at the given role, return top `k` champion IDs by composite. Used
/// by `expand_pair` at Pick2 to populate the per-role bucket of
/// `seed_pair_candidates`.
fn top_k_for_role(
    role: Role,
    state: &DraftState,
    turn: TurnInfo,
    ctx: &EvalContext,
    cancel: &CancelHandle,
    k: usize,
) -> Result<Vec<String>, EngineError> {
    let pool = pool_for(turn.side, ctx);
    let role_pool = pool.display.for_role(role);
    let used: HashSet<&str> = state
        .blue_bans
        .iter()
        .map(String::as_str)
        .chain(state.red_bans.iter().map(String::as_str))
        .chain(state.blue_picks.iter().map(String::as_str))
        .chain(state.red_picks.iter().map(String::as_str))
        .collect();

    let sub_ctx = ctx.for_perspective(turn.side, state, turn.phase);

    let mut scored: Vec<(String, f64)> = role_pool
        .par_iter()
        .filter_map(|c| {
            if used.contains(c.as_str()) || cancel.is_cancelled() {
                None
            } else {
                let s = score_pick(c, role, state, &sub_ctx, turn.action_type);
                Some((c.clone(), s.composite))
            }
        })
        .collect();
    ensure_not_cancelled(cancel)?;

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    scored.truncate(k);
    Ok(scored.into_iter().map(|(c, _)| c).collect())
}
