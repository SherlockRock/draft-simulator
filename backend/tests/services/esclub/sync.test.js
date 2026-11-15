import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sync = require("../../../services/esclub/sync");
const realStore = require("../../../services/esclub/mirrorStore");
const { deriveRoster, teamRowFromRoster } = require("../../../services/esclub/derive");
const N = require("../../../services/esclub/normalize");
const syncState = require("../../../services/esclub/syncState");
const {
  EsclubProtocolChanged,
  EsclubNotFound,
  EsclubUnavailable,
  EsclubBudgetExhausted,
  EsclubRequestCapReached,
  EsclubSyncAbandoned,
  EsclubDisabled,
} = require("../../../services/esclub/errors");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const GROUP_STAGE = "11f1c28a-9fde-7d0a-b076-87e14ee768b0";
const GROUP_ID = "11f1c28a-af0c-b4e2-b788-f87c2ba0a341";
const GROUP_BO3 = "11f1c28a-af6b-071b-93aa-058d0cf4fd47";
const BRACKET_STAGE = "11f18dd0-11ec-ae38-8d96-fb417d38512d";
const BRACKET_ROUND = "11f18dd3-3fb1-e59f-847f-276da07c05f4";
const BRACKET_BO3 = "11f18dd3-3fd7-6e6c-9281-a4e63dbef157";

const SERIES_OF_GROUP = fx("series-of-group.json").reply.series;
const SERIES_OF_ROUND = fx("bracket-bo3/series-of-round.json").reply.series;
const ROSTER_IDS = fx("team-rosters.json").reply.teams.map((t) => t.id_team_roster);
const GROUP_BO3_ROSTERS = fx("group-bo3/members.json").reply.members.map((m) => m.id_parent);
const FIRST_ROSTER = GROUP_BO3_ROSTERS[0];
const SECOND_ROSTER = GROUP_BO3_ROSTERS.find((r) => r !== FIRST_ROSTER);

const T0 = new Date("2026-11-14T12:00:00.000Z");
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- the stub client: serves fixtures by request name and context, records every call ----

const FIXTURE_DIRS = ["group-bo3", "bracket-bo3"];
const matchFiles = new Map(); // id_match -> { dir, n }
for (const dir of FIXTURE_DIRS) {
  for (const n of [0, 1]) {
    matchFiles.set(fx(`${dir}/draft-${n}.json`).reply.drafts[0].id_match, { dir, n });
  }
}
const dirOfSerie = { [GROUP_BO3]: "group-bo3", [BRACKET_BO3]: "bracket-bo3" };

function membersBlock(rosterIds) {
  return {
    members: rosterIds.flatMap((id) =>
      [0, 1].map(() => ({ id_parent: id, id_user: "fake-user-xx", type_parent: "TeamRoster", type_member: "Player", time_start: 1, time_end: null })),
    ),
  };
}

/**
 * @param {object} [o]
 * @param {(name, context, n) => Error | undefined} [o.failOn] throw this instead of serving
 * @param {Record<string, string[]>} [o.membersOf] roster ids (in order) for a series' members reply
 * @param {(name, context, reply) => object} [o.patch] change a served reply
 * @param {(name, n) => Promise<void>} [o.onRequest] awaited before each request, like the real client
 */
function makeStub({ failOn, membersOf = {}, patch, onRequest } = {}) {
  const calls = [];
  const allSeries = [...SERIES_OF_GROUP, ...SERIES_OF_ROUND];
  const stub = {
    calls,
    names: () => calls.map((c) => c.name),
    count: (name) => calls.filter((c) => c.name === name).length,
    async request(name, context) {
      if (onRequest) await onRequest(name, calls.length + 1);
      calls.push({ name, context: clone(context) });
      const failure = failOn && failOn(name, context, calls.length);
      if (failure) throw failure;
      const reply = serve(name, context);
      return patch ? patch(name, context, reply) : reply;
    },
  };

  function serve(name, ctx) {
    switch (name) {
      case "fetch-game-resources":
        return clone(fx("game-resources.json").reply);
      case "fetch-rounds-by-number-next":
        if (ctx.id_event_stage === GROUP_STAGE) return clone(fx("rounds.json").reply);
        if (ctx.id_event_stage === BRACKET_STAGE) return clone(fx("bracket-bo3/round.json").reply);
        break;
      case "fetch-groups-by-number-next":
        return ctx.id_round === GROUP_ID || ctx.id_round === fx("rounds.json").reply.rounds[0].id_round
          ? clone(fx("groups-of-round.json").reply)
          : { groups: [] };
      case "fetch-series-by-number-next":
        if (ctx.id_parent === GROUP_ID) return { series: clone(SERIES_OF_GROUP) };
        if (ctx.id_parent === BRACKET_ROUND) return { series: clone(SERIES_OF_ROUND) };
        break;
      case "fetch-team-rosters-by-event-stage-next":
        return clone(fx("team-rosters.json").reply);
      case "fetch-serie": {
        const item = allSeries.find((s) => s.id_serie === ctx.id_serie);
        if (item) return { series: [clone(item)] };
        break;
      }
      case "fetch-members-by-serie": {
        if (membersOf[ctx.id_serie]) return membersBlock(membersOf[ctx.id_serie]);
        const dir = dirOfSerie[ctx.id_serie];
        if (dir) return clone(fx(`${dir}/members.json`).reply);
        const i = allSeries.findIndex((s) => s.id_serie === ctx.id_serie);
        if (i >= 0) return membersBlock([ROSTER_IDS[i % 10], ROSTER_IDS[(i + 3) % 10]]);
        break;
      }
      case "fetch-matches-by-number-next": {
        const dir = dirOfSerie[ctx.id_serie];
        return dir ? clone(fx(`${dir}/matches.json`).reply) : { matches: [] };
      }
      case "fetch-draft-by-match": {
        const f = matchFiles.get(ctx.id_match);
        if (f) return clone(fx(`${f.dir}/draft-${f.n}.json`).reply);
        break;
      }
      case "fetch-draft-choices-by-match": {
        const f = matchFiles.get(ctx.id_match);
        if (f) return clone(fx(`${f.dir}/choices-${f.n}.json`).reply);
        break;
      }
      default:
    }
    throw new Error(`stub: unexpected request ${name} ${JSON.stringify(ctx)}`);
  }
  return stub;
}

