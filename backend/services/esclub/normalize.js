/**
 * The esclub normaliser: pure functions from what requests.js returns to the
 * shapes the league mirror (S2) stores. No I/O. Unknown status or draft-type
 * values fail loudly (EsclubProtocolChanged / EsclubUnsupported); nothing is
 * mapped by guess.
 */

const { EsclubProtocolChanged, EsclubUnsupported, EsclubUnknownChampion } = require("./errors");
const { getEffectivePickOrder, getPicksArrayIndex } = require("../../utils/versusPickOrder");
const { championAliasForKey } = require("../../utils/championKeys");

/**
 * @typedef {Object} ExternalTeamRef
 * @property {string} externalId      id_team_roster
 * @property {string} externalOrgId   id_team_organisation
 * @property {string} name
 * @property {string|null} acronym
 * @property {{primary: string, secondary: string}|null} palette
 */

/**
 * @typedef {Object} Participant
 * @property {"top"|"jungle"|"mid"|"bot"|"support"|null} lane
 * @property {string|null} playerKey  id_oauth_riot; stable, never shown
 * @property {string|null} gameName
 * @property {string|null} tagLine
 */

/**
 * @typedef {Object} NormalizedGame
 * @property {string} externalMatchId
 * @property {number} number
 * @property {string|null} playedAt                ISO string
 * @property {string[]} picks                      20 slots, Draft.picks layout
 * @property {"blue"|"red"} firstPick
 * @property {1|2} blueSideTeam                    which of the series' teams is on blue
 * @property {"blue"|"red"|null} winner
 * @property {Record<string, Participant>} participants  keyed by picked champion
 * @property {number} unmatchedParticipants
 */

/**
 * @typedef {Object} NormalizedSeries
 * @property {"esclub"} source
 * @property {string} externalId
 * @property {string} seasonId
 * @property {string} stageId
 * @property {string|null} startsAt                ISO string
 * @property {"upcoming"|"in_progress"|"finished"} status
 * @property {number} bestOf
 * @property {"fearless"|"standard"|null} draftType  null when no game has a draft yet
 * @property {[ExternalTeamRef, ExternalTeamRef]} teams  order set by the caller
 * @property {NormalizedGame[]} games
 */

/**
 * @typedef {Object} GameNote
 * @property {string} externalMatchId
 * @property {number} number
 * @property {string} reason
 */

const STATUS = {
  InitiatePending: "upcoming",
  InitiateDefault: "upcoming",
  StartPending: "upcoming",
  StartDefault: "upcoming",
  TerminatePending: "in_progress",
  TerminateDefault: "in_progress",
  EndPending: "in_progress",
  EndDefault: "in_progress",
  FinalizePending: "in_progress",
  FinalizeDefault: "in_progress",
  Finished: "finished",
};

const DRAFT_TYPE = { HardPick: "fearless", None: "standard" };

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * ExternalTeamRef from a fetch-team-rosters row.
 * @param {{id_team_roster: string, id_team_organisation: string, name: string, extra?: object}} row
 * @returns {ExternalTeamRef}
 */
function normalizeTeamRoster(row) {
  const extra = (row && row.extra) || {};
  const p = extra.palette;
  const palette =
    p && typeof p.primary === "string" && typeof p.secondary === "string"
      ? { primary: p.primary, secondary: p.secondary }
      : null;
  return {
    externalId: row.id_team_roster,
    externalOrgId: row.id_team_organisation,
    name: row.name,
    acronym: typeof extra.acronym === "string" ? extra.acronym : null,
    palette,
  };
}

/**
 * Only "Finished" is finished (Reading 1); End and Finalize values stay in_progress.
 * @param {string} awaitingStatus
 * @returns {"upcoming"|"in_progress"|"finished"}
 * @throws {EsclubProtocolChanged} for any other value.
 */
function normalizeStatus(awaitingStatus) {
  if (typeof awaitingStatus === "string" && has(STATUS, awaitingStatus)) return STATUS[awaitingStatus];
  throw new EsclubProtocolChanged(`esclub: unknown series awaiting_status ${JSON.stringify(awaitingStatus)}`);
}

/**
 * HardPick -> fearless, None -> standard (Reading 2).
 * @param {string} typeFearless
 * @returns {"fearless"|"standard"}
 * @throws {EsclubUnsupported} for any other value.
 */
function normalizeDraftType(typeFearless) {
  if (typeof typeFearless === "string" && has(DRAFT_TYPE, typeFearless)) return DRAFT_TYPE[typeFearless];
  throw new EsclubUnsupported(`esclub: draft type_fearless ${JSON.stringify(typeFearless)} is not imported`);
}

