/**
 * The esclub sync engine (S2 Task 6): walks a stage, writes teams and series
 * to the league mirror, and runs a sync under the lock/budget/cap of
 * syncState. Orchestration only: every request goes through requests.js on
 * the client it is handed, every database write through mirrorStore.js. Both
 * are injectable (`requests`, `store`) so tests use a stub client and an
 * in-memory store.
 *
 * Traffic rules kept here (plan D2, D5-D8):
 *  - members are asked once per series, only while it lacks two teams;
 *  - a complete series costs no request; a complete game is never fetched
 *    again; an upcoming series costs at most its members request;
 *  - one store transaction per series, opened only after all its requests
 *    succeeded, so a stop leaves the series in hand unwritten.
 *
 * Nothing here logs a reply, a Riot ID, a player key or member data: only
 * counts and ids of the league's own rows.
 */

const defaultStore = require("./mirrorStore");
const defaultRequests = require("./requests");
const defaultState = require("./syncState");
const { withEsclubSession } = require("./client");
const { createTtlCache } = require("../ttlCache");
const debug = require("../../utils/logger").debug;
const { normalizeSeries, normalizeStatus, normalizeTeamRoster } = require("./normalize");
const { planSeries, seriesCompleteness } = require("./derive");
const { EsclubNotFound, EsclubUnsupported, EsclubProtocolChanged } = require("./errors");

/** esclub's id for League of Legends (the stage's `id_game`). */
const LOL_GAME_ID = "11ef4074-4f9a-9045-9bae-cf64589d421f";
const RESOURCES_TTL_MS = 24 * 60 * 60 * 1000;
const NO_TEAMS_ROSTER_REASON = "roster not in the stage's roster list";
const NO_TEAM_ROW_REASON = "stored team not in the stage's roster list";

const resourcesCache = createTtlCache({ ttlMs: RESOURCES_TTL_MS, maxEntries: 4 });

/** Forget the cached game resources (tests). */
function resetResourcesCache() {
  resourcesCache.clear();
}

/**
 * The counts a sync keeps (stored in EsclubSyncs.summary: counts only).
 * @returns {{ listLengths: number[], seriesListed: number, seriesSkippedComplete: number,
 *   seriesWritten: number, seriesNoTeams: number, gamesWritten: number, pending: number,
 *   failed: number, unmatched: number, teams: number, skipped: Record<string, number> }}
 */
function newSummary() {
  return {
    listLengths: [],
    seriesListed: 0,
    seriesSkippedComplete: 0,
    seriesWritten: 0,
    seriesNoTeams: 0,
    gamesWritten: 0,
    pending: 0,
    failed: 0,
    unmatched: 0,
    teams: 0,
    skipped: {},
  };
}

const skip = (summary, reason) => {
  summary.skipped[reason] = (summary.skipped[reason] || 0) + 1;
};

/**
 * The game resources (champion table), cached 24 h in this process.
 * @param {import("./client").EsclubClient} client
 * @param {typeof defaultRequests} [requests]
 * @returns {Promise<object[]>}
 */
async function getResources(client, requests = defaultRequests) {
  const cached = resourcesCache.get(LOL_GAME_ID);
  if (cached) return cached;
  const { items } = await requests.fetchGameResources(client, { id_game: LOL_GAME_ID });
  resourcesCache.set(LOL_GAME_ID, items);
  return items;
}

/** The series of a stage, in list order (D8): rounds, their groups, a group's series or the round's own. */
async function walkStage(client, stage, requests, summary) {
  const listed = [];
  const seen = new Set();
  const take = async (parentId) => {
    const { items } = await requests.fetchSeriesInParent(client, { id_parent: parentId });
    summary.listLengths.push(items.length);
    for (const item of items) {
      if (seen.has(item.id_serie)) continue;
      seen.add(item.id_serie);
      listed.push(item);
    }
  };
  const { items: rounds } = await requests.fetchRounds(client, { id_event_stage: stage.external_id });
  for (const round of rounds) {
    const { items: groups } = await requests.fetchGroups(client, { id_round: round.id_round });
    if (groups.length === 0) await take(round.id_round);
    else for (const group of groups) await take(group.id_group);
  }
  return listed;
}

const refFromTeamRow = (team) => ({
  externalId: team.external_id,
  externalOrgId: team.external_org_id,
  name: team.name,
  acronym: team.acronym,
  palette: team.colors || null,
});

const startsAtOf = (serie) => {
  const t = serie.time_start_forced ?? serie.time_start_agreed ?? serie.time_start_default ?? null;
  return typeof t === "number" && Number.isFinite(t) ? new Date(t * 1000).toISOString() : null;
};