// ---- the in-memory store: the real write rules (seriesAttributes, partitionGames) over Maps ----

function makeFakeStore({ stages } = {}) {
  const st = {
    tournament: {
      id: "t1", name: "League", source: "esclub", external_id: "season-1", region: "na1",
      stages: stages ?? [{ id: "stage-1", external_id: GROUP_STAGE, name: "Regular Season" }],
    },
    series: new Map(), // external_id -> row
    games: new Map(), // external_match_id -> row
    teams: new Map(), // external_id -> row
    names: new Map(),
    players: new Map(), // team id -> rows
    ops: [],
    seq: 0,
    fail: null,
  };
  const id = (p) => `${p}-${++st.seq}`;
  const gamesOf = (seriesId) => [...st.games.values()].filter((g) => g.series_id === seriesId);
  const snapshot = () => ({ series: new Map([...st.series].map(([k, v]) => [k, { ...v }])), games: new Map([...st.games].map(([k, v]) => [k, { ...v }])), players: new Map(st.players), names: new Map(st.names) });

  const store = {
    state: st,
    seriesRow: (ext) => st.series.get(ext),
    async inTransaction(fn) {
      st.ops.push("tx:begin");
      const snap = snapshot();
      try {
        const out = await fn({ id: "tx" });
        st.ops.push("tx:commit");
        return out;
      } catch (e) {
        st.series = snap.series; st.games = snap.games; st.players = snap.players; st.names = snap.names;
        st.ops.push("tx:rollback");
        throw e;
      }
    },
    async loadTournamentWithStages(tid) {
      return tid === st.tournament.id ? clone(st.tournament) : null;
    },
    async loadSeriesByExternalIds(ids) {
      const out = new Map();
      for (const ext of ids) {
        const row = st.series.get(ext);
        if (row) out.set(ext, { ...row, games: gamesOf(row.id).map((g) => ({ ...g })) });
      }
      return out;
    },
    async loadSeriesForRefresh(seriesId) {
      const row = [...st.series.values()].find((s) => s.id === seriesId);
      if (!row) return null;
      const byId = (tid) => [...st.teams.values()].find((t) => t.id === tid) ?? null;
      return {
        series: { ...row },
        stage: st.tournament.stages.find((s) => s.id === row.stage_id),
        tournament: clone({ ...st.tournament, stages: undefined }),
        team1: byId(row.team1_id),
        team2: byId(row.team2_id),
        games: gamesOf(row.id).map((g) => ({ ...g })),
      };
    },
    async loadTeamsByExternalIds(_tid, ids) {
      return new Map(ids.filter((i) => st.teams.has(i)).map((i) => [i, st.teams.get(i)]));
    },
    async upsertStageTeams(tournament, refs) {
      const out = new Map();
      for (const ref of refs) {
        const row = teamRowFromRoster(ref, tournament);
        const prev = st.teams.get(row.external_id);
        const team = { ...row, id: prev ? prev.id : id("team") };
        st.teams.set(row.external_id, team);
        out.set(row.external_id, team);
      }
      return out;
    },
    async writeSeries({ tournament, stage, serie, team1, team2, games = [], complete, now }) {
      if (st.fail && st.fail(serie.externalId)) throw new Error("db failure");
      const existing = st.series.get(serie.externalId) ?? null;
      const attrs = realStore.seriesAttributes(existing, {
        tournamentId: tournament.id, stageId: stage.id, serie,
        team1Id: team1 ? team1.id : null, team2Id: team2 ? team2.id : null, complete, now,
      });
      const row = { ...existing, ...attrs, id: existing ? existing.id : id("series") };
      st.series.set(serie.externalId, row);
      st.ops.push(`write:${serie.externalId}`);
      const { create, update, untouched } = realStore.partitionGames(row.id, gamesOf(row.id), games);
      for (const c of create) st.games.set(c.external_match_id, { ...c, id: id("game") });
      for (const u of update) {
        const prev = [...st.games.values()].find((g) => g.id === u.id);
        st.games.set(prev.external_match_id, { ...u.row, id: u.id });
      }
      return { series: { ...row }, gamesWritten: create.length + update.length, gamesLeftAlone: untouched.length };
    },
    async loadPlayerNames() { return [...st.names.values()]; },
    async upsertPlayerNames(_tid, rows) {
      for (const row of rows) st.names.set(row.player_key, { ...row });
    },
    async loadStageTeamPlayers(tournamentId, stageId) {
      const allTeams = [...st.teams.values()].map((team) => ({ ...team, entries:
        [...st.series.values()].filter((s) => s.tournament_id === tournamentId && [s.team1_id, s.team2_id].includes(team.id))
          .flatMap((s) => gamesOf(s.id).map((g) => ({ teamNumber: s.team1_id === team.id ? 1 : 2, seriesId: s.external_id,
            game: { blueSideTeam: g.blue_side_team, playedAt: g.played_at ?? null, participants: g.participants } }))),
      }));
      const stageTeams = new Set([...st.series.values()].filter((s) => s.stage_id === stageId).flatMap((s) => [s.team1_id, s.team2_id]));
      const allKeys = new Set([...st.games.values()].flatMap((g) => Object.values(g.participants).map((p) => p.playerKey)).filter(Boolean));
      return { teams: allTeams.filter((t) => stageTeams.has(t.id)), allTeams, allKeys };
    },
    async rebuildRoster(team, tournamentId) {
      const mine = [...st.series.values()].filter((s) => s.tournament_id === tournamentId && (s.team1_id === team.id || s.team2_id === team.id));
      const entries = mine.flatMap((s) =>
        gamesOf(s.id).map((g) => ({
          teamNumber: s.team1_id === team.id ? 1 : 2,
          game: { blueSideTeam: g.blue_side_team, playedAt: g.played_at ?? null, participants: g.participants },
        })),
      );
      const rows = deriveRoster(entries, new Map([...st.names.values()].filter((n) => n.game_name !== null).map((n) => [n.player_key, {
        gameName: n.game_name, tagLine: n.tag_line, time: new Date(n.checked_at).getTime(),
      }]))).map((p) => ({ team_id: team.id, ...p }));
      st.players.set(team.id, rows);
      st.ops.push(`roster:${team.external_id}`);
      return rows.length;
    },
    async touchSynced(stage) {
      st.ops.push(`touch:${stage.id}`);
    },
  };
  return store;
}
const ROUND_TRIP = (store) => ({ tournament: { ...store.state.tournament }, stage: store.state.tournament.stages[0] });