/**
 * time_start_forced ?? time_start_agreed ?? time_start_default (unix seconds) -> ISO, else null.
 * @param {{time_start_forced?: number|null, time_start_agreed?: number|null, time_start_default?: number|null}} serie
 * @returns {string|null}
 */
function seriesStartsAt(serie) {
  const t = serie.time_start_forced ?? serie.time_start_agreed ?? serie.time_start_default ?? null;
  return typeof t === "number" && Number.isFinite(t) ? new Date(t * 1000).toISOString() : null;
}

const LANES = { Top: "top", Jungle: "jungle", Mid: "mid", Bot: "bot", Support: "support" };
const SIDE_BY_NUMBER = { 1: "blue", 2: "red" };

const iso = (unixSeconds) =>
  typeof unixSeconds === "number" && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;

/**
 * Which roster is on which side, for one game (Reading 3).
 * Participants matched by picked champion decide; a locked PickSide row decides when
 * there are no matched participants; both must agree when both exist.
 * @returns {Map<string, "blue"|"red">|null} null when nothing decides
 */
function rosterSides(rosterIds, finals, allChoices, participants, byResource, matchId) {
  const fail = (msg) => new EsclubProtocolChanged(`esclub: match ${matchId}: ${msg}`);
  const other = (side) => (side === "blue" ? "red" : "blue");

  // From participants.
  const fromParticipants = new Map();
  for (const c of finals) {
    if (c.type_choice !== "PickCharacter") continue;
    const key = Number(byResource.get(c.id_game_resource)?.id_external);
    const matches = participants.filter((p) => p.id_champion === key);
    if (matches.length === 0) continue;
    const sides = new Set(matches.map((p) => SIDE_BY_NUMBER[p.side]));
    if (sides.size !== 1 || sides.has(undefined)) throw fail(`participant side for champion ${key} is not 1 or 2`);
    const side = [...sides][0];
    const known = fromParticipants.get(c.id_team_roster_source);
    if (known && known !== side) throw fail(`roster ${c.id_team_roster_source} has picks on both sides`);
    fromParticipants.set(c.id_team_roster_source, side);
  }
  let resolved = null;
  if (fromParticipants.size > 0) {
    resolved = new Map();
    for (const id of rosterIds) {
      const side = fromParticipants.get(id);
      if (side) resolved.set(id, side);
    }
    if (resolved.size === 2 && new Set(resolved.values()).size !== 2) throw fail("both rosters matched the same side");
    if (resolved.size === 1) {
      const [[id, side]] = [...resolved];
      resolved.set(rosterIds.find((r) => r !== id), other(side));
    }
  }

  // From PickSide rows. Only locked rows are the actual choice; unlocked rows
  // are hovers (the fixtures hold an unlocked and a locked row per choice).
  // Inconsistent locked rows (a roster naming two sides, or both rosters naming
  // the same side) decide nothing; they only throw if participants contradict them.
  const fromPickSide = new Map();
  let pickSideConsistent = true;
  for (const c of allChoices) {
    if (c.type_choice !== "PickSide" || c.is_locked !== true) continue;
    const res = byResource.get(c.id_game_resource);
    const side = res && res.type_resource === "Side" ? { 1: "blue", 2: "red" }[res.id_external] : undefined;
    if (!side) throw fail("a PickSide row does not name a Side resource 1 or 2");
    if (!rosterIds.includes(c.id_team_roster_source)) throw fail("a PickSide row names a roster outside the game");
    const known = fromPickSide.get(c.id_team_roster_source);
    if (known && known !== side) pickSideConsistent = false;
    fromPickSide.set(c.id_team_roster_source, side);
  }
  let viaPickSide = null;
  if (fromPickSide.size > 0 && pickSideConsistent) {
    const sides = [...fromPickSide.values()];
    if (fromPickSide.size === 2 && sides[0] === sides[1]) pickSideConsistent = false;
    else {
      viaPickSide = new Map();
      for (const [id, side] of fromPickSide) {
        viaPickSide.set(id, side);
        viaPickSide.set(rosterIds.find((r) => r !== id), other(side));
      }
    }
  }
  if (fromPickSide.size > 0 && !pickSideConsistent && resolved) {
    // Participants decide; the locked rows contradict themselves, so no cross-check is possible.
    return resolved;
  }

  if (resolved && viaPickSide) {
    for (const id of rosterIds) {
      if (resolved.get(id) !== viaPickSide.get(id)) throw fail("participants and PickSide disagree on sides");
    }
  }
  return resolved || viaPickSide;
}

