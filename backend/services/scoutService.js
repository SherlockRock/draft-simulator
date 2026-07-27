// backend/services/scoutService.js
//
// Thin CJS wrapper that dynamic-imports the ESM uggPlayerClient, fronted by a
// short-TTL in-process cache. Ranked stats move on the order of an hour, so a
// reload or a repeat "Scout this team" of an overlapping roster should not
// re-hit u.gg. Exported as one object so scoutPlayers() calls the same
// scoutPlayer reference tests spy on.
const path = require("path");
const { pathToFileURL } = require("url");
const { createTtlCache } = require("./ttlCache");

const CLIENT_URL = pathToFileURL(
  path.join(__dirname, "..", "..", "scripts", "ugg-scraper", "uggPlayerClient.mjs")
).href;

const SCOUT_CACHE_TTL_MS = 20 * 60 * 1000;
const SCOUT_CACHE_MAX_ENTRIES = 500;

// NUL can't appear in a Riot id, so it can't be forged into a key collision.
function cacheKey({ region, gameName, tagLine }) {
  return [region, gameName, tagLine].map((s) => s.toLowerCase()).join("\u0000");
}

const scoutService = {
  SCOUT_CACHE_TTL_MS,

  // In-process only: a single Railway instance today, and a cold start just
  // re-warms. Exposed so callers (and ops) can drop entries wholesale.
  scoutCache: createTtlCache({
    ttlMs: SCOUT_CACHE_TTL_MS,
    maxEntries: SCOUT_CACHE_MAX_ENTRIES,
  }),

  // The uncached outbound fetch. Split out from scoutPlayer so the cache has
  // something to wrap — everything else should call scoutPlayer.
  async fetchPlayer({ region, gameName, tagLine }) {
    const { scoutPlayer: run } = await import(CLIENT_URL);
    return run({ region, gameName, tagLine });
  },

  // Cached per player, not per team, so a re-scout that swaps one sub reuses
  // the other nine. `refresh` busts this player's entry for a deliberate
  // refetch. Only resolved envelopes are stored: a throw never reaches set(),
  // because a transient u.gg failure cached for 20 minutes poisons every retry.
  async scoutPlayer({ region, gameName, tagLine, refresh = false }) {
    const key = cacheKey({ region, gameName, tagLine });
    if (!refresh) {
      const hit = scoutService.scoutCache.get(key);
      if (hit) return hit;
    }
    const envelope = await scoutService.fetchPlayer({ region, gameName, tagLine });
    scoutService.scoutCache.set(key, envelope);
    return envelope;
  },

  // Sequentially scouts each player, isolating per-player failures into error
  // results. Sequential (not parallel) for deterministic ordering; UggFetcher
  // self-rate-limits regardless. Returns { results: PlayerScoutResult[] }.
  async scoutPlayers({ region, players }) {
    const results = [];
    for (const p of players) {
      const input = { region, gameName: p.gameName, tagLine: p.tagLine };
      try {
        const envelope = await scoutService.scoutPlayer(input);
        results.push({ status: "ok", input, envelope });
      } catch (err) {
        results.push({
          status: "error",
          input,
          error: (err && err.message) || "scout failed",
        });
      }
    }
    return { results };
  },
};

module.exports = scoutService;
