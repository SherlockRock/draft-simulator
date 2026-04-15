import type { ChampionMeta, Position } from "./types.js";

export function generatePairs(pool: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      pairs.push([pool[i], pool[j]]);
    }
  }
  return pairs;
}

function scorePair(
  a: string,
  b: string,
  existingPicks: string[],
  champions: Record<string, ChampionMeta>,
): number {
  const champA = champions[a];
  const champB = champions[b];
  if (!champA || !champB) return 0;

  let score = 0;

  const allPositions = new Set<Position>([...champA.positions, ...champB.positions]);
  score += allPositions.size * 0.3;

  const overlap = champA.positions.some((p) => champB.positions.includes(p));
  if (!overlap) score += 0.5;

  score += (champA.pickRate + champB.pickRate) * 2;

  const tagsA = new Set(champA.tags.synergy);
  for (const tag of champB.tags.synergy) {
    if (tagsA.has(tag)) score += 0.2;
  }

  return score;
}

export function filterPairs(
  pool: string[],
  existingPicks: string[],
  champions: Record<string, ChampionMeta>,
  maxPairs: number = 25,
): Array<[string, string]> {
  const allPairs = generatePairs(pool);
  const scored = allPairs.map((pair) => ({
    pair,
    score: scorePair(pair[0], pair[1], existingPicks, champions),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxPairs).map((s) => s.pair);
}