/**
 * Participants keyed by picked champion, from the picking roster's side only.
 * @returns {{participants: Record<string, Participant>, unmatched: number}}
 */
function buildParticipants(finals, sideOf, participants, byResource, matchId) {
  const out = {};
  const used = new Set();
  for (const c of finals) {
    if (c.type_choice !== "PickCharacter") continue;
    const key = byResource.get(c.id_game_resource).id_external;
    const alias = championAliasForKey(key);
    const side = sideOf.get(c.id_team_roster_source);
    const p = participants.find((q, i) => !used.has(i) && q.id_champion === Number(key) && SIDE_BY_NUMBER[q.side] === side);
    if (!p) continue;
    used.add(participants.indexOf(p));
    let lane = null;
    if (p.lane_team != null) {
      if (!has(LANES, p.lane_team)) {
        throw new EsclubProtocolChanged(`esclub: match ${matchId}: unknown lane ${JSON.stringify(p.lane_team)}`);
      }
      lane = LANES[p.lane_team];
    }
    const named = typeof p.name_riot_game === "string" && p.name_riot_game && typeof p.tag_riot === "string" && p.tag_riot;
    out[alias] = {
      lane,
      playerKey: typeof p.id_oauth_riot === "string" && p.id_oauth_riot ? p.id_oauth_riot : null,
      gameName: named ? p.name_riot_game : null,
      tagLine: named ? p.tag_riot : null,
    };
  }
  return { participants: out, unmatched: participants.length - used.size };
}

/**
 * Normalise one match. Returns {note} for skipped/pending, {game} for a game.
 * Throws EsclubProtocolChanged for contradictions and EsclubUnknownChampion
 * for a pick/ban whose resource is not a catalog champion.
 */
function normalizeGame(match, draft, choices, teams, byResource) {
  const id = match.id_match;
  const number = match.number;
  const fail = (msg) => new EsclubProtocolChanged(`esclub: match ${id}: ${msg}`);
  const note = (kind, reason) => ({ kind, note: { externalMatchId: id, number, reason } });

  if (draft && draft.is_blind) return note("skipped", "blind draft");
  if (!draft) return note("pending", "no draft yet");

  const finals = choices.filter((c) => c.is_final && c.type_choice !== "PickSide");
  const byNumber = new Map();
  for (const c of finals) {
    if (!Number.isInteger(c.number) || c.number < 0 || c.number > 19) throw fail(`final choice number ${c.number} out of range`);
    if (byNumber.has(c.number)) throw fail(`two final choices numbered ${c.number}`);
    byNumber.set(c.number, c);
  }
  if (byNumber.size < 20) return note("pending", "draft incomplete");

  const lol = ((match.config && match.config.integrations) || []).map((i) => i && i.LeagueOfLegends).find(Boolean);
  if (!lol) throw fail("no LeagueOfLegends block");
  const participants = Array.isArray(lol.participants) ? lol.participants : [];

  const rosterIds = [...new Set(finals.map((c) => c.id_team_roster_source))];
  const teamIds = teams.map((t) => t.externalId);
  if (rosterIds.length !== 2 || !rosterIds.every((r) => teamIds.includes(r))) {
    throw fail(`rosters ${JSON.stringify(rosterIds)} are not the series' two teams`);
  }
  for (const c of finals) {
    if (c.type_choice !== "BanCharacter" && c.type_choice !== "PickCharacter") throw fail(`unknown choice type ${c.type_choice}`);
  }

  const sideOf = rosterSides(rosterIds, finals, choices, participants, byResource, id);
  if (!sideOf) return note("pending", "sides unknown");

  const firstPick = sideOf.get(byNumber.get(0).id_team_roster_source);
  const order = getEffectivePickOrder(firstPick);
  const picks = new Array(20).fill("");
  for (let n = 0; n < 20; n++) {
    const c = byNumber.get(n);
    const want = order[n];
    const type = c.type_choice === "BanCharacter" ? "ban" : "pick";
    if (type !== want.type || sideOf.get(c.id_team_roster_source) !== want.team) {
      throw fail(`choice ${n} (${type} by ${sideOf.get(c.id_team_roster_source)}) breaks the turn order`);
    }
    const resource = byResource.get(c.id_game_resource);
    const alias = resource && resource.type_resource === "Character" ? championAliasForKey(resource.id_external) : null;
    if (!alias) {
      throw new EsclubUnknownChampion(
        `esclub: match ${id}: choice ${n} is champion key ${JSON.stringify(resource && resource.id_external)}, not in the catalog`
      );
    }
    picks[getPicksArrayIndex(n, firstPick)] = alias;
  }

  const blueRoster = [...sideOf].find(([, s]) => s === "blue")[0];
  const blueSideTeam = teams[0].externalId === blueRoster ? 1 : 2;

  let winner = null;
  if (lol.is_done === true && lol.winner_side !== null && lol.winner_side !== undefined) {
    if (!has(SIDE_BY_NUMBER, lol.winner_side)) throw fail(`winner_side ${JSON.stringify(lol.winner_side)} is not 1 or 2`);
    winner = SIDE_BY_NUMBER[lol.winner_side];
  }

  const built = buildParticipants(finals, sideOf, participants, byResource, id);
  return {
    kind: "game",
    game: {
      externalMatchId: id,
      number,
      playedAt: iso(match.time_start),
      picks,
      firstPick,
      blueSideTeam,
      winner,
      participants: built.participants,
      unmatchedParticipants: built.unmatched,
    },
  };
}