/** The series row's facts from a listed (or fetched) esclub series. */
function serieFacts(listed, draftType = null) {
  return {
    externalId: listed.id_serie,
    parentType: listed.type_parent,
    number: listed.number,
    esclubStatus: listed.awaiting_status,
    status: normalizeStatus(listed.awaiting_status),
    bestOf: listed.best_of,
    draftType,
    startsAt: startsAtOf(listed),
  };
}

async function writeOne(ctx, { team1 = null, team2 = null, games = [], complete = false, draftType = null }) {
  const { store, tournament, stage, listed, summary, now } = ctx;
  const when = now();
  const result = await store.inTransaction(async (transaction) => {
    const written = await store.writeSeries(
      { tournament, stage, serie: serieFacts(listed, draftType), team1, team2, games, complete, now: when },
      transaction,
    );
    if (!written.unchanged && games.length > 0) {
      for (const team of [team1, team2]) await store.rebuildRoster(team, tournament.id, transaction);
    }
    return written;
  }, summary.syncId);
  if (result.unchanged) {
    summary.seriesSkippedComplete += 1;
    return;
  }
  summary.seriesWritten += 1;
  summary.gamesWritten += result.gamesWritten;
}

/** The mirrored complete games, in the shape seriesCompleteness reads. */
const storedCompleteGames = (mirrored) =>
  ((mirrored && mirrored.games) || [])
    .filter((g) => g.complete)
    .map((g) => ({
      externalMatchId: g.external_match_id,
      number: g.number,
      winner: g.winner,
      blueSideTeam: g.blue_side_team,
      participants: g.participants || {},
    }));

/** matches -> (draft, choices) for each match not stored complete -> normalise -> write. */
async function fetchAndWrite(client, ctx, team1, team2) {
  const { requests, listed, mirrored, summary } = ctx;
  const { items: matches } = await requests.fetchMatches(client, { id_serie: listed.id_serie });
  const storedByMatch = new Map(((mirrored && mirrored.games) || []).map((g) => [g.external_match_id, g]));
  const toFetch = matches.filter((m) => !(storedByMatch.get(m.id_match) || {}).complete);

  const drafts = {};
  const choices = {};
  for (const m of toFetch) {
    let draft;
    try {
      draft = await requests.fetchDraft(client, { id_match: m.id_match });
    } catch (err) {
      if (!(err instanceof EsclubNotFound)) throw err;
      continue; // no draft yet: the game is pending
    }
    drafts[m.id_match] = draft;
    // A blind draft is skipped by the normaliser before it reads the choices.
    if (draft.is_blind) continue;
    choices[m.id_match] = (await requests.fetchDraftChoices(client, { id_match: m.id_match })).items;
  }

  const resources = await ctx.getResources();
  let normalized;
  try {
    normalized = normalizeSeries({
      serie: listed,
      seasonId: ctx.tournament.external_id,
      stageId: ctx.stage.external_id,
      teams: [refFromTeamRow(team1), refFromTeamRow(team2)],
      matches: toFetch,
      drafts,
      choices,
      resources,
    });
  } catch (err) {
    if (!(err instanceof EsclubUnsupported)) throw err;
    skip(summary, err.message);
    debug(`esclub series ${listed.id_serie}: skipped (${err.message})`);
    return;
  }

  const { series, pending, failed } = normalized;
  if (mirrored?.draft_type && mirrored.games?.some((game) => game.complete) && series.draftType && series.draftType !== mirrored.draft_type) {
    throw new EsclubProtocolChanged("series draft type differs from its complete games");
  }
  summary.pending += pending.length;
  summary.failed += failed.length;
  summary.unmatched += series.games.reduce((n, g) => n + g.unmatchedParticipants, 0);
  if (pending.length || failed.length) {
    debug(`esclub series ${listed.id_serie}: ${pending.length} pending, ${failed.length} failed games`);
  }
  const complete = seriesCompleteness({
    series: { status: series.status, bestOf: series.bestOf, games: [...storedCompleteGames(mirrored), ...series.games] },
    pending,
    failed,
  });
  await writeOne(ctx, { team1, team2, games: series.games, complete, draftType: series.draftType });
}

