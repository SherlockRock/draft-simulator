#!/usr/bin/env node
// Turn raw esclub replies (recorded outside every git checkout) into the
// anonymised fixtures under backend/tests/fixtures/esclub/.
//
// Usage: node scripts/esclub/anonymize-fixtures.mjs <rawDir> <outDir>
//
// <rawDir> holds one JSON per recorded request: { request, context, reply },
// where `reply` is the whole reply payload. The manifest below names which raw
// file becomes which fixture. Each fixture keeps { request, context, reply }
// with `reply` reduced to the payload's `context`; envelope ids are dropped.
//
// Replaced, consistently across every file (the same player gets the same
// fake everywhere; null stays null):
//   id_oauth_riot            -> "fake-oauth-" + zero-padded index (same length, 78)
//   name_riot_game, tag_riot -> "PlayerNN" / "TNN", keyed by the player's key
//   key_encryption           -> "fake-key-" + zero-padded index (same length)
//   id_game (Riot match id, inside the LeagueOfLegends integration only) -> 1, 2, …
//   code_tournament (Riot tournament code), when set -> "fake-code-N"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const MANIFEST = {
  "event-active.json": "a01-event-active.json",
  "event-stages.json": "a02-event-stages.json",
  "event-stage.json": "a03-event-stage.json",
  "rounds.json": "a04-rounds.json",
  "team-rosters.json": "a05-team-rosters.json",
  "game-resources.json": "a06-game-resources.json",
  "team-roster-schedule.json": "a09-schedule-roster.json",
  "groups-of-round.json": "b01-groups-of-round.json",
  "series-of-group.json": "b02-series-of-group.json",
  "group-bo3/serie.json": "a07-serie-group.json",
  "group-bo3/matches.json": "a08-matches-group.json",
  "group-bo3/draft-0.json": "b03-draft-g0.json",
  "group-bo3/choices-0.json": "b04-choices-g0.json",
  "group-bo3/scores-0.json": "b05-scores-g0.json",
  "group-bo3/draft-1.json": "b06-draft-g1.json",
  "group-bo3/choices-1.json": "b07-choices-g1.json",
  "group-bo3/scores-1.json": "b08-scores-g1.json",
  "bracket-bo3/serie.json": "b09-serie-bracket.json",
  "bracket-bo3/matches.json": "b10-matches-bracket.json",
  "bracket-bo3/round.json": "b11-round-bracket.json",
  "bracket-bo3/series-of-round.json": "b12-series-of-round.json",
  "bracket-bo3/draft-0.json": "c01-draft-b0.json",
  "bracket-bo3/choices-0.json": "c02-choices-b0.json",
  "bracket-bo3/scores-0.json": "c03-scores-b0.json",
  "bracket-bo3/draft-1.json": "c04-draft-b1.json",
  "bracket-bo3/choices-1.json": "c05-choices-b1.json",
  "bracket-bo3/scores-1.json": "c06-scores-b1.json",
};

const [rawDir, outDir] = process.argv.slice(2);
if (!rawDir || !outDir) {
  console.error("usage: anonymize-fixtures.mjs <rawDir> <outDir>");
  process.exit(2);
}

const pad = (prefix, n, length) => prefix + String(n).padStart(length - prefix.length, "0");
const players = new Map(); // real id_oauth_riot -> index (1-based)
const keyIndex = { n: 0 };
const gameIds = new Map(); // real Riot match id -> fake
const codes = new Map();

function playerIndex(realKey) {
  if (!players.has(realKey)) players.set(realKey, players.size + 1);
  return players.get(realKey);
}

function anonymizeParticipant(p) {
  const out = { ...p };
  if (typeof p.id_oauth_riot === "string" && p.id_oauth_riot) {
    const i = playerIndex(p.id_oauth_riot);
    out.id_oauth_riot = pad("fake-oauth-", i, p.id_oauth_riot.length);
    const nn = String(i).padStart(2, "0");
    if (p.name_riot_game != null) out.name_riot_game = `Player${nn}`;
    if (p.tag_riot != null) out.tag_riot = `T${nn}`;
  } else if (p.name_riot_game != null || p.tag_riot != null) {
    // A Riot ID with no player key has never been seen; refuse rather than leak.
    throw new Error("participant has a Riot ID but no id_oauth_riot");
  }
  return out;
}

function anonymizeLol(lol) {
  const out = { ...lol };
  if (typeof lol.key_encryption === "string") {
    keyIndex.n += 1;
    out.key_encryption = pad("fake-key-", keyIndex.n, lol.key_encryption.length);
  }
  if (lol.id_game != null) {
    if (!gameIds.has(lol.id_game)) gameIds.set(lol.id_game, gameIds.size + 1);
    out.id_game = gameIds.get(lol.id_game);
  }
  if (lol.code_tournament != null) {
    if (!codes.has(lol.code_tournament)) codes.set(lol.code_tournament, `fake-code-${codes.size + 1}`);
    out.code_tournament = codes.get(lol.code_tournament);
  }
  if (Array.isArray(lol.participants)) out.participants = lol.participants.map(anonymizeParticipant);
  return out;
}

// Walk everything; rewrite LeagueOfLegends integration blocks that carry
// match data, and refuse any player field found anywhere else.
function walk(value, key) {
  if (Array.isArray(value)) return value.map((v) => walk(v, key));
  if (value && typeof value === "object") {
    if (key === "LeagueOfLegends" && ("participants" in value || "key_encryption" in value)) {
      return anonymizeLol(value);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (["id_oauth_riot", "name_riot_game", "tag_riot", "key_encryption"].includes(k) && v != null) {
        throw new Error(`player field ${k} outside a LeagueOfLegends match block`);
      }
      out[k] = walk(v, k);
    }
    return out;
  }
  return value;
}

// Sorted so the fake indices do not depend on the manifest's object order.
for (const fixture of Object.keys(MANIFEST).sort()) {
  const raw = JSON.parse(readFileSync(join(rawDir, MANIFEST[fixture]), "utf8"));
  const fixtureJson = {
    request: raw.request,
    context: raw.context,
    reply: walk(raw.reply.context, null),
  };
  const target = join(outDir, fixture);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(fixtureJson, null, 2) + "\n");
}
console.log(`wrote ${Object.keys(MANIFEST).length} fixtures; ${players.size} players, ${gameIds.size} Riot match ids replaced`);