async function runStage(store, stub, extra = {}) {
  const summary = sync.newSummary();
  const { tournament, stage } = ROUND_TRIP(store);
  await sync.syncStage(stub, { tournament, stage, store, summary, now: () => T0, ...extra });
  return summary;
}

beforeEach(() => {
  sync.resetResourcesCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const finished = SERIES_OF_GROUP.filter((s) => s.awaiting_status === "Finished");
const upcoming = SERIES_OF_GROUP.filter((s) => s.awaiting_status !== "Finished");

describe("first sync of the fixture league", () => {
  it("sends exactly: resources, the walk, rosters, then per series in list order", async () => {
    const store = makeFakeStore();
    const stub = makeStub();
    const summary = await runStage(store, stub);

    expect(stub.names().slice(0, 5)).toEqual([
      "fetch-game-resources",
      "fetch-rounds-by-number-next",
      "fetch-groups-by-number-next",
      "fetch-series-by-number-next",
      "fetch-team-rosters-by-event-stage-next",
    ]);
    expect(stub.calls[0].context).toEqual({ id_game: sync.LOL_GAME_ID });
    expect(sync.LOL_GAME_ID).toBe("11ef4074-4f9a-9045-9bae-cf64589d421f");
    expect(stub.count("fetch-members-by-serie")).toBe(45);
    expect(stub.count("fetch-matches-by-number-next")).toBe(finished.length);
    expect(stub.count("fetch-draft-by-match")).toBe(2);
    expect(stub.count("fetch-draft-choices-by-match")).toBe(2);
    expect(stub.calls).toHaveLength(5 + 45 + finished.length + 4);
    expect(stub.names().filter((n) => !["fetch-members-by-serie", "fetch-matches-by-number-next", "fetch-draft-by-match", "fetch-draft-choices-by-match"].includes(n))).toHaveLength(5);

    // The group Bo3's requests are contiguous, in this order.
    const at = stub.calls.findIndex((c) => c.name === "fetch-members-by-serie" && c.context.id_serie === GROUP_BO3);
    expect(stub.names().slice(at, at + 6)).toEqual([
      "fetch-members-by-serie",
      "fetch-matches-by-number-next",
      "fetch-draft-by-match",
      "fetch-draft-choices-by-match",
      "fetch-draft-by-match",
      "fetch-draft-choices-by-match",
    ]);
    // Members are asked in list order.
    const memberOrder = stub.calls.filter((c) => c.name === "fetch-members-by-serie").map((c) => c.context.id_serie);
    expect(memberOrder).toEqual(SERIES_OF_GROUP.map((s) => s.id_serie));

    expect(summary.listLengths).toEqual([45]);
    expect(store.state.series.size).toBe(45);
    expect(store.state.teams.size).toBe(10);
  });

  it("stores upcoming series with both teams and no games, and the group Bo3 complete with two games", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub());
    for (const s of upcoming) {
      const row = store.seriesRow(s.id_serie);
      expect(row.status).toBe("upcoming");
      expect(row.team1_id).toBeTruthy();
      expect(row.team2_id).toBeTruthy();
      expect(row.complete).toBe(false);
    }
    const bo3 = store.seriesRow(GROUP_BO3);
    expect(bo3).toMatchObject({ status: "finished", complete: true, parent_type: "Group", best_of: 3, draft_type: expect.any(String) });
    expect(bo3.finished_at).toEqual(T0);
    const games = [...store.state.games.values()].filter((g) => g.series_id === bo3.id);
    expect(games).toHaveLength(2);
    expect(games.every((g) => g.complete)).toBe(true);
    // Finished series with no games are written but not complete.
    const other = finished.find((s) => s.id_serie !== GROUP_BO3);
    expect(store.seriesRow(other.id_serie)).toMatchObject({ complete: false, status: "finished" });
  });

  it("a second sync sends no members and nothing for the complete group Bo3", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub());
    const again = makeStub();
    const summary = await runStage(store, again);
    expect(again.count("fetch-members-by-serie")).toBe(0);
    expect(again.calls.some((c) => JSON.stringify(c.context).includes(GROUP_BO3))).toBe(false);
    expect(again.count("fetch-draft-by-match")).toBe(0);
    // Resources are cached; the walk is 4 requests; the 25 finished series without games are asked again.
    expect(again.count("fetch-game-resources")).toBe(0);
    expect(again.count("fetch-matches-by-number-next")).toBe(finished.length - 1);
    expect(again.calls).toHaveLength(4 + finished.length - 1);
    expect(summary.seriesSkippedComplete).toBe(1);
  });
});