/**
 * One listed series: skip, store as upcoming, or fetch and write (D2, D5-D7).
 * @param {import("./client").EsclubClient} client
 * @param {object} ctx
 * @param {object} ctx.listed the series item from esclub
 * @param {object | null} ctx.mirrored its mirrored row (with games), if any
 * @param {object} ctx.tournament
 * @param {object} ctx.stage
 * @param {Map<string, object>} ctx.teamsByExternal Team rows by roster id
 * @param {Map<string, object>} ctx.teamsById Team rows by id
 * @param {(ids: string[]) => Promise<void>} [ctx.loadTeams] adds rows to both maps
 * @param {() => Promise<object[]>} ctx.getResources
 * @param {object} ctx.store
 * @param {typeof defaultRequests} ctx.requests
 * @param {object} ctx.summary
 * @param {() => Date} ctx.now
 * @returns {Promise<void>}
 */
async function syncOneSeries(client, ctx) {
  const { listed, mirrored, requests, summary, teamsByExternal, teamsById } = ctx;
  summary.seriesListed += 1;
  const plan = planSeries(listed, mirrored);
  if (plan.action === "skip") {
    summary.seriesSkippedComplete += 1;
    return;
  }

  let team1;
  let team2;
  if (!plan.needsMembers) {
    team1 = teamsById.get(mirrored.team1_id);
    team2 = teamsById.get(mirrored.team2_id);
    if (!team1 || !team2) {
      skip(summary, NO_TEAM_ROW_REASON);
      return;
    }
  } else {
    const { rosterIds } = await requests.fetchSerieTeamOrder(client, { id_serie: listed.id_serie });
    if (rosterIds.length < 2) {
      await writeOne(ctx, {});
      summary.seriesNoTeams += 1;
      return;
    }
    if (ctx.loadTeams) await ctx.loadTeams(rosterIds.filter((id) => !teamsByExternal.has(id)));
    team1 = teamsByExternal.get(rosterIds[0]);
    team2 = teamsByExternal.get(rosterIds[1]);
    if (!team1 || !team2) {
      skip(summary, NO_TEAMS_ROSTER_REASON);
      return;
    }
  }

  if (plan.action === "store-upcoming") {
    await writeOne(ctx, { team1, team2 });
    return;
  }
  await fetchAndWrite(client, ctx, team1, team2);
}

const mapBy = (rows, key) => new Map(rows.map((r) => [r[key], r]));

/**
 * Sync one stage: resources, the walk, the stage's teams, then each listed
 * series in list order.
 * @param {import("./client").EsclubClient} client
 * @param {object} args
 * @param {{id: string, external_id: string, region: string, source: string}} args.tournament
 * @param {{id: string, external_id: string}} args.stage
 * @param {object} [args.store]
 * @param {object} [args.summary]
 * @param {typeof defaultRequests} [args.requests]
 * @param {() => Date} [args.now]
 * @returns {Promise<object>} the summary
 */
async function syncStage(client, { tournament, stage, store = defaultStore, summary = newSummary(), requests = defaultRequests, now = () => new Date() }) {
  const resources = await getResources(client, requests);
  const listed = await walkStage(client, stage, requests, summary);
  const { items: rosterRows } = await requests.fetchTeamRosters(client, { id_event_stage: stage.external_id });
  const teamsByExternal = await store.inTransaction(
    (transaction) => store.upsertStageTeams(tournament, rosterRows.map(normalizeTeamRoster), transaction),
    summary.syncId,
  );
  summary.teams = teamsByExternal.size;
  const teamsById = mapBy([...teamsByExternal.values()], "id");
  const mirrored = await store.loadSeriesByExternalIds(listed.map((s) => s.id_serie));

  for (const item of listed) {
    await syncOneSeries(client, {
      listed: item,
      mirrored: mirrored.get(item.id_serie) || null,
      tournament,
      stage,
      teamsByExternal,
      teamsById,
      getResources: async () => resources,
      store,
      requests,
      summary,
      now,
    });
  }
  return summary;
}

/**
 * Sync every stage of a tournament, in creation order, stamping each when done.
 * @param {import("./client").EsclubClient} client
 * @param {object} args
 * @param {string} args.tournamentId
 * @param {object} [args.store]
 * @param {object} [args.summary]
 * @param {typeof defaultRequests} [args.requests]
 * @param {() => Date} [args.now]
 * @returns {Promise<object>} the summary
 */
async function syncTournament(client, { tournamentId, store = defaultStore, summary = newSummary(), requests = defaultRequests, now = () => new Date() }) {
  const found = await store.loadTournamentWithStages(tournamentId);
  if (!found) throw new Error(`tournament ${tournamentId} not found`);
  const { stages, ...tournament } = found;
  for (const stage of stages) {
    await syncStage(client, { tournament, stage, store, summary, requests, now });
    await store.inTransaction((transaction) => store.touchSynced(stage, tournament, now(), transaction), summary.syncId);
  }
  return summary;
}

