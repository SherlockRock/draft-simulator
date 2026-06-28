// frontend/src/utils/comfort.test.ts
import { describe, expect, test } from "vitest";
import {
  comfortFactors,
  computeComfort,
  scorePool,
  DEFAULT_COMFORT_WEIGHTS,
  type ChampStat,
} from "./comfort";

const NOW = new Date("2026-06-28T00:00:00Z");
const stat = (over: Partial<ChampStat>): ChampStat => ({
  championId: "X",
  role: "mid",
  games: 0,
  wins: 0,
  lastPlayed: null,
  recentWindowGames: null,
  ...over,
});

describe("winRateFactor — Bayesian shrink toward 0.5 (k=5)", () => {
  test("1-0 champ is shrunk, cannot reach 1.0", () => {
    const f = comfortFactors(stat({ games: 1, wins: 1 }), 200, NOW);
    expect(f.winRateFactor).toBeCloseTo(0.5833, 3); // (1+2.5)/(1+5)
  });
  test("2-0 ranks above 1-0 but still shrunk", () => {
    const f = comfortFactors(stat({ games: 2, wins: 2 }), 200, NOW);
    expect(f.winRateFactor).toBeCloseTo(0.6429, 3); // (2+2.5)/(2+5)
  });
  test("10-6", () => {
    const f = comfortFactors(stat({ games: 10, wins: 6 }), 200, NOW);
    expect(f.winRateFactor).toBeCloseTo(0.5667, 3); // (6+2.5)/(10+5)
  });
  test("high-volume losing champ stays below 0.5", () => {
    const f = comfortFactors(stat({ games: 80, wins: 30 }), 200, NOW);
    expect(f.winRateFactor).toBeCloseTo(0.3824, 3); // (30+2.5)/(80+5)
  });
});

describe("gamesFactor — log-scaled, normalized to pool max", () => {
  test("200-game OTP normalizes to 1.0 when it is the pool max", () => {
    const f = comfortFactors(stat({ games: 200, wins: 120 }), 200, NOW);
    expect(f.gamesFactor).toBeCloseTo(1.0, 6);
  });
  test("a 10-game champ keeps a meaningful games component (not crushed to ~0)", () => {
    const f = comfortFactors(stat({ games: 10, wins: 6 }), 200, NOW);
    expect(f.gamesFactor).toBeCloseTo(0.4521, 3); // ln(11)/ln(201)
  });
  test("maxGamesInPool 0 yields gamesFactor 0 (no divide-by-zero)", () => {
    const f = comfortFactors(stat({ games: 0, wins: 0 }), 0, NOW);
    expect(f.gamesFactor).toBe(0);
  });
});

describe("recencyFactor — read-time decay from lastPlayed", () => {
  test("null lastPlayed → 0 (recency-not-derivable branch)", () => {
    const f = comfortFactors(stat({ games: 5, wins: 3, lastPlayed: null }), 200, NOW);
    expect(f.recencyFactor).toBe(0);
  });
  test("played today → ~1", () => {
    const f = comfortFactors(
      stat({ games: 5, wins: 3, lastPlayed: NOW.toISOString() }),
      200,
      NOW
    );
    expect(f.recencyFactor).toBeCloseTo(1, 6);
  });
  test("played one half-life (30d) ago → ~0.5", () => {
    const f = comfortFactors(
      stat({ games: 5, wins: 3, lastPlayed: "2026-05-29T00:00:00Z" }),
      200,
      NOW
    );
    expect(f.recencyFactor).toBeCloseTo(0.5, 2);
  });
});

describe("computeComfort + scorePool — anti-domination", () => {
  test("weights normalize (sum need not be 1)", () => {
    const s = stat({ games: 200, wins: 120, lastPlayed: NOW.toISOString() });
    const a = computeComfort(s, 200, { games: 50, winRate: 30, recency: 20 }, NOW);
    const b = computeComfort(s, 200, { games: 100, winRate: 60, recency: 40 }, NOW);
    expect(a).toBeCloseTo(b, 6);
  });
  test("all-zero weights fall back to equal blend", () => {
    const s = stat({ games: 10, wins: 6, lastPlayed: NOW.toISOString() });
    const v = computeComfort(s, 200, { games: 0, winRate: 0, recency: 0 }, NOW);
    const f = comfortFactors(s, 200, NOW);
    expect(v).toBeCloseTo((f.gamesFactor + f.winRateFactor + f.recencyFactor) / 3, 6);
  });
  test("200-game OTP outranks a 1-0 champ under games-weighted scoring", () => {
    const ranked = scorePool(
      [
        stat({ championId: "Otp", games: 200, wins: 110, lastPlayed: NOW.toISOString() }),
        stat({ championId: "OneGame", games: 1, wins: 1, lastPlayed: NOW.toISOString() }),
      ],
      { games: 70, winRate: 20, recency: 10 },
      NOW
    );
    expect(ranked[0].championId).toBe("Otp");
  });
  test("DEFAULT_COMFORT_WEIGHTS is exported and sums > 0", () => {
    const w = DEFAULT_COMFORT_WEIGHTS;
    expect(w.games + w.winRate + w.recency).toBeGreaterThan(0);
  });
});