describe("team order", () => {
  it("team 1 is the members reply's first roster, in the series row and in blueSideTeam", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub());
    const bo3 = store.seriesRow(GROUP_BO3);
    expect(bo3.team1_id).toBe(store.state.teams.get(FIRST_ROSTER).id);
    expect(bo3.team2_id).toBe(store.state.teams.get(SECOND_ROSTER).id);

    const resources = fx("game-resources.json").reply.resources;
    const drafts = {};
    const choices = {};
    for (const n of [0, 1]) {
      const d = fx(`group-bo3/draft-${n}.json`).reply.drafts[0];
      drafts[d.id_match] = d;
      choices[d.id_match] = fx(`group-bo3/choices-${n}.json`).reply.choices;
    }
    const refs = [FIRST_ROSTER, SECOND_ROSTER].map((id) => N.normalizeTeamRoster(fx("team-rosters.json").reply.teams.find((t) => t.id_team_roster === id)));
    const expected = N.normalizeSeries({
      serie: SERIES_OF_GROUP.find((s) => s.id_serie === GROUP_BO3), seasonId: "x", stageId: "y", teams: refs,
      matches: fx("group-bo3/matches.json").reply.matches, drafts, choices, resources,
    }).series.games;
    for (const g of expected) {
      expect(store.state.games.get(g.externalMatchId).blue_side_team).toBe(g.blueSideTeam);
    }
  });

  it("a reversed members reply flips team 1 and every blueSideTeam", async () => {
    const a = makeFakeStore();
    await runStage(a, makeStub());
    const b = makeFakeStore();
    await runStage(b, makeStub({ membersOf: { [GROUP_BO3]: [SECOND_ROSTER, FIRST_ROSTER] } }));
    expect(b.seriesRow(GROUP_BO3).team1_id).toBe(b.state.teams.get(SECOND_ROSTER).id);
    for (const [match, row] of a.state.games) {
      expect(b.state.games.get(match).blue_side_team).toBe(3 - row.blue_side_team);
    }
  });

  it("a series whose members reply has one roster is stored without teams and asked again, never after it has two", async () => {
    const store = makeFakeStore();
    const X = finished.find((s) => s.id_serie !== GROUP_BO3).id_serie;
    const one = makeStub({ membersOf: { [X]: [ROSTER_IDS[0]] } });
    const summary = await runStage(store, one);
    expect(store.seriesRow(X)).toMatchObject({ team1_id: null, team2_id: null, status: "finished", complete: false });
    expect([...store.state.games.values()].filter((g) => g.series_id === store.seriesRow(X).id)).toHaveLength(0);
    expect(one.calls.some((c) => c.name === "fetch-matches-by-number-next" && c.context.id_serie === X)).toBe(false);
    expect(summary.seriesNoTeams).toBe(1);

    const second = makeStub({ membersOf: { [X]: [ROSTER_IDS[0]] } });
    await runStage(store, second);
    expect(second.calls.filter((c) => c.name === "fetch-members-by-serie")).toHaveLength(1);
    expect(store.seriesRow(X).team1_id).toBeNull();

    const third = makeStub({ membersOf: { [X]: [ROSTER_IDS[1], ROSTER_IDS[2]] } });
    await runStage(store, third);
    expect(third.calls.filter((c) => c.name === "fetch-members-by-serie").map((c) => c.context.id_serie)).toEqual([X]);
    expect(store.seriesRow(X).team1_id).toBe(store.state.teams.get(ROSTER_IDS[1]).id);

    const fourth = makeStub();
    await runStage(store, fourth);
    expect(fourth.count("fetch-members-by-serie")).toBe(0);
    // And the teams never change afterwards.
    expect(store.seriesRow(X).team2_id).toBe(store.state.teams.get(ROSTER_IDS[2]).id);
  });

  it("an upcoming series costs one request (members) the first time and none after", async () => {
    const store = makeFakeStore();
    const U = upcoming[0].id_serie;
    const first = makeStub();
    await runStage(store, first);
    expect(first.calls.filter((c) => JSON.stringify(c.context).includes(U)).map((c) => c.name)).toEqual(["fetch-members-by-serie"]);
    const second = makeStub();
    await runStage(store, second);
    expect(second.calls.some((c) => JSON.stringify(c.context).includes(U))).toBe(false);
    expect(store.seriesRow(U)).toMatchObject({ status: "upcoming", team1_id: expect.any(String) });
  });
});

