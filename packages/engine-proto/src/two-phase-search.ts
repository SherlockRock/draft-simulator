import type {
  DraftState,
  SearchContext,
  TreeNode,
  ComputeMeta,
  Scenario,
} from "./types.js";
import { search, type SearchStats } from "./search.js";
import { extractScenarios, collectLeaves, replayPath } from "./scenario.js";
import { TURN_SEQUENCE, remainingPool } from "./draft-state.js";

/** turnIndex after pick1 is complete (turns 0-11 are done, next is turn 12). */
export const END_OF_PICK1_TURN = 12;
/** turnIndex after the full draft is complete. */
export const END_OF_DRAFT_TURN = TURN_SEQUENCE.length;

export interface TwoPhaseResult {
  tree: TreeNode;
  scenarios: Scenario[];
  meta: ComputeMeta;
}

export function twoPhaseSearch(
  state: DraftState,
  pool: string[],
  ctx: SearchContext,
  maxScenarios = 5,
): TwoPhaseResult {
  const startTime = performance.now();
  const broadStats: SearchStats = { nodesEvaluated: 0 };

  const broadCtx: SearchContext = {
    ...ctx,
    config: { ...ctx.config, maxDepth: ctx.config.broadDepth },
  };
  const broadTree = search(state, pool, broadCtx, broadStats);

  const initialScenarios = extractScenarios(broadTree, ctx.champions, maxScenarios);

  const extensionStats: SearchStats = { nodesEvaluated: 0 };
  const targetTurn = getExtensionTarget(state, ctx.config.extensionTurnThreshold);

  for (const scenario of initialScenarios) {
    const leafState = replayPath(state, broadTree, scenario.treePath);
    if (leafState.turnIndex >= targetTurn) continue;

    const extensionMaxDepth = targetTurn - leafState.turnIndex;
    if (extensionMaxDepth <= 0) continue;

    const extensionPool = remainingPool(leafState, pool);
    const extensionCtx: SearchContext = {
      ...ctx,
      config: { ...ctx.config, maxDepth: extensionMaxDepth },
    };
    const extensionTree = search(leafState, extensionPool, extensionCtx, extensionStats);

    graftExtension(broadTree, scenario.treePath, extensionTree);
  }

  const finalScenarios = rederiveScenarios(broadTree, initialScenarios);

  const computeTimeMs = performance.now() - startTime;
  return {
    tree: broadTree,
    scenarios: finalScenarios,
    meta: {
      nodesEvaluated: broadStats.nodesEvaluated + extensionStats.nodesEvaluated,
      computeTimeMs,
      pruningRate: 0,
      depthReached: ctx.config.broadDepth,
      transpositionsFound: 0,
    },
  };
}

function getExtensionTarget(state: DraftState, threshold: number): number {
  if (state.turnIndex <= threshold) return END_OF_PICK1_TURN;
  return END_OF_DRAFT_TURN;
}

/**
 * Replace the leaf node's continuation with the extension's children/scores.
 * The extension's root represents the same state as the leaf at `path`, so we
 * preserve the leaf's identity (championIds, side, slots, actionType, phase)
 * and overwrite the continuation + evaluation.
 */
function graftExtension(tree: TreeNode, path: number[], extension: TreeNode): void {
  if (path.length === 0) {
    tree.children = extension.children;
    tree.scores = extension.scores;
    tree.assignmentDistribution = extension.assignmentDistribution;
    return;
  }

  let node = tree;
  for (let i = 0; i < path.length - 1; i++) {
    node = node.children[path[i]];
  }

  const leafIndex = path[path.length - 1];
  const leaf = node.children[leafIndex];
  leaf.children = extension.children;
  leaf.scores = extension.scores;
  leaf.assignmentDistribution = extension.assignmentDistribution;
}

/**
 * For each pre-extension scenario, find the highest-composite leaf in its
 * now-extended subtree and emit an updated Scenario with the deeper treePath
 * plus fully-accumulated bans/picks.
 */
function rederiveScenarios(tree: TreeNode, originalScenarios: Scenario[]): Scenario[] {
  const allLeaves = collectLeaves(tree);
  return originalScenarios.map((scenario) => {
    const candidates = allLeaves.filter((leaf) => pathStartsWith(leaf.path, scenario.treePath));
    if (candidates.length === 0) return scenario;

    candidates.sort((a, b) => b.node.scores.composite - a.node.scores.composite);
    const best = candidates[0];

    return {
      ...scenario,
      scores: {
        composite: best.node.scores.composite,
        compStrength: best.node.scores.compStrength,
        informationValue: best.node.scores.informationValue,
      },
      bluePicks: best.bluePicks,
      redPicks: best.redPicks,
      blueBans: best.blueBans,
      redBans: best.redBans,
      likelyAssignments: best.node.assignmentDistribution,
      treePath: best.path,
      description: `${best.bluePicks.join(", ")} vs ${best.redPicks.join(", ")}`,
    };
  });
}

function pathStartsWith(path: number[], prefix: number[]): boolean {
  if (path.length < prefix.length) return false;

  for (let i = 0; i < prefix.length; i++) {
    if (path[i] !== prefix[i]) return false;
  }

  return true;
}
