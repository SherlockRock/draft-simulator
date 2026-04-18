import { applyMove, applyPairMove } from "./draft-state.js";
import type { TreeNode, Scenario, ChampionMeta, Perspective, DraftState } from "./types.js";

interface LeafInfo {
  node: TreeNode;
  path: number[];
  bluePicks: string[];
  redPicks: string[];
  blueBans: string[];
  redBans: string[];
}

export function collectLeaves(tree: TreeNode): LeafInfo[] {
  const leaves: LeafInfo[] = [];

  function walk(
    node: TreeNode,
    path: number[],
    bluePicks: string[],
    redPicks: string[],
    blueBans: string[],
    redBans: string[],
  ): void {
    const bp =
      node.side === "blue" && node.actionType === "pick"
        ? [...bluePicks, ...node.championIds]
        : bluePicks;
    const rp =
      node.side === "red" && node.actionType === "pick"
        ? [...redPicks, ...node.championIds]
        : redPicks;
    const bb =
      node.side === "blue" && node.actionType === "ban"
        ? [...blueBans, ...node.championIds]
        : blueBans;
    const rb =
      node.side === "red" && node.actionType === "ban"
        ? [...redBans, ...node.championIds]
        : redBans;

    if (node.children.length === 0) {
      leaves.push({ node, path, bluePicks: bp, redPicks: rp, blueBans: bb, redBans: rb });
      return;
    }
    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i], [...path, i], bp, rp, bb, rb);
    }
  }

  walk(tree, [], [], [], [], []);
  return leaves;
}

export function computeFeatureVector(
  picks: string[],
  champions: Record<string, ChampionMeta>,
): number[] {
  if (picks.length === 0) return [0, 0, 0, 0, 0, 0, 0];

  let physical = 0, magic = 0, early = 0, mid = 0, late = 0, engage = 0, peel = 0;
  let count = 0;

  for (const id of picks) {
    const c = champions[id];
    if (!c) continue;
    physical += c.damageProfile.physical;
    magic += c.damageProfile.magic;
    early += c.scalingProfile.early;
    mid += c.scalingProfile.mid;
    late += c.scalingProfile.late;
    engage += c.ccProfile.engageQuality;
    peel += c.ccProfile.peelQuality;
    count++;
  }

  if (count === 0) return [0, 0, 0, 0, 0, 0, 0];
  return [physical / count, magic / count, early / count, mid / count, late / count, engage / count, peel / count];
}

function vectorDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

export function labelScenario(
  picks: string[],
  champions: Record<string, ChampionMeta>,
): string {
  const vec = computeFeatureVector(picks, champions);
  const traits: string[] = [];

  if (vec[0] > 0.6) traits.push("Physical Heavy");
  else if (vec[1] > 0.6) traits.push("Magic Heavy");
  else traits.push("Mixed Damage");

  if (vec[2] > 0.6) traits.push("Early Game");
  else if (vec[4] > 0.6) traits.push("Late Scaling");
  else traits.push("Mid Game");

  if (vec[5] > 0.4) traits.push("Hard Engage");
  else if (vec[6] > 0.4) traits.push("Peel Focused");

  return traits.slice(0, 2).join(" / ");
}

export function extractScenarios(
  tree: TreeNode,
  champions: Record<string, ChampionMeta>,
  maxScenarios: number = 5,
): Scenario[] {
  const leaves = collectLeaves(tree);
  if (leaves.length === 0) return [];

  const featured = leaves.map((leaf) => ({
    ...leaf,
    vector: computeFeatureVector(leaf.bluePicks, champions),
  }));

  featured.sort((a, b) => b.node.scores.composite - a.node.scores.composite);

  const selected: typeof featured = [featured[0]];
  const remaining = featured.slice(1);

  while (selected.length < maxScenarios && remaining.length > 0) {
    let farthestIdx = 0;
    let farthestDist = -1;

    for (let i = 0; i < remaining.length; i++) {
      let minDist = Infinity;
      for (const s of selected) {
        const d = vectorDistance(remaining[i].vector, s.vector);
        minDist = Math.min(minDist, d);
      }
      if (minDist > farthestDist) {
        farthestDist = minDist;
        farthestIdx = i;
      }
    }

    selected.push(remaining[farthestIdx]);
    remaining.splice(farthestIdx, 1);
  }

  return selected.map((leaf, i): Scenario => {
    const perspective: Perspective = i === 0 ? "robust" : "likely";
    return {
      name: labelScenario(leaf.bluePicks, champions),
      scores: {
        composite: leaf.node.scores.composite,
        compStrength: leaf.node.scores.compStrength,
        informationValue: leaf.node.scores.informationValue,
      },
      description: `${leaf.bluePicks.join(", ")} vs ${leaf.redPicks.join(", ")}`,
      bluePicks: leaf.bluePicks,
      likelyAssignments: leaf.node.assignmentDistribution,
      redPicks: leaf.redPicks,
      blueBans: leaf.blueBans,
      redBans: leaf.redBans,
      treePath: leaf.path,
      perspective,
      indicators: [],
    };
  });
}

export function replayPath(
  initialState: DraftState,
  tree: TreeNode,
  path: number[],
): DraftState {
  let state = initialState;
  let node = tree;
  for (const childIndex of path) {
    const child = node.children[childIndex];
    if (!child) {
      throw new Error(`replayPath: no child at index ${childIndex}`);
    }
    if (child.championIds.length === 2) {
      const [a, b] = child.championIds;
      state = applyPairMove(state, a, b);
    } else if (child.championIds.length === 1) {
      state = applyMove(state, child.championIds[0]);
    } else if (child.championIds.length === 0) {
      // Placeholder / leaf - no state advance
    } else {
      throw new Error(`replayPath: unexpected championIds length ${child.championIds.length}`);
    }
    node = child;
  }
  return state;
}