/**
 * Refresh one series: fetch it for its fresh status, ask for members only if
 * a team is missing (no rosters request: teams come from the stored rows),
 * then the same fetch/normalise/write path as the stage sync.
 * @param {import("./client").EsclubClient} client
 * @param {object} args
 * @param {string} args.seriesId our LeagueSeries id
 * @param {object} [args.store]
 * @param {object} [args.summary]
 * @param {typeof defaultRequests} [args.requests]
 * @param {() => Date} [args.now]
 * @returns {Promise<object>} the summary
 */
async function syncSerie(client, { seriesId, store = defaultStore, summary = newSummary(), requests = defaultRequests, now = () => new Date() }) {
  const row = await store.loadSeriesForRefresh(seriesId);
  if (!row) throw new Error(`series ${seriesId} not found`);
  const { series, stage, tournament, team1, team2, games } = row;
  const listed = await requests.fetchSerie(client, { id_serie: series.external_id });
  const teamRows = [team1, team2].filter(Boolean);
  const teamsByExternal = mapBy(teamRows, "external_id");
  const teamsById = mapBy(teamRows, "id");
  await syncOneSeries(client, {
    listed,
    mirrored: { ...series, games },
    tournament,
    stage,
    teamsByExternal,
    teamsById,
    loadTeams: async (ids) => {
      const found = await store.loadTeamsByExternalIds(tournament.id, ids);
      for (const [ext, team] of found) {
        teamsByExternal.set(ext, team);
        teamsById.set(team.id, team);
      }
    },
    getResources: () => getResources(client, requests),
    store,
    requests,
    summary,
    now,
  });
  return summary;
}

/**
 * Run `work(client, summary)` as the sync `syncRow`: through one esclub
 * session whose every request is counted (cap and daily budget) before it is
 * sent, then close the sync row as succeeded or failed. Never throws.
 * Any stop (protocol change, unavailable, budget, cap, abandoned lock, kill
 * switch) ends the work; what was written before it stays.
 * The shared summary carries a non-enumerable syncId to fence every mirror
 * transaction without putting ownership metadata in the stored summary.
 *
 * @param {{ id: string, kind?: string }} syncRow
 * @param {(client: object, summary: object) => Promise<unknown>} work
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {Function} [options.session] defaults to withEsclubSession
 * @param {object} [options.clientOptions] EsclubClient options (socket class, timings)
 * @param {() => Date} [options.now]
 * @param {typeof defaultState} [options.state] countRequest / finishSync / limitsFromEnv
 * @returns {Promise<{ status: "succeeded" | "failed", error: Error | null, summary: object }>}
 */
async function runSync(syncRow, work, { env = process.env, session = withEsclubSession, clientOptions = {}, now = () => new Date(), state = defaultState } = {}) {
  const summary = newSummary();
  Object.defineProperty(summary, "syncId", { value: syncRow.id });
  const { budget, cap } = state.limitsFromEnv(env);
  let requestCount = 0;
  let error = null;
  try {
    await session((client) => work(client, summary), {
      ...clientOptions,
      env,
      onRequest: async (name, n) => {
        await state.countRequest(syncRow.id, { budget, cap, now: now() });
        requestCount = n;
        console.log(`esclub request ${n} ${name}`);
      },
    });
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
  }
  const status = error ? "failed" : "succeeded";
  try {
    await state.finishSync(syncRow.id, { status, error, summary, now: now() });
  } catch (err) {
    console.error(`esclub sync ${syncRow.id}: could not record the result (${err instanceof Error ? err.constructor.name : "Error"})`);
  }
  const counts = [
    `listed ${summary.seriesListed}`,
    `written ${summary.seriesWritten}`,
    `unchanged ${summary.seriesSkippedComplete}`,
    `no-teams ${summary.seriesNoTeams}`,
    `games ${summary.gamesWritten}`,
    `pending ${summary.pending}`,
    `failed ${summary.failed}`,
    `unmatched ${summary.unmatched}`,
    `skipped ${Object.values(summary.skipped).reduce((a, b) => a + b, 0)}`,
  ].join(" ");
  console.log(
    `esclub sync ${syncRow.kind ?? "?"} ${syncRow.id} ${status}${error ? ` (${error.name})` : ""} requests ${requestCount} ${counts}`,
  );
  return { status, error, summary };
}

module.exports = {
  LOL_GAME_ID,
  newSummary,
  resetResourcesCache,
  getResources,
  syncOneSeries,
  syncStage,
  syncTournament,
  syncSerie,
  runSync,
};
