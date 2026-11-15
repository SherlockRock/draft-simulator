/**
 * Pure derivations for the league mirror sync (S2, Task 4): rosters from who
 * played (D10), team rows (D9), completeness (D5) and the per-series request
 * plan (D2). No DB, no I/O.
 */

const { assertTeamInvariants } = require("../teamAccess");
const { normalizeStatus } = require("./normalize");

const ROLES = ["top", "jungle", "mid", "adc", "support"];
const ROSTER_CAP = 10;
const MAX_GAME_NAME = 64;
const MAX_TAG_LINE = 16;
const MAX_TEAM_NAME = 120;
const MAX_ACRONYM = 16;

/** Time of a game as a sortable number; null (unknown) is the oldest. */
const timeOf = (playedAt) => {
  if (typeof playedAt !== "string") return -Infinity;
  const t = Date.parse(playedAt);
  return Number.isNaN(t) ? -Infinity : t;
};

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @typedef {Object} RosterEntry
 * @property {1|2} teamNumber   whether the team was team1 or team2 of the game's series
 * @property {{blueSideTeam: 1|2, playedAt: string|null,
 *             participants: Record<string, {lane: string|null, playerKey: string|null,
 *                                           gameName: string|null, tagLine: string|null,
 *                                           side: "blue"|"red"}>}} game
 */

/**
 * @typedef {Object} RosterPlayer
 * @property {"top"|"jungle"|"mid"|"adc"|"support"|null} role
 * @property {string} gameName
 * @property {string} tagLine
 * @property {number} ordinal
 */

/**
 * A team's roster from the games it played (D10). Players are grouped by
 * playerKey (never returned); the Riot ID is the latest game or linked name
 * (game ties: later entry; linked ties: linked name); a player with no usable Riot ID is left
 * off. Starters take the role they played most (one role each, assigned by
 * descending game count); the rest are bench by games played; cap 10.
 * @param {RosterEntry[]} entries one per game of the team in the tournament
 * @param {Map<string, {gameName: string, tagLine: string, time: number}>} [names] private linked names dated at their check
 * @returns {RosterPlayer[]} ordinals 0..n-1, starters in role order first
 */
function deriveRoster(entries, names = new Map()) {
  const players = new Map();
  entries.forEach((entry, index) => {
    const { game, teamNumber } = entry;
    const side = game.blueSideTeam === teamNumber ? "blue" : "red";
    const time = timeOf(game.playedAt);
    const seen = new Set();
    for (const p of Object.values(game.participants)) {
      if (p.side !== side || !p.playerKey) continue;
      let rec = players.get(p.playerKey);
      if (!rec) {
        rec = { key: p.playerKey, games: 0, latest: -Infinity, roles: new Map(), id: null };
        players.set(p.playerKey, rec);
      }
      if (!seen.has(p.playerKey)) {
        seen.add(p.playerKey);
        rec.games++;
        if (time > rec.latest) rec.latest = time;
      }
      const role = p.lane === "bot" ? "adc" : p.lane;
      if (ROLES.includes(role)) rec.roles.set(role, (rec.roles.get(role) || 0) + 1);
      if (p.gameName !== null && p.gameName !== undefined && p.tagLine !== null && p.tagLine !== undefined) {
        // `>=`: on a tie the later entry wins.
        if (!rec.id || time >= rec.id.time) rec.id = { time, gameName: p.gameName, tagLine: p.tagLine };
      }
    }
  });

  const eligible = [];
  for (const rec of players.values()) {
    const linked = names.get(rec.key);
    if (linked && (!rec.id || linked.time >= rec.id.time)) rec.id = linked;
    if (!rec.id) continue;
    const gameName = String(rec.id.gameName).trim();
    const tagLine = String(rec.id.tagLine).trim();
    if (!gameName || !tagLine || gameName.length > MAX_GAME_NAME || tagLine.length > MAX_TAG_LINE) continue;
    eligible.push({ ...rec, gameName, tagLine });
  }

  const pairs = [];
  for (const rec of eligible) for (const [role, count] of rec.roles) pairs.push({ rec, role, count });
  pairs.sort((a, b) => b.count - a.count || b.rec.latest - a.rec.latest || byKey(a.rec.key, b.rec.key));

  const starterByRole = new Map();
  const placed = new Set();
  for (const { rec, role } of pairs) {
    if (starterByRole.has(role) || placed.has(rec.key)) continue;
    starterByRole.set(role, rec);
    placed.add(rec.key);
  }

  const bench = eligible
    .filter((rec) => !placed.has(rec.key))
    .sort((a, b) => b.games - a.games || b.latest - a.latest || byKey(a.key, b.key));

  const ordered = [
    ...ROLES.filter((r) => starterByRole.has(r)).map((r) => ({ role: r, rec: starterByRole.get(r) })),
    ...bench.map((rec) => ({ role: null, rec })),
  ].slice(0, ROSTER_CAP);

  return ordered.map(({ role, rec }, ordinal) => ({ role, gameName: rec.gameName, tagLine: rec.tagLine, ordinal }));
}

