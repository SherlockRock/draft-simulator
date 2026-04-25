use crate::cancellation::{ensure_not_cancelled, CancelError, CancelHandle};
use crate::draft_state::{ActionType, DraftState, Phase, Side, TurnInfo, TURN_SEQUENCE};
use crate::evaluator::{score_pick, EvalContext, ScoreSet};
use crate::pair_filter::{seed_pair_candidates, PairFilterConfig};
use crate::pools::{Role, TeamPool};
use crate::role_solver::ChampionMeta;
use crate::transposition::TranspositionCache;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::collections::HashSet;

#[derive(Clone, Debug)]
pub struct SearchParams {
    pub branch_width: usize,
    pub max_depth: usize,
}

impl Default for SearchParams {
    fn default() -> Self {
        Self {
            branch_width: 5,
            max_depth: 6,
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

pub fn search(
    state: &DraftState,
    params: &SearchParams,
    eval_ctx: &EvalContext,
    cancel: &CancelHandle,
) -> Result<TreeNode, CancelError> {
    let mut cache = TranspositionCache::new();
    search_recursive(
        state,
        params,
        params.max_depth,
        eval_ctx,
        cancel,
        &mut cache,
        f64::NEG_INFINITY,
        f64::INFINITY,
    )
}

fn search_recursive(
    state: &DraftState,
    params: &SearchParams,
    remaining_depth: usize,
    eval_ctx: &EvalContext,
    cancel: &CancelHandle,
    cache: &mut TranspositionCache,
    mut alpha: f64,
    mut beta: f64,
) -> Result<TreeNode, CancelError> {
    ensure_not_cancelled(cancel)?;

    let turn_opt = state.current_turn();

    // Terminal or depth-bound: produce a leaf node carrying a static evaluation.
    if turn_opt.is_none() || remaining_depth == 0 {
        let value = eval_state(state, eval_ctx);
        return Ok(TreeNode {
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
        });
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
            alpha,
            beta,
            turn,
        );
    }

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

    let mut children: Vec<TreeNode> = Vec::with_capacity(ranked.len());
    let mut best_value = if our_turn {
        f64::NEG_INFINITY
    } else {
        f64::INFINITY
    };

    for (champ, _static_score) in &ranked {
        ensure_not_cancelled(cancel)?;

        let mut child_state = state.clone();
        push_action(&mut child_state, turn, champ);

        let child_tree = search_recursive(
            &child_state,
            params,
            remaining_depth - 1,
            eval_ctx,
            cancel,
            cache,
            alpha,
            beta,
        )?;
        let child_value = child_tree.scores.composite;

        let branch_node = TreeNode {
            champion_ids: vec![champ.clone()],
            scores: ScoreSet {
                composite: child_value,
                ..Default::default()
            },
            side: Some(turn.side),
            slots: vec![state.turn_index()],
            action_type: turn.action_type,
            phase: turn.phase,
            user_injected: false,
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
        if alpha >= beta {
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

    Ok(TreeNode {
        champion_ids: vec![],
        scores: ScoreSet {
            composite: best_value,
            ..Default::default()
        },
        side: Some(turn.side),
        slots: vec![state.turn_index()],
        action_type: turn.action_type,
        phase: turn.phase,
        user_injected: false,
        children,
    })
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
    cache: &mut TranspositionCache,
    mut alpha: f64,
    mut beta: f64,
    turn: TurnInfo,
) -> Result<TreeNode, CancelError> {
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
        .iter()
        .map(|c| {
            let role = primary_role(c, &eval_ctx.champion_meta).unwrap_or(Role::Top);
            let s = score_pick(c, role, state, &sub_ctx);
            (c.clone(), s.composite)
        })
        .collect();

    // pair_filter wants singles sorted DESC by score.
    let mut singles_desc = scored_singles.clone();
    singles_desc.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    let scored_refs: Vec<(&str, f64)> =
        singles_desc.iter().map(|(s, f)| (s.as_str(), *f)).collect();

    let cfg = PairFilterConfig {
        single_top_k: 32,
        per_role_top: 0,
        max_pairs: (params.branch_width * 4).max(params.branch_width),
    };
    let pairs = seed_pair_candidates(&scored_refs, &[], &[], None, &cfg);

    // Score each pair = sum of its two singles' composites.
    let mut single_lookup: HashMap<&str, f64> = HashMap::with_capacity(scored_refs.len());
    for (id, score) in &scored_refs {
        single_lookup.insert(*id, *score);
    }
    let mut scored_pairs: Vec<(String, String, f64)> = pairs
        .into_iter()
        .map(|p| {
            let value = single_lookup.get(p.first.as_str()).copied().unwrap_or(0.0)
                + single_lookup.get(p.second.as_str()).copied().unwrap_or(0.0);
            (p.first, p.second, value)
        })
        .collect();

    // Move ordering: best-for-mover first.
    if our_turn {
        scored_pairs.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(Ordering::Equal));
    } else {
        scored_pairs.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(Ordering::Equal));
    }
    scored_pairs.truncate(params.branch_width);

    let mut children: Vec<TreeNode> = Vec::with_capacity(scored_pairs.len());
    let mut best_value = if our_turn {
        f64::NEG_INFINITY
    } else {
        f64::INFINITY
    };

    for (first, second, _static) in &scored_pairs {
        ensure_not_cancelled(cancel)?;

        let mut child_state = state.clone();
        push_action(&mut child_state, turn, first);
        push_action(&mut child_state, pair_end_turn, second);

        let child_tree = search_recursive(
            &child_state,
            params,
            remaining_depth - 1,
            eval_ctx,
            cancel,
            cache,
            alpha,
            beta,
        )?;
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
            user_injected: false,
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
        if alpha >= beta {
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

    Ok(TreeNode {
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
    })
}
