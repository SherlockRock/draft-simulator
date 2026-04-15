import type { ChampionMeta, Position, RoleAssignment, WeightedAssignment } from "./types.js";

const ALL_ROLES: Position[] = ["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"];
const OFF_ROLE_FIT = 0.3;
const MIN_WEIGHT_THRESHOLD = 0.01;

function roleFit(champion: ChampionMeta, role: Position): number {
  if (champion.positions.includes(role)) return 1.0;
  return OFF_ROLE_FIT;
}

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const result: number[][] = [];
  const perm = (current: number[], remaining: number[]) => {
    if (remaining.length === 0) {
      result.push(current);
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      perm(
        [...current, remaining[i]],
        [...remaining.slice(0, i), ...remaining.slice(i + 1)],
      );
    }
  };
  perm([], Array.from({ length: n }, (_, i) => i));
  return result;
}

function pickNFromRoles(n: number): number[][] {
  if (n >= 5) return [[0, 1, 2, 3, 4]];
  const result: number[][] = [];
  const combine = (start: number, current: number[]) => {
    if (current.length === n) {
      result.push([...current]);
      return;
    }
    for (let i = start; i < 5; i++) {
      current.push(i);
      combine(i + 1, current);
      current.pop();
    }
  };
  combine(0, []);
  return result;
}

export function solveAssignments(
  championIds: string[],
  champions: Record<string, ChampionMeta>,
): WeightedAssignment[] {
  if (championIds.length === 0) return [];

  const n = championIds.length;
  const champs = championIds.map((id) => champions[id]);
  const rolePermutations = pickNFromRoles(n);

  const results: WeightedAssignment[] = [];

  for (const roleIndices of rolePermutations) {
    const champPerms = permutations(n);
    for (const champPerm of champPerms) {
      let weight = 1.0;
      const assignment: RoleAssignment = {
        TOP: "", JUNGLE: "", MIDDLE: "", ADC: "", SUPPORT: "",
      };

      for (let i = 0; i < n; i++) {
        const champIdx = champPerm[i];
        const role = ALL_ROLES[roleIndices[i]];
        const fit = roleFit(champs[champIdx], role);
        weight *= fit;
        assignment[role] = championIds[champIdx];
      }

      if (weight >= MIN_WEIGHT_THRESHOLD) {
        results.push({ assignment, weight });
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = results.filter((r) => {
    const key = ALL_ROLES.map((role) => r.assignment[role]).join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => b.weight - a.weight);

  const totalWeight = deduped.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight > 0) {
    for (const r of deduped) {
      r.weight = r.weight / totalWeight;
    }
  }

  return deduped;
}

export function createAssignmentCache() {
  const cache = new Map<string, WeightedAssignment[]>();

  function solve(
    championIds: string[],
    champions: Record<string, ChampionMeta>,
  ): WeightedAssignment[] {
    const key = [...championIds].sort().join(",");
    const cached = cache.get(key);
    if (cached) return cached;
    const result = solveAssignments(championIds, champions);
    cache.set(key, result);
    return result;
  }

  return { solve };
}
