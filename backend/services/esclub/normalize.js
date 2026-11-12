/**
 * The esclub normaliser: pure functions from what requests.js returns to the
 * shapes the league mirror (S2) stores. No I/O. Unknown status or draft-type
 * values fail loudly (EsclubProtocolChanged / EsclubUnsupported); nothing is
 * mapped by guess.
 */

const { EsclubProtocolChanged, EsclubUnsupported } = require("./errors");

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

/**
 * The games part of normalizeSeries. Task 6 replaces this body; its input and
 * output shapes are fixed here so that Task 6 only adds.
 * @param {{ teams: [ExternalTeamRef, ExternalTeamRef], matches: object[],
 *           drafts: Record<string, object>, choices: Record<string, object[]>, resources: object[] }} input
 * @returns {{ games: NormalizedGame[], pending: GameNote[], skipped: GameNote[] }}
 */
// eslint-disable-next-line no-unused-vars
function normalizeGames(input) {
  return { games: [], pending: [], skipped: [] };
}

/**
 * @param {{ serie: object, seasonId: string, stageId: string,
 *           teams: [ExternalTeamRef, ExternalTeamRef], matches: object[],
 *           drafts: Record<string, object>, choices: Record<string, object[]>,
 *           resources: object[] }} input  teams are ordered by the caller
 * @returns {{ series: NormalizedSeries, pending: GameNote[], skipped: GameNote[] }}
 */
function normalizeSeries(input) {
  const { serie, seasonId, stageId, teams } = input;
  if (!Array.isArray(teams) || teams.length !== 2 || teams[0].externalId === teams[1].externalId) {
    throw new EsclubProtocolChanged("esclub: normalizeSeries needs two distinct teams");
  }
  const status = normalizeStatus(serie.awaiting_status);

  const kinds = new Set(Object.values(input.drafts || {}).map((d) => normalizeDraftType(d.type_fearless)));
  if (kinds.size > 1) {
    throw new EsclubProtocolChanged(`esclub: series ${serie.id_serie} has games of different draft types`);
  }
  const draftType = kinds.size === 1 ? [...kinds][0] : null;

  const { games, pending, skipped } = normalizeGames({
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
  };
}

module.exports = { normalizeTeamRoster, normalizeStatus, normalizeDraftType, normalizeSeries, normalizeGames };
