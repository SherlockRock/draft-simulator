/**
 * Collector configuration. Every knob is env-overridable so the production-key
 * grant (bigger rate buckets, more tiers/regions) is a config change, not code.
 */

const int = (env, key, fallback) => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${raw}"`);
  return Math.floor(n);
};

const bucketList = (env, key, fallback) => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.some((b) => !Array.isArray(b) || b.length !== 2 || b.some((n) => !Number.isFinite(n)))
  ) {
    throw new Error(`${key} must be JSON like [[capacity,windowMs],...], got "${raw}"`);
  }
  return parsed;
};

/** Unix seconds from either raw seconds ("1755043200") or a UTC date ("2026-08-13"). */
const unixTime = (env, key, fallback) => {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`${key} must be unix seconds or YYYY-MM-DD, got "${raw}"`);
  return Math.floor(ms / 1000);
};

export function loadConfig(env = process.env) {
  return {
    regions: (env.COLLECTOR_REGIONS ?? "na1,euw1,kr").split(",").map((r) => r.trim()),

    // Crawl filters
    queueId: 420, // ranked solo/duo only
    leagueQueue: "RANKED_SOLO_5x5",
    // Crawl-era start: bounds wasted match-id fetches; matches store exact
    // patch, so being early only costs budget, never correctness. Set to the
    // current patch's release date at launch via COLLECTOR_START_TIME.
    startTime: unixTime(env, "COLLECTOR_START_TIME", Math.floor(Date.UTC(2026, 7, 1) / 1000)),
    minDurationSec: 900, // remakes out (equivalently: missing 15-min frame)
    minPatch: [11, 4], // championId unreliable before 11.4 (assertion; startTime makes it unreachable)

    // Ladder sampling: apex in full + upper Diamond via paged entries
    apexTiers: ["CHALLENGER", "GRANDMASTER", "MASTER"],
    diamondDivisions: ["I", "II"],
    diamondPageCap: int(env, "COLLECTOR_DIAMOND_PAGE_CAP", 40), // ~8k players/division to start
    ladderIntervalMs: 24 * 3600 * 1000,

    // Personal-key app buckets (20/1s + 100/2min) — production key flips these via env.
    appBuckets: bucketList(env, "COLLECTOR_APP_BUCKETS", [
      [20, 1000],
      [100, 120_000],
    ]),
    // Match-V5 method limit (2000/10s on personal keys) — never binding vs the
    // app limit today; encoded so a production key can't surprise us.
    matchMethodBucket: bucketList(env, "COLLECTOR_MATCH_METHOD_BUCKET", [[2000, 10_000]])[0],

    // Match-id loop
    summonerRefetchDays: 2,
    rankFreshDays: 7,
    apexMatchIdPages: 3, // LoLDraftAI's high/low-elo asymmetry: depth for apex,
    diamondMatchIdPages: 1, // breadth (player count) for Diamond
    matchIdsPerPage: 100,
    backlogPauseThreshold: int(env, "COLLECTOR_BACKLOG_PAUSE", 50_000),

    // Processor loop
    processorBatchSize: int(env, "COLLECTOR_PROCESSOR_BATCH", 200),
    processorConcurrency: int(env, "COLLECTOR_PROCESSOR_CONCURRENCY", 10),
  };
}
