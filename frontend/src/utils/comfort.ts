// frontend/src/utils/comfort.ts
//
// Shared, pure comfort score (design §4). Read-time tunable: recency is derived
// from lastPlayed at call time, never stored baked, so retuning weights/recency
// stays a pure recompute.

export interface ComfortWeights {
  games: number; // 0–100
  winRate: number; // 0–100
  recency: number; // 0–100
}

export interface ChampStat {
  championId: string;
  role: string;
  games: number;
  wins: number;
  lastPlayed: string | null; // ISO string; powers the recency factor
  recentWindowGames: number | null; // captured for future use; NOT used by v1 recency
}

export interface ComfortFactors {
  gamesFactor: number;
  winRateFactor: number;
  recencyFactor: number;
}

export interface ScoredChamp extends ChampStat {
  comfort: number;
}

export const DEFAULT_COMFORT_WEIGHTS: ComfortWeights = {
  games: 50,
  winRate: 30,
  recency: 20,
};

// Bayesian prior strength, chosen now in the 4–6 band (design §4) so a 1-game
// 100% champ cannot dominate.
const WINRATE_PRIOR_K = 5;
const RECENCY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export function comfortFactors(
  stat: ChampStat,
  maxGamesInPool: number,
  now: Date
): ComfortFactors {
  const gamesFactor =
    maxGamesInPool <= 0
      ? 0
      : Math.log(1 + stat.games) / Math.log(1 + maxGamesInPool);

  const winRateFactor =
    (stat.wins + WINRATE_PRIOR_K * 0.5) / (stat.games + WINRATE_PRIOR_K);

  let recencyFactor = 0;
  if (stat.lastPlayed) {
    const days = (now.getTime() - new Date(stat.lastPlayed).getTime()) / MS_PER_DAY;
    recencyFactor = days <= 0 ? 1 : 0.5 ** (days / RECENCY_HALF_LIFE_DAYS);
  }

  return { gamesFactor, winRateFactor, recencyFactor };
}

export function computeComfort(
  stat: ChampStat,
  maxGamesInPool: number,
  weights: ComfortWeights,
  now: Date
): number {
  const { gamesFactor, winRateFactor, recencyFactor } = comfortFactors(
    stat,
    maxGamesInPool,
    now
  );
  const wg = Math.max(0, weights.games);
  const wwr = Math.max(0, weights.winRate);
  const wr = Math.max(0, weights.recency);
  const sum = wg + wwr + wr;
  if (sum === 0) {
    return (gamesFactor + winRateFactor + recencyFactor) / 3;
  }
  return (wg * gamesFactor + wwr * winRateFactor + wr * recencyFactor) / sum;
}

export function scorePool(
  entries: ChampStat[],
  weights: ComfortWeights,
  now: Date
): ScoredChamp[] {
  const maxGames = entries.reduce((m, e) => Math.max(m, e.games), 0);
  return entries
    .map((e) => ({ ...e, comfort: computeComfort(e, maxGames, weights, now) }))
    .sort((a, b) => b.comfort - a.comfort);
}