describe("games: incomplete is rewritten, complete is never fetched again", () => {
  const MATCHES = fx("group-bo3/matches.json").reply.matches;
  const GAME0 = MATCHES[0].id_match;
  const GAME1 = MATCHES[1].id_match;
  const noWinnerForGame1 = (name, ctx, reply) => {
    if (name !== "fetch-matches-by-number-next" || ctx.id_serie !== GROUP_BO3) return reply;
    const lol = reply.matches[1].config.integrations.find((i) => i.LeagueOfLegends).LeagueOfLegends;
    lol.is_done = false;
    lol.winner_side = null;
    return reply;
  };
  const noDraftForGame1 = (name, ctx, reply) =>
    name === "fetch-draft-by-match" && ctx.id_match === GAME1 ? { drafts: [] } : reply;

  it("rejects a new standard game against frozen fearless games before opening its transaction", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub({ patch: noWinnerForGame1 }));
    const before = { ...store.seriesRow(GROUP_BO3) };
    const transaction = vi.spyOn(store, "inTransaction");
    const second = makeStub({ patch: (name, context, reply) => {
      if (name === "fetch-draft-by-match" && context.id_match === GAME1) reply.drafts[0].type_fearless = "None";
      return reply;
    } });
    await expect(sync.syncSerie(second, { seriesId: before.id, store, now: () => T0 })).rejects.toBeInstanceOf(EsclubProtocolChanged);
    expect(transaction).not.toHaveBeenCalled();
    expect(second.calls.some((call) => call.context.id_match === GAME0)).toBe(false);
    expect(second.calls.filter((call) => call.name === "fetch-draft-by-match").map((call) => call.context.id_match)).toEqual([GAME1]);
    expect(store.seriesRow(GROUP_BO3)).toEqual(before);
  });

  it("rewrites a game without a winner until it has one, then freezes it", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub({ patch: noWinnerForGame1 }));
    expect(store.state.games.get(GAME1)).toMatchObject({ winner: null, complete: false });
    expect(store.state.games.get(GAME0).complete).toBe(true);
    expect(store.seriesRow(GROUP_BO3).complete).toBe(false);

    const second = makeStub();
    await runStage(store, second);
    const draftIds = second.calls.filter((c) => c.name === "fetch-draft-by-match").map((c) => c.context.id_match);
    const choiceIds = second.calls.filter((c) => c.name === "fetch-draft-choices-by-match").map((c) => c.context.id_match);
    expect(draftIds).toEqual([GAME1]);
    expect(choiceIds).toEqual([GAME1]);
    expect(store.state.games.get(GAME1)).toMatchObject({ winner: expect.stringMatching(/blue|red/), complete: true });
    expect(store.seriesRow(GROUP_BO3).complete).toBe(true);

    const third = makeStub();
    await runStage(store, third);
    expect(third.count("fetch-draft-by-match")).toBe(0);
    expect(third.calls.some((c) => JSON.stringify(c.context).includes(GROUP_BO3))).toBe(false);
  });

  it("never overwrites a stored complete game even if esclub sends different data", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub({ patch: noWinnerForGame1 }));
    const before = { ...store.state.games.get(GAME0) };
    // Game 0 is complete; a later reply that would change it is not even asked for.
    const second = makeStub();
    await runStage(store, second);
    expect(second.calls.some((c) => c.context.id_match === GAME0)).toBe(false);
    expect(store.state.games.get(GAME0)).toEqual(before);
  });

  it("a game whose draft is not there yet is left out, its series stays incomplete and is fetched again", async () => {
    const store = makeFakeStore();
    const first = makeStub({ patch: noDraftForGame1 });
    const summary = await runStage(store, first);
    expect(store.state.games.has(GAME1)).toBe(false);
    expect(store.state.games.has(GAME0)).toBe(true);
    expect(store.seriesRow(GROUP_BO3).complete).toBe(false);
    expect(summary.pending).toBe(1);
    // No draft: the choices of that game are not asked for.
    expect(first.calls.filter((c) => c.name === "fetch-draft-choices-by-match").map((c) => c.context.id_match)).toEqual([GAME0]);

    const second = makeStub();
    await runStage(store, second);
    expect(second.calls.filter((c) => c.name === "fetch-draft-by-match").map((c) => c.context.id_match)).toEqual([GAME1]);
    expect(store.seriesRow(GROUP_BO3).complete).toBe(true);
  });
});

describe("rosters", () => {
  it("rebuilds both teams' rosters inside the series' write, after its games", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub());
    const ops = store.state.ops;
    const w = ops.indexOf(`write:${GROUP_BO3}`);
    expect(ops[w - 1]).toBe("tx:begin");
    expect(ops.slice(w + 1, w + 4)).toEqual([`roster:${FIRST_ROSTER}`, `roster:${SECOND_ROSTER}`, "tx:commit"]);
    const first = store.state.players.get(store.state.teams.get(FIRST_ROSTER).id);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((p) => /^Player\d+$/.test(p.gameName))).toBe(true);
    // Series with no games don't rebuild anything.
    expect(ops.filter((o) => o.startsWith("roster:"))).toHaveLength(2);
  });

  it("leaves players with no Riot ID off (the bracket Bo3's IDs are null)", async () => {
    const store = makeFakeStore({ stages: [{ id: "stage-b", external_id: BRACKET_STAGE, name: "Playoffs" }] });
    await runStage(store, makeStub());
    const bracketOnly = "11f16c2e-c478-f50c-bf60-8369c88ac727";
    expect(store.state.players.get(store.state.teams.get(bracketOnly).id)).toEqual([]);
  });
});

describe("the bracket (series under a round with no groups)", () => {
  it("walks rounds -> groups (none) -> series of the round, and goes through the same path", async () => {
    const store = makeFakeStore({ stages: [{ id: "stage-b", external_id: BRACKET_STAGE, name: "Playoffs" }] });
    const stub = makeStub();
    const summary = await runStage(store, stub);
    expect(stub.names().slice(0, 5)).toEqual([
      "fetch-game-resources",
      "fetch-rounds-by-number-next",
      "fetch-groups-by-number-next",
      "fetch-series-by-number-next",
      "fetch-team-rosters-by-event-stage-next",
    ]);
    expect(stub.calls[3].context.id_parent).toBe(BRACKET_ROUND);
    expect(summary.listLengths).toEqual([SERIES_OF_ROUND.length]);
    expect(stub.count("fetch-members-by-serie")).toBe(SERIES_OF_ROUND.length);
    const row = store.seriesRow(BRACKET_BO3);
    expect(row.parent_type).toBe("Round");
    expect(row.team1_id).toBe(store.state.teams.get(fx("bracket-bo3/members.json").reply.members[0].id_parent).id);
    expect(store.state.games.size).toBe(2);
    expect(row.complete).toBe(true);
  });
});

describe("skips that do not stop the sync", () => {
  it("a roster outside the stage's list skips that series with a reason and writes nothing for it", async () => {
    const store = makeFakeStore();
    const X = SERIES_OF_GROUP[0].id_serie;
    const summary = await runStage(store, makeStub({ membersOf: { [X]: [ROSTER_IDS[0], "not-in-the-stage"] } }));
    expect(store.seriesRow(X)).toBeUndefined();
    expect(summary.skipped).toEqual({ "roster not in the stage's roster list": 1 });
    expect(store.state.series.size).toBe(44);
  });

  it("an unsupported draft type skips the series with its reason and the sync carries on", async () => {
    const store = makeFakeStore();
    const summary = await runStage(store, makeStub({
      patch: (name, ctx, reply) => {
        if (name === "fetch-draft-by-match") reply.drafts[0].type_fearless = "SoftPick";
        return reply;
      },
    }));
    expect(store.seriesRow(GROUP_BO3)).toBeUndefined();
    const reasons = Object.keys(summary.skipped);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/not imported/);
    expect(store.seriesRow(SERIES_OF_GROUP[44].id_serie)).toBeDefined();
    expect(store.state.series.size).toBe(44);
  });
});

