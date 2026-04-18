import type {
  DraftState, TreeNode, ScoreSet, SearchContext, WeightedAssignment,
} from "./types.js";
import {
  getCurrentTurn, applyMove, applyPairMove, isPairTurn, remainingPool,
} from "./draft-state.js";
import { evaluate } from "./evaluator.js";
import type { EvalInput } from "./evaluator.js";
import { createAssignmentCache } from "./role-solver.js";
import { filterPairs } from "./pair-filter.js";

export interface SearchStats {
  nodesEvaluated: number;
}

interface SearchResult {
  score: number;
  node: TreeNode;
}

interface ChildResult {
  championIds: string[];
  result: SearchResult;
}

export function search(
  state: DraftState,
  pool: string[],
  ctx: SearchContext,
  stats: SearchStats = { nodesEvaluated: 0 },
): TreeNode {
  const assignmentCache = createAssignmentCache();
  const result = minimax(state, pool, ctx.config.maxDepth, -Infinity, Infinity, ctx, assignmentCache, stats);
  return result.node;
}

function minimax(
  state: DraftState,
  pool: string[],
  depth: number,
  alpha: number,
  beta: number,
  ctx: SearchContext,
  assignmentCache: ReturnType<typeof createAssignmentCache>,
  stats: SearchStats,
): SearchResult {
  const turn = getCurrentTurn(state);
  if (depth === 0 || !turn || turn.pairEnd) {
    stats.nodesEvaluated++;
    const scores = evaluateState(state, ctx, assignmentCache);
    return {
      score: scores.composite,
      node: makeLeafNode(scores, assignmentCache, state, ctx),
    };
  }

  const available = remainingPool(state, pool);
  if (available.length === 0) {
    stats.nodesEvaluated++;
    const scores = evaluateState(state, ctx, assignmentCache);
    return {
      score: scores.composite,
      node: makeLeafNode(scores, assignmentCache, state, ctx),
    };
  }

  const isUserTurn = turn.side === ctx.userSide;
  const children: ChildResult[] = [];

  if (isPairTurn(state)) {
    const existingPicks = turn.side === "blue" ? state.bluePicks : state.redPicks;
    const pairBranchWidth = ctx.config.pairBranchWidth ?? ctx.config.branchWidth;
    const pairs = filterPairs(available, existingPicks, ctx.champions, pairBranchWidth);

    if (isUserTurn) {
      let best = -Infinity;
      for (const [champA, champB] of pairs) {
        const nextState = applyPairMove(state, champA, champB);
        const nextPool = available.filter((c) => c !== champA && c !== champB);
        const result = minimax(nextState, nextPool, depth - 1, alpha, beta, ctx, assignmentCache, stats);
        children.push({ championIds: [champA, champB], result });
        best = Math.max(best, result.score);
        alpha = Math.max(alpha, best);
        if (alpha >= beta) break;
      }
      children.sort((a, b) => b.result.score - a.result.score);
    } else {
      let best = Infinity;
      for (const [champA, champB] of pairs) {
        const nextState = applyPairMove(state, champA, champB);
        const nextPool = available.filter((c) => c !== champA && c !== champB);
        const result = minimax(nextState, nextPool, depth - 1, alpha, beta, ctx, assignmentCache, stats);
        children.push({ championIds: [champA, champB], result });
        best = Math.min(best, result.score);
        beta = Math.min(beta, best);
        if (alpha >= beta) break;
      }
      children.sort((a, b) => a.result.score - b.result.score);
    }
  } else {
    const ordered = orderMoves(available, ctx);
    const candidates = ordered.slice(0, Math.min(ctx.config.branchWidth, ordered.length));

    if (isUserTurn) {
      let best = -Infinity;
      for (const champId of candidates) {
        const nextState = applyMove(state, champId);
        const nextPool = available.filter((c) => c !== champId);
        const result = minimax(nextState, nextPool, depth - 1, alpha, beta, ctx, assignmentCache, stats);
        children.push({ championIds: [champId], result });
        best = Math.max(best, result.score);
        alpha = Math.max(alpha, best);
        if (alpha >= beta) break;
      }
      children.sort((a, b) => b.result.score - a.result.score);
    } else {
      let best = Infinity;
      for (const champId of candidates) {
        const nextState = applyMove(state, champId);
        const nextPool = available.filter((c) => c !== champId);
        const result = minimax(nextState, nextPool, depth - 1, alpha, beta, ctx, assignmentCache, stats);
        children.push({ championIds: [champId], result });
        best = Math.min(best, result.score);
        beta = Math.min(beta, best);
        if (alpha >= beta) break;
      }
      children.sort((a, b) => a.result.score - b.result.score);
    }
  }

  if (children.length === 0) {
    stats.nodesEvaluated++;
    const scores = evaluateState(state, ctx, assignmentCache);
    return {
      score: scores.composite,
      node: makeLeafNode(scores, assignmentCache, state, ctx),
    };
  }

  const topChildren = children.slice(0, ctx.config.branchWidth);
  stats.nodesEvaluated++;
  const scores = evaluateState(state, ctx, assignmentCache);

  return {
    score: isUserTurn
      ? Math.max(...children.map((c) => c.result.score))
      : Math.min(...children.map((c) => c.result.score)),
    node: {
      championIds: [],
      scores,
      assignmentDistribution: getAssignments(state, ctx, assignmentCache),
      side: null,
      slots: [],
      actionType: turn.type,
      phase: turn.phase,
      userInjected: false,
      children: topChildren.map(({ championIds, result }) => ({
        ...result.node,
        championIds,
        side: turn.side,
        slots: championIds.length === 2 ? [state.turnIndex, state.turnIndex + 1] : [state.turnIndex],
        actionType: turn.type,
        phase: turn.phase,
        userInjected: false,
      })),
    },
  };
}

function evaluateState(
  state: DraftState,
  ctx: SearchContext,
  assignmentCache: ReturnType<typeof createAssignmentCache>,
): ScoreSet {
  const turn = getCurrentTurn(state);
  const phase = turn?.phase ?? "pick2";
  const input: EvalInput = {
    bluePicks: state.bluePicks,
    redPicks: state.redPicks,
    blueBans: state.blueBans,
    redBans: state.redBans,
    phase,
    userSide: ctx.userSide,
    remainingPool: [],
    champions: ctx.champions,
    metaData: ctx.metaData,
    playerModel: ctx.playerModel,
    assignmentCache,
  };
  return evaluate(input);
}

function getAssignments(
  state: DraftState,
  ctx: SearchContext,
  assignmentCache: ReturnType<typeof createAssignmentCache>,
): WeightedAssignment[] {
  const picks = ctx.userSide === "blue" ? state.bluePicks : state.redPicks;
  if (picks.length === 0) return [];
  return assignmentCache.solve(picks, ctx.champions);
}

function orderMoves(available: string[], ctx: SearchContext): string[] {
  return [...available].sort((a, b) => {
    const rateA = ctx.champions[a]?.pickRate ?? 0;
    const rateB = ctx.champions[b]?.pickRate ?? 0;
    return rateB - rateA;
  });
}

function makeLeafNode(
  scores: ScoreSet,
  assignmentCache: ReturnType<typeof createAssignmentCache>,
  state: DraftState,
  ctx: SearchContext,
): TreeNode {
  const turn = getCurrentTurn(state);
  return {
    championIds: [],
    scores,
    assignmentDistribution: getAssignments(state, ctx, assignmentCache),
    side: null,
    slots: [],
    actionType: turn?.type ?? "pick",
    phase: turn?.phase ?? "pick2",
    userInjected: false,
    children: [],
  };
}
