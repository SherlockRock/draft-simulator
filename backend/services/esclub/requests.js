/**
 * The typed request functions of the esclub adapter. Each builds its own wire
 * context (nothing outside this file builds an envelope's context), sends it
 * through an EsclubClient, and checks the reply's array key and, for every
 * item, only the fields the normaliser reads. Extra fields are allowed;
 * nullable fields observed null in the recorded fixtures are accepted as null.
 *
 * Lists are single-page (one request from the `null` cursor) and return
 * `{ items, cursor }`. esclub's replies carry no cursor of their own, so
 * `cursor` is derived from the last item, as the values the next request would
 * put in its context; it has never been sent (nothing pages yet).
 *
 * A by-id fetch that returns an empty array throws EsclubNotFound; a reply of
 * the wrong shape throws EsclubProtocolChanged naming request and field path.
 */

const { EsclubProtocolChanged, EsclubNotFound } = require("./errors");

// ---- a tiny shape checker ---------------------------------------------------

const str = (v) => typeof v === "string";
const num = (v) => typeof v === "number" && Number.isFinite(v);
const bool = (v) => typeof v === "boolean";
const nullable = (check) => Object.assign((v) => v === null || check(v), { label: `${check.label} or null` });
const mk = (label, fn) => Object.assign(fn, { label });
const S = mk("a string", str);
const N = mk("a number", num);
const B = mk("a boolean", bool);
const NS = nullable(S);
const NN = nullable(N);

/** Fails with EsclubProtocolChanged unless `value` satisfies `spec` (an object of field checks or a predicate). */
function check(request, path, value, spec) {
  if (typeof spec === "function") {
    if (!spec(value)) {
      throw new EsclubProtocolChanged(`esclub ${request}: ${path} is not ${spec.label} (got ${describe(value)})`);
    }
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EsclubProtocolChanged(`esclub ${request}: ${path} is not an object (got ${describe(value)})`);
  }
  for (const [key, sub] of Object.entries(spec)) {
    check(request, `${path}.${key}`, value[key], sub);
  }
}