describe("a stop ends the sync; the series in hand writes nothing", () => {
  const thirdMatchesCall = () => {
    let seen = 0;
    return (name) => {
      if (name !== "fetch-matches-by-number-next") return undefined;
      seen += 1;
      return seen === 3 ? new EsclubProtocolChanged("a reply changed shape") : undefined;
    };
  };

  it("EsclubProtocolChanged on the third fetched series: skips it and continues", async () => {
    const store = makeFakeStore();
    const stub = makeStub({ failOn: thirdMatchesCall() });
    const summary = await runStage(store, stub);
    expect(summary.seriesFailed).toBe(1);
    expect(summary.skipped.EsclubProtocolChanged).toBe(1);
    const thirdFinished = finished[2].id_serie;
    expect([...store.state.series.keys()]).toEqual(SERIES_OF_GROUP.filter((s) => s.id_serie !== thirdFinished).map((s) => s.id_serie));
    expect(store.seriesRow(thirdFinished)).toBeUndefined();
  });

  it("EsclubUnavailable stops the same way", async () => {
    const store = makeFakeStore();
    const failOn = (name, ctx, n) => (n === 8 ? new EsclubUnavailable("socket closed") : undefined);
    await expect(runStage(store, makeStub({ failOn }))).rejects.toBeInstanceOf(EsclubUnavailable);
    expect([...store.state.series.keys()]).toEqual([SERIES_OF_GROUP[0].id_serie]);
  });

  it("a database failure inside a series' write rolls that series back (games and rosters with it)", async () => {
    const store = makeFakeStore();
    store.state.fail = (ext) => ext === GROUP_BO3;
    await expect(runStage(store, makeStub())).rejects.toThrow("db failure");
    expect(store.seriesRow(GROUP_BO3)).toBeUndefined();
    expect(store.state.games.size).toBe(0);
    expect(store.state.ops.at(-1)).toBe("tx:rollback");
  });
});