/**
 * The games part of normalizeSeries: matches in `number` order, each one
 * normalised, skipped (blind), pending (not yet normalisable) or failed
 * (unknown champion; EsclubUnknownChampion, for that game only). Any other
 * contradiction throws EsclubProtocolChanged for the whole series.
 * @param {{ teams: [ExternalTeamRef, ExternalTeamRef], matches: object[],
 *           drafts: Record<string, object>, choices: Record<string, object[]>, resources: object[] }} input
 * @returns {{ games: NormalizedGame[], pending: GameNote[], skipped: GameNote[], failed: (GameNote & {error: Error})[] }}
 */
function normalizeGames(input) {
  const byResource = new Map((input.resources || []).map((r) => [r.id_game_resource, r]));
  const out = { games: [], pending: [], skipped: [], failed: [] };
  const matches = [...(input.matches || [])].sort((a, b) => a.number - b.number);
  for (const m of matches) {
    try {
      const r = normalizeGame(m, (input.drafts || {})[m.id_match], (input.choices || {})[m.id_match] || [], input.teams, byResource);
      if (r.kind === "game") out.games.push(r.game);
      else out[r.kind].push(r.note);
    } catch (e) {
      if (!(e instanceof EsclubUnknownChampion)) throw e;
      out.failed.push({ externalMatchId: m.id_match, number: m.number, reason: e.message, error: e });
    }
  }
  return out;
}

/**
 * @param {{ serie: object, seasonId: string, stageId: string,
 *           teams: [ExternalTeamRef, ExternalTeamRef], matches: object[],
 *           drafts: Record<string, object>, choices: Record<string, object[]>,
 *           resources: object[] }} input  teams are ordered by the caller
 * @returns {{ series: NormalizedSeries, pending: GameNote[], skipped: GameNote[], failed: (GameNote & {error: Error})[] }}
 */
function normalizeSeries(input) {
  const { serie, seasonId, stageId, teams } = input;
  if (!Array.isArray(teams) || teams.length !== 2 || teams[0].externalId === teams[1].externalId) {
    throw new EsclubProtocolChanged("esclub: normalizeSeries needs two distinct teams");
  }
  const status = normalizeStatus(serie.awaiting_status);

  // Blind drafts are skipped before any other check, so they do not vote on the type.
  const kinds = new Set(
    Object.values(input.drafts || {})
      .filter((d) => !d.is_blind)
      .map((d) => normalizeDraftType(d.type_fearless))
  );
  if (kinds.size > 1) {
    throw new EsclubProtocolChanged(`esclub: series ${serie.id_serie} has games of different draft types`);
  }
  const draftType = kinds.size === 1 ? [...kinds][0] : null;

  const { games, pending, skipped, failed } = normalizeGames({
    teams,
    matches: input.matches || [],
    drafts: input.drafts || {},
    choices: input.choices || {},
    resources: input.resources || [],
  });

  return {
    series: {
      source: "esclub",
      externalId: serie.id_serie,
      seasonId,
      stageId,
      startsAt: seriesStartsAt(serie),
      status,
      bestOf: serie.best_of,
      draftType,
      teams: [teams[0], teams[1]],
      games,
    },
    pending,
    skipped,
    failed,
  };
}

module.exports = { normalizeTeamRoster, normalizeStatus, normalizeDraftType, normalizeSeries, normalizeGames };