/**
 * Private player facts for the name step, using the same team-side rule as
 * deriveRoster. Null game dates sort oldest; later entries break ties.
 * @param {(RosterEntry & {seriesId: string})[]} entries
 * @returns {Map<string, {latest: number, latestSeries: string, named: boolean}>}
 */
function derivePlayedPlayers(entries) {
  const players = new Map();
  for (const { teamNumber, game, seriesId } of entries) {
    const side = game.blueSideTeam === teamNumber ? "blue" : "red";
    const time = timeOf(game.playedAt);
    for (const p of Object.values(game.participants)) {
      if (p.side !== side || !p.playerKey) continue;
      const previous = players.get(p.playerKey);
      const named = p.gameName != null && p.tagLine != null;
      players.set(p.playerKey, {
        latest: Math.max(previous?.latest ?? -Infinity, time),
        latestSeries: !previous || time >= previous.latest ? seriesId : previous.latestSeries,
        named: Boolean(previous?.named || named),
      });
    }
  }
  return players;
}

/**
 * The Team row for an esclub team ref (D9), checked by assertTeamInvariants.
 * @param {import("./normalize").ExternalTeamRef} ref
 * @param {{id: string, region: string, source: string}} tournament
 * @returns {object} attributes for Team.upsert
 * @throws {import("../teamAccess").TeamInvariantError} when the tournament is not an esclub one
 */
function teamRowFromRoster(ref, tournament) {
  const acronymTrimmed = typeof ref.acronym === "string" ? ref.acronym.trim() : "";
  const nameTrimmed = typeof ref.name === "string" ? ref.name.trim() : "";
  const name = (nameTrimmed || acronymTrimmed || ref.externalId).slice(0, MAX_TEAM_NAME);
  const row = {
    tournament_id: tournament.id,
    source: "esclub",
    owner_id: null,
    external_id: ref.externalId,
    external_org_id: ref.externalOrgId,
    name,
    acronym: acronymTrimmed && acronymTrimmed.length <= MAX_ACRONYM ? acronymTrimmed : null,
    colors: ref.palette || null,
    region: tournament.region,
  };
  assertTeamInvariants(row, tournament);
  return row;
}

/**
 * A game is complete once it has a winner and a participant on each side (D5).
 * @param {{winner: "blue"|"red"|null, participants: Record<string, {side: "blue"|"red"}>}} game
 * @returns {boolean}
 */
function gameIsComplete(game) {
  if (game.winner === null || game.winner === undefined) return false;
  const sides = new Set(Object.values(game.participants).map((p) => p.side));
  return sides.has("blue") && sides.has("red");
}

/**
 * A series is complete (D5) when esclub says finished, nothing is pending or
 * failed, every game is complete and one team has a majority of the games.
 * @param {{series: {status: string, bestOf: number, games: object[]}, pending: object[], failed: object[]}} normalized
 * @returns {boolean}
 */
function seriesCompleteness({ series, pending, failed }) {
  if (series.status !== "finished" || pending.length > 0 || failed.length > 0) return false;
  if (!series.games.every(gameIsComplete)) return false;
  const wins = { 1: 0, 2: 0 };
  for (const g of series.games) {
    const team = g.winner === "blue" ? g.blueSideTeam : 3 - g.blueSideTeam;
    wins[team]++;
  }
  return Math.max(wins[1], wins[2]) >= Math.floor(series.bestOf / 2) + 1;
}

/**
 * What to do with one listed series (D2, D5): skip it when complete in the
 * mirror, store it as upcoming without fetching its matches, or fetch it.
 * needsMembers is true when the mirror has no teams for it yet.
 * @param {{id_serie: string, awaiting_status: string}} listed
 * @param {{complete: boolean, team1_id: string|null, team2_id: string|null}|null} mirrored
 * @returns {{action: "skip"|"store-upcoming"|"fetch", needsMembers: boolean}}
 * @throws {import("./errors").EsclubProtocolChanged} for an unknown awaiting_status
 */
function planSeries(listed, mirrored) {
  const needsMembers = !mirrored || mirrored.team1_id == null || mirrored.team2_id == null;
  if (mirrored && mirrored.complete) return { action: "skip", needsMembers };
  if (normalizeStatus(listed.awaiting_status) === "upcoming") return { action: "store-upcoming", needsMembers };
  return { action: "fetch", needsMembers };
}

module.exports = { timeOf, derivePlayedPlayers, deriveRoster, teamRowFromRoster, gameIsComplete, seriesCompleteness, planSeries };