describe("runSync", () => {
  const syncRow = { id: "sync-1", kind: "league" };
  const ENV = { ESCLUB_SYNC_ENABLED: "true" };

  it("passes ownership to a delayed series transaction and fences A after B completes it", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub({ patch: (name, context, reply) => {
      if (name === "fetch-matches-by-number-next" && context.id_serie === GROUP_BO3) {
        const integration = reply.matches[1].config.integrations.find((item) => item.LeagueOfLegends).LeagueOfLegends;
        integration.winner_side = null;
        integration.is_done = false;
      }
      return reply;
    } }));
    const target = GROUP_BO3;
    const before = { ...store.seriesRow(target) };
    const transact = store.inTransaction.bind(store);
    let release;
    let paused;
    const gate = new Promise((resolve) => { release = resolve; });
    const reached = new Promise((resolve) => { paused = resolve; });
    let abandoned = false;
    store.inTransaction = async (callback, syncId) => {
      if (syncId !== "sync-B") {
        paused();
        await gate;
        if (abandoned && syncId === "sync-A") throw new EsclubSyncAbandoned("sync no longer running");
      }
      return transact(callback);
    };
    const resultPromise = sync.runSync({ id: "sync-A" }, async (client, summary) => {
      await sync.syncOneSeries(client, {
        ...ROUND_TRIP(store),
        listed: { ...fx("group-bo3/serie.json").reply.series[0], awaiting_status: upcoming[0].awaiting_status },
        mirrored: before,
        teamsByExternal: store.state.teams,
        teamsById: new Map([...store.state.teams.values()].map((team) => [team.id, team])),
        requests: {},
        store,
        summary,
        now: () => T0,
      });
    }, { env: ENV, session: async (work) => work(makeStub()), state: { limitsFromEnv: () => ({ budget: 2000, cap: 400 }), finishSync: vi.fn().mockResolvedValue(false) } });
    await reached;
    abandoned = true;
    const successorResult = await sync.runSync({ id: "sync-B" }, async (client, summary) => {
      await sync.syncSerie(client, { seriesId: before.id, store, summary, now: () => T0 });
    }, { env: ENV, session: async (work) => work(makeStub()), state: { limitsFromEnv: () => ({ budget: 2000, cap: 400 }), finishSync: vi.fn().mockResolvedValue(true) } });
    expect(successorResult.status).toBe("succeeded");
    const successor = { ...store.seriesRow(target) };
    expect(successor).toMatchObject({ complete: true, status: "finished" });
    const writesBefore = store.state.ops.length;
    release();
    const result = await resultPromise;
    expect(result.error).toBeInstanceOf(EsclubSyncAbandoned);
    expect(result.status).toBe("failed");
    expect(store.seriesRow(target)).toEqual(successor);
    expect(store.state.ops).toHaveLength(writesBefore);
    expect(JSON.stringify(result.summary)).not.toContain("sync-A");
  });

  it("logs a finish failure's class and sync id, never its raw message", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    await sync.runSync(syncRow, async () => {}, { env: ENV, session: async (work) => work({}), state: { limitsFromEnv: () => ({ budget: 2000, cap: 400 }), finishSync: vi.fn().mockRejectedValue(new TypeError("PRIVATE_ERROR_SENTINEL Player99#T99")) } });
    expect(logger.mock.calls.flat().join(" ")).toContain("TypeError");
    expect(logger.mock.calls.flat().join(" ")).toContain(syncRow.id);
    expect(logger.mock.calls.flat().join(" ")).not.toMatch(/PRIVATE_ERROR_SENTINEL|Player99/);
  });

  function harness({ countRequest, stubOptions = {} } = {}) {
    const store = makeFakeStore();
    const state = {
      limitsFromEnv: syncState.limitsFromEnv,
      countRequest: vi.fn(countRequest ?? (async () => ({}))),
      finishSync: vi.fn(async () => true),
    };
    let stub;
    const session = async (fn, options) => {
      stub = makeStub({ ...stubOptions, onRequest: options.onRequest });
      return fn(stub);
    };
    const run = () => sync.runSync(syncRow, async (client, summary) => {
      const { tournament, stage } = ROUND_TRIP(store);
      await sync.syncStage(client, { tournament, stage, store, summary, now: () => T0 });
    }, { env: ENV, session, store, now: () => T0, state });
    return { store, state, run, stub: () => stub };
  }

  it("counts every request before it is sent, with the budget and cap from the environment, and finishes succeeded", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.status).toBe("succeeded");
    expect(result.error).toBeNull();
    expect(result.summary.listLengths).toEqual([45]);
    expect(h.state.countRequest).toHaveBeenCalledTimes(h.stub().calls.length);
    expect(h.state.countRequest).toHaveBeenCalledWith("sync-1", { budget: 2000, cap: 400, now: T0 });
    expect(h.state.finishSync).toHaveBeenCalledWith("sync-1", { status: "succeeded", error: null, summary: result.summary, now: T0 });
  });

  it.each([
    ["budget", () => new EsclubBudgetExhausted("daily budget spent"), EsclubBudgetExhausted],
    ["cap", () => new EsclubRequestCapReached("sync cap"), EsclubRequestCapReached],
    ["abandoned", () => new EsclubSyncAbandoned("taken over"), EsclubSyncAbandoned],
  ])("a %s stop from onRequest ends the sync: earlier series stay, the one in hand writes nothing, nothing is sent", async (_n, make, Cls) => {
    // Calls: 5 walk requests, then members of series 0 (6th), its matches (7th), members of series 1 (8th: refused).
    let n = 0;
    const h = harness({
      countRequest: async () => {
        n += 1;
        if (n === 8) throw make();
      },
    });
    const result = await h.run();
    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(Cls);
    expect(h.stub().calls).toHaveLength(7);
    expect([...h.store.state.series.keys()]).toEqual([SERIES_OF_GROUP[0].id_serie]);
    expect(h.state.finishSync).toHaveBeenCalledTimes(1);
    const [, arg] = h.state.finishSync.mock.calls[0];
    expect(arg.status).toBe("failed");
    expect(arg.error).toBeInstanceOf(Cls);
    expect(arg.summary.seriesWritten).toBe(1);
  });

  it("some failed series finish succeeded with counts and no writes for those series", async () => {
    const h = harness({ stubOptions: { failOn: (name) => (name === "fetch-draft-by-match" ? new EsclubProtocolChanged("bad draft") : undefined) } });
    const result = await h.run();
    expect(result).toMatchObject({ status: "succeeded", error: null });
    expect(result.summary.seriesFailed).toBeGreaterThan(0);
    expect(h.state.finishSync.mock.calls[0][1].error).toBe(result.error);
    expect(h.store.seriesRow(GROUP_BO3)).toBeUndefined();
  });

  it("never throws, even if finishing the sync fails", async () => {
    const h = harness();
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.state.finishSync.mockRejectedValue(new Error("db down"));
    await expect(h.run()).resolves.toMatchObject({ status: "succeeded" });
  });

  it("logs one line per sync and one per request, with counts and no reply content", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    await h.run();
    const lines = log.mock.calls.map((c) => c.join(" "));
    const perSync = lines.filter((l) => l.includes("sync-1"));
    expect(perSync).toHaveLength(1);
    expect(perSync[0]).toMatch(/league/);
    expect(perSync[0]).toMatch(/succeeded/);
    expect(lines.filter((l) => /^esclub request \d+ /.test(l))).toHaveLength(h.stub().calls.length);
    const all = lines.join("\n");
    expect(all).not.toMatch(/Player\d|fake-user|id_oauth|playerKey/);
  });

  it("with the kill switch off, the real session refuses before any socket is built and nothing is sent", async () => {
    const constructed = [];
    class FakeWS {
      constructor(url) {
        constructed.push(url);
      }
    }
    const state = {
      limitsFromEnv: syncState.limitsFromEnv,
      countRequest: vi.fn(),
      finishSync: vi.fn(async () => true),
    };
    const work = vi.fn();
    const result = await sync.runSync(syncRow, work, { env: {}, clientOptions: { WebSocketImpl: FakeWS }, state, now: () => T0 });
    expect(result.status).toBe("failed");
    expect(result.error).toBeInstanceOf(EsclubDisabled);
    expect(constructed).toHaveLength(0);
    expect(work).not.toHaveBeenCalled();
    expect(state.countRequest).not.toHaveBeenCalled();
    expect(state.finishSync).toHaveBeenCalledWith("sync-1", expect.objectContaining({ status: "failed" }));
  });
});