function describe(v) {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

function arrayOf(request, reply, key, itemSpec) {
  const list = reply && reply[key];
  if (!Array.isArray(list)) {
    throw new EsclubProtocolChanged(`esclub ${request}: reply.${key} is not an array (got ${describe(list)})`);
  }
  list.forEach((item, i) => check(request, `${key}[${i}]`, item, itemSpec));
  return list;
}

async function one(client, request, context, key, itemSpec, what) {
  const items = arrayOf(request, await client.request(request, context), key, itemSpec);
  if (items.length === 0) throw new EsclubNotFound(`esclub ${request}: no ${what} for ${JSON.stringify(context)}`);
  return items[0];
}

async function list(client, request, context, key, itemSpec, cursorOf) {
  const items = arrayOf(request, await client.request(request, context), key, itemSpec);
  return { items, cursor: items.length ? cursorOf(items[items.length - 1]) : null };
}

// ---- item shapes (only what a consumer reads) -------------------------------

const EVENT = { id_event_active: S, name: S, awaiting_status: S };
const STAGE = {
  id_event_stage: S, id_game: S, name: S, number: N,
  config: { format: (v) => !!v && typeof v === "object", default_draft: nullable(mk("an object", (v) => !!v && typeof v === "object")) },
};
const ROUND = { id_round: S, id_event_stage: S, number: N, best_of: NN };
const GROUP = { id_group: S, id_round: S, number: N };
const SERIE = {
  id_serie: S, id_parent: S, type_parent: S, awaiting_status: S, best_of: N, number: N,
  id_serie_winner: NS,
  time_start: NN, time_start_agreed: NN, time_start_default: NN, time_start_forced: NN,
};
const PARTICIPANT = {
  id_champion: N, side: N, lane_team: NS,
  id_oauth_riot: NS, name_riot_game: NS, tag_riot: NS,
};
const MATCH = {
  id_match: S, id_serie: S, number: N, awaiting_status: S, time_start: NN,
  config: { integrations: mk("an array", Array.isArray) },
};
const LOL_BLOCK = {
  winner_side: NN, is_done: B,
  participants: mk("an array", Array.isArray),
};
const DRAFT = { id_match: S, is_blind: B, type_fearless: S, type_side_selection: S };
const CHOICE = {
  number: N, is_final: B, type_choice: S,
  id_game_resource: S, id_team_roster_source: NS,
};
const SCORE = { id_match: S, id_team_roster: S, score: N };
const ROSTER = {
  id_team_roster: S, id_team_organisation: S, name: S,
  extra: mk("an object", (v) => !!v && typeof v === "object"),
};
const RESOURCE = { id_game_resource: S, id_external: S, type_resource: S, name: S };

/** Validates the LeagueOfLegends block (and its participants) of each match, when a match has one. */
function checkMatches(request, matches) {
  matches.forEach((m, i) => {
    const integrations = m.config.integrations;
    integrations.forEach((integration, j) => {
      const block = integration && integration.LeagueOfLegends;
      if (!block) return;
      const base = `matches[${i}].config.integrations[${j}].LeagueOfLegends`;
      check(request, base, block, LOL_BLOCK);
      block.participants.forEach((p, k) => check(request, `${base}.participants[${k}]`, p, PARTICIPANT));
    });
  });
}

// ---- the request functions --------------------------------------------------

/**
 * The season (an active event).
 * @param {import("./client").EsclubClient} client
 * @param {{ id_event_active: string }} ids
 * @returns {Promise<object>} the season item (`name`, `awaiting_status`, ...).
 * @throws {EsclubNotFound} when esclub returns no event.
 */
function fetchEventActive(client, { id_event_active }) {
  return one(client, "fetch-event-active", { id_event_active }, "events", EVENT, "season");
}

/**
 * The stages of a season, from the `null` cursor.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_event_active: string }} ids
 * @returns {Promise<{ items: object[], cursor: { id_event_stage: string } | null }>}
 */
function fetchEventStages(client, { id_event_active }) {
  return list(
    client, "fetch-event-stages-by-number-next",
    { id_event_active, id_event_stage: null, before: false },
    "events", STAGE, (s) => ({ id_event_stage: s.id_event_stage }),
  );
}

/**
 * One stage.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_event_stage: string }} ids
 * @returns {Promise<object>}
 * @throws {EsclubNotFound}
 */
function fetchEventStage(client, { id_event_stage }) {
  return one(client, "fetch-event-stage", { id_event_stage }, "events", STAGE, "stage");
}

/**
 * The rounds of a stage, from the `null` cursor.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_event_stage: string }} ids
 * @returns {Promise<{ items: object[], cursor: { number: number } | null }>}
 */
function fetchRounds(client, { id_event_stage }) {
  return list(
    client, "fetch-rounds-by-number-next",
    { id_event_stage, number: null, before: false },
    "rounds", ROUND, (r) => ({ number: r.number }),
  );
}

/**
 * One round.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_round: string }} ids
 * @returns {Promise<object>}
 * @throws {EsclubNotFound}
 */
function fetchRound(client, { id_round }) {
  return one(client, "fetch-round", { id_round }, "rounds", ROUND, "round");
}

/**
 * The groups of a round, from the `null` cursor.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_round: string }} ids
 * @returns {Promise<{ items: object[], cursor: { number: number } | null }>}
 */
function fetchGroups(client, { id_round }) {
  return list(
    client, "fetch-groups-by-number-next",
    { id_round, number: null, before: false },
    "groups", GROUP, (g) => ({ number: g.number }),
  );
}

/**
 * The series under a parent, which is a group or a round, from the `null` cursor.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_parent: string }} ids
 * @returns {Promise<{ items: object[], cursor: { number: number } | null }>}
 */
function fetchSeriesInParent(client, { id_parent }) {
  return list(
    client, "fetch-series-by-number-next",
    { id_parent, number: null, before: false },
    "series", SERIE, (s) => ({ number: s.number }),
  );
}

/**
 * One series.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_serie: string }} ids
 * @returns {Promise<object>}
 * @throws {EsclubNotFound}
 */
function fetchSerie(client, { id_serie }) {
  return one(client, "fetch-serie", { id_serie }, "series", SERIE, "series");
}

/**
 * A team roster's schedule of series, from the `null` cursor.
 * `cursor` is always null: the reply is not ordered by `time_start` (it is by
 * `awaiting_time_start`, descending), so no next-page cursor can be derived
 * from it without checking against esclub. Unverified paging is S2's call.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_team_roster: string }} ids
 * @returns {Promise<{ items: object[], cursor: null }>}
 */
function fetchTeamRosterSchedule(client, { id_team_roster }) {
  return list(
    client, "fetch-series-by-schedule-of-team-roster-with-draft",
    { id_team_roster, id_serie: null, time_start: null, before: false },
    "series", SERIE, () => null,
  );
}

/**
 * The matches (games) of a series, from the `null` cursor. Game numbers start at 0.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_serie: string }} ids
 * @returns {Promise<{ items: object[], cursor: { number: number } | null }>}
 */
async function fetchMatches(client, { id_serie }) {
  const request = "fetch-matches-by-number-next";
  const result = await list(
    client, request,
    { id_serie, number: null, before: false },
    "matches", MATCH, (m) => ({ number: m.number }),
  );
  checkMatches(request, result.items);
  return result;
}

/**
 * The draft settings of a match.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_match: string }} ids
 * @returns {Promise<object>}
 * @throws {EsclubNotFound}
 */
function fetchDraft(client, { id_match }) {
  return one(client, "fetch-draft-by-match", { id_match }, "drafts", DRAFT, "draft");
}

/**
 * The draft choices (bans, picks, side picks, hovers) of a match. The request
 * takes no cursor and numbers repeat across rows, so `cursor` is always null.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_match: string }} ids
 * @returns {Promise<{ items: object[], cursor: null }>}
 */
function fetchDraftChoices(client, { id_match }) {
  return list(
    client, "fetch-draft-choices-by-match", { id_match },
    "choices", CHOICE, () => null,
  );
}

/**
 * The scores of a match, without the teams.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_match: string }} ids
 * @returns {Promise<{ items: object[], cursor: null }>}
 */
function fetchScores(client, { id_match }) {
  return list(
    client, "fetch-scores-by-match", { id_match, omit_teams: true },
    "scores", SCORE, () => null,
  );
}

/**
 * The team rosters of a stage, from the `null` cursor.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_event_stage: string }} ids
 * @returns {Promise<{ items: object[], cursor: { id_team_roster: string } | null }>}
 */
function fetchTeamRosters(client, { id_event_stage }) {
  return list(
    client, "fetch-team-rosters-by-event-stage-next",
    { id_event_stage, id_team_roster: null, before: false },
    "teams", ROSTER, (t) => ({ id_team_roster: t.id_team_roster }),
  );
}

/**
 * The resources (champions by Riot key, sides) of a game.
 * @param {import("./client").EsclubClient} client
 * @param {{ id_game: string }} ids
 * @returns {Promise<{ items: object[], cursor: null }>}
 */
function fetchGameResources(client, { id_game }) {
  return list(
    client, "fetch-game-resources", { id_game },
    "resources", RESOURCE, () => null,
  );
}

module.exports = {
  fetchEventActive,
  fetchEventStages,
  fetchEventStage,
  fetchRounds,
  fetchRound,
  fetchGroups,
  fetchSeriesInParent,
  fetchSerie,
  fetchTeamRosterSchedule,
  fetchMatches,
  fetchDraft,
  fetchDraftChoices,
  fetchScores,
  fetchTeamRosters,
  fetchGameResources,
};
