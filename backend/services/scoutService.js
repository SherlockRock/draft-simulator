// backend/services/scoutService.js
//
// Thin CJS wrapper that dynamic-imports the ESM uggPlayerClient. Slice 1 has no
// persistence — it fetches a live envelope and returns it. Caching by
// last_scraped_at arrives with the Player model in Slice 2.
const path = require("path");
const { pathToFileURL } = require("url");

const CLIENT_URL = pathToFileURL(
  path.join(__dirname, "..", "..", "scripts", "ugg-scraper", "uggPlayerClient.mjs")
).href;

async function scoutPlayer({ region, gameName, tagLine }) {
  const { scoutPlayer: run } = await import(CLIENT_URL);
  return run({ region, gameName, tagLine });
}

module.exports = { scoutPlayer };