describe("syncTournament", () => {
  it("syncs every stage in creation order, then stamps each", async () => {
    const store = makeFakeStore({
      stages: [
        { id: "stage-1", external_id: GROUP_STAGE, name: "Regular Season" },
        { id: "stage-2", external_id: BRACKET_STAGE, name: "Playoffs" },
      ],
    });
    const stub = makeStub();
    const summary = sync.newSummary();
    await sync.syncTournament(stub, { tournamentId: "t1", store, summary, now: () => T0 });
    const rounds = stub.calls.filter((c) => c.name === "fetch-rounds-by-number-next").map((c) => c.context.id_event_stage);
    expect(rounds).toEqual([GROUP_STAGE, BRACKET_STAGE]);
    expect(summary.listLengths).toEqual([45, 2]);
    expect(store.state.ops.filter((o) => o.startsWith("touch:"))).toEqual(["touch:stage-1", "touch:stage-2"]);
  });

  it("fails for a tournament that is not there, before any request", async () => {
    const stub = makeStub();
    await expect(sync.syncTournament(stub, { tournamentId: "nope", store: makeFakeStore(), summary: sync.newSummary() })).rejects.toThrow(/not found/);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("syncSerie", () => {
  const MATCHES = fx("group-bo3/matches.json").reply.matches;
  const GAME1 = MATCHES[1].id_match;

  async function incompleteBo3Store() {
    const store = makeFakeStore();
    await runStage(store, makeStub({
      patch: (name, ctx, reply) => {
        if (name === "fetch-matches-by-number-next" && ctx.id_serie === GROUP_BO3) {
          const lol = reply.matches[1].config.integrations.find((i) => i.LeagueOfLegends).LeagueOfLegends;
          lol.is_done = false;
          lol.winner_side = null;
        }
        return reply;
      },
    }));
    return store;
  }

  it("asks for the serie, its matches and only the incomplete game; no members, no rosters", async () => {
    const store = await incompleteBo3Store();
    const stub = makeStub();
    const summary = sync.newSummary();
    await sync.syncSerie(stub, { seriesId: store.seriesRow(GROUP_BO3).id, store, summary, now: () => T0 });
    expect(stub.names()).toEqual([
      "fetch-serie",
      "fetch-matches-by-number-next",
      "fetch-draft-by-match",
      "fetch-draft-choices-by-match",
    ]);
    expect(stub.calls[3].context.id_match).toBe(GAME1);
    expect(store.seriesRow(GROUP_BO3).complete).toBe(true);
    expect(store.state.games.get(GAME1).complete).toBe(true);
  });

  it("asks for members only when a team is missing, and finds the teams from stored rows", async () => {
    const store = makeFakeStore();
    const X = finished.find((s) => s.id_serie !== GROUP_BO3).id_serie;
    await runStage(store, makeStub({ membersOf: { [X]: [ROSTER_IDS[0]] } }));
    const stub = makeStub();
    await sync.syncSerie(stub, { seriesId: store.seriesRow(X).id, store, summary: sync.newSummary(), now: () => T0 });
    expect(stub.names().filter((n) => n !== "fetch-game-resources")).toEqual(["fetch-serie", "fetch-members-by-serie", "fetch-matches-by-number-next"]);
    expect(store.seriesRow(X).team1_id).toBe(store.state.teams.get(ROSTER_IDS[i0(X)]).id);
  });

  it("costs one request for a complete series (the fresh status) and nothing else", async () => {
    const store = makeFakeStore();
    await runStage(store, makeStub());
    const stub = makeStub();
    await sync.syncSerie(stub, { seriesId: store.seriesRow(GROUP_BO3).id, store, summary: sync.newSummary(), now: () => T0 });
    expect(stub.names().filter((n) => n !== "fetch-game-resources")).toEqual(["fetch-serie"]);
  });

  it("fails for a series that is not there, before any request", async () => {
    const stub = makeStub();
    await expect(sync.syncSerie(stub, { seriesId: "nope", store: makeFakeStore(), summary: sync.newSummary() })).rejects.toThrow(/not found/);
    expect(stub.calls).toHaveLength(0);
  });
});

// Team 1 of series X in the synthetic members (index pair (i, i+3)).
function i0(serieId) {
  const i = [...SERIES_OF_GROUP, ...SERIES_OF_ROUND].findIndex((s) => s.id_serie === serieId);
  return i % 10;
}

describe("resources", () => {
  it("are fetched once and cached across syncs until reset", async () => {
    const a = makeStub();
    await runStage(makeFakeStore(), a);
    const b = makeStub();
    await runStage(makeFakeStore(), b);
    expect(a.count("fetch-game-resources")).toBe(1);
    expect(b.count("fetch-game-resources")).toBe(0);
    sync.resetResourcesCache();
    const c = makeStub();
    await runStage(makeFakeStore(), c);
    expect(c.count("fetch-game-resources")).toBe(1);
  });
});


describe("series isolation boundaries", () => {
  it.each([EsclubProtocolChanged, EsclubNotFound])("retries a skipped series after %s", async (ErrorClass) => {
    const store = makeFakeStore();
    const stub = makeStub({ failOn: (name, ctx) => name === "fetch-members-by-serie" && ctx.id_serie === GROUP_BO3 ? new ErrorClass("series unavailable shape") : undefined });
    const summary = await runStage(store, stub);
    expect(summary.seriesFailed).toBe(1);
    expect(store.seriesRow(GROUP_BO3)).toBeUndefined();
    const retry = await runStage(store, makeStub());
    expect(retry.seriesFailed).toBe(0);
    expect(store.seriesRow(GROUP_BO3)).toBeDefined();
  });
  it("fails when every listed series fails", async () => {
    const store = makeFakeStore();
    const summary = sync.newSummary();
    await expect(runStage(store, makeStub({ failOn: (name) => name === "fetch-members-by-serie" ? new EsclubNotFound("no series") : undefined }), { summary })).rejects.toThrow("all listed series failed");
    expect(summary.seriesFailed).toBe(SERIES_OF_GROUP.length);
    expect(store.state.series.size).toBe(0);
  });
  it.each(["fetch-game-resources", "fetch-rounds-by-number-next", "fetch-team-rosters-by-event-stage-next"])("keeps %s protocol failures fatal", async (request) => {
    await expect(runStage(makeFakeStore(), makeStub({ failOn: (name) => name === request ? new EsclubProtocolChanged("global shape") : undefined }))).rejects.toThrow("global shape");
  });
});


it("logs protocol messages without putting them into the summary", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  const state = { limitsFromEnv: () => ({ budget: 100, cap: 25 }), finishSync: vi.fn() };
  const error = new EsclubProtocolChanged("esclub: fake-field is not an array (got null)");
  const result = await sync.runSync({ id: "fake-sync" }, async () => { throw error; }, {
    session: async (work) => work({}), state,
  });
  expect(errorLog).toHaveBeenCalledWith(`esclub sync fake-sync: EsclubProtocolChanged: ${error.message}`);
  expect(JSON.stringify(result.summary)).not.toContain(error.message);
});
