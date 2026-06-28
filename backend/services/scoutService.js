// backend/services/scoutService.js
//
// Thin CJS wrapper that dynamic-imports the ESM uggPlayerClient. No persistence
// — fetches live envelopes and returns them. Exported as one object so
// scoutPlayers() calls the same scoutPlayer reference tests spy on.
const path = require("path");
const { pathToFileURL } = require("url");

const CLIENT_URL = pathToFileURL(
  path.join(__dirname, "..", "..", "scripts", "ugg-scraper", "uggPlayerClient.mjs")
).href;

const scoutService = {
  async scoutPlayer({ region, gameName, tagLine }) {
    const { scoutPlayer: run } = await import(CLIENT_URL);
    return run({ region, gameName, tagLine });
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
