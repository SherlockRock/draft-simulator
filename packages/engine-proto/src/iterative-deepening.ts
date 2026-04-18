import type { DraftState, SearchContext, TreeNode, ComputeMeta } from "./types.js";
import { search } from "./search.js";
import type { SearchStats } from "./search.js";

interface IDResult {
  tree: TreeNode;
  meta: ComputeMeta;
}

export function iterativeDeepeningSearch(
  state: DraftState,
  pool: string[],
  ctx: SearchContext,
): IDResult {
  const startTime = performance.now();
  let bestTree: TreeNode | null = null;
  let depthReached = 0;
  let totalNodes = 0;

  for (let depth = 1; depth <= ctx.config.maxDepth; depth++) {
    const elapsed = performance.now() - startTime;
    if (elapsed >= ctx.config.latencyBudgetMs) break;

    const stats: SearchStats = { nodesEvaluated: 0 };
    const depthCtx: SearchContext = {
      ...ctx,
      config: { ...ctx.config, maxDepth: depth },
    };
    const tree = search(state, pool, depthCtx, stats);
    bestTree = tree;
    depthReached = depth;
    totalNodes += stats.nodesEvaluated;
  }

  const computeTimeMs = performance.now() - startTime;

  return {
    tree: bestTree ?? {
      championIds: [],
      scores: { composite: 0, compStrength: 0, informationValue: 0, flexRetention: 0, revealCost: 0 },
      assignmentDistribution: [],
      side: null,
      slots: [],
      actionType: "pick",
      phase: "pick1",
      userInjected: false,
      children: [],
    },
    meta: {
      nodesEvaluated: totalNodes,
      computeTimeMs,
      pruningRate: 0,
      depthReached,
      transpositionsFound: 0,
    },
  };
}
