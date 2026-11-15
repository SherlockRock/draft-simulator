import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import {
  EsclubSyncSummarySchema,
  EsclubTeamViewSchema,
  EsclubJoinedResponseSchema,
  EsclubActionResponseSchema,
} from "../../../packages/shared-types/src/schemas.ts";

// Privacy (S2 D11): no esclub response may carry a player key, a Riot ID,
// a participant list, substitution data, member data or requested_by.

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const Tournament = require("../../models/Tournament");
const LeagueStage = require("../../models/LeagueStage");
const LeagueSeries = require("../../models/LeagueSeries");
const LeagueGame = require("../../models/LeagueGame");
const EsclubSync = require("../../models/EsclubSync");
const syncState = require("../../services/esclub/syncState");
const syncEngine = require("../../services/esclub/sync");
const addLeagueService = require("../../services/esclub/addLeague");

function buildApp() {
  const routePath = require.resolve("../../routes/esclub");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/esclub", require("../../routes/esclub"));
  return app;
}

const TID = "44444444-4444-4444-8444-444444444444";
const SID = "55555555-5555-4555-8555-555555555555";
const YID = "66666666-6666-4666-8666-666666666666";
const STAGE = "77777777-7777-4777-8777-777777777777";
const TEAM_A = "88888888-8888-4888-8888-888888888888";
const TEAM_B = "99999999-9999-4999-8999-999999999999";

const FORBIDDEN_KEYS = [
  "playerKey",
  "player_key",
  "game_name",
  "tag_line",
  "checked_at",
  "id_oauth_external",
  "accountKey",
  "LeaguePlayerNames",
  "id_oauth_riot",
  "gameName",
  "tagLine",
  "participants",
  "substitutions",
  "unmatched_participants",
  "requested_by",
  "requestedBy",
  "error_message",
  "id_user",
  "type_member",
  "memberRole",
  "via",
];
const FORBIDDEN_VALUES = [
  "PLAYERKEY-ALPHA",
  "PLAYERKEY-BRAVO",
  "oauth-riot-ALPHA",
  "Player01",
  "T01",
  "Player02",
  "T02",
  "esclub-user-9",
  "requester-7",
  "sub-player-text",
  "MEMBER-ROLE-SENTINEL",
  "SYNTHETIC-LINKED-NAME",
  "SYNTHETIC-LINKED-TAG",
  "synthetic-discord-id",
  "synthetic-discord-name",
];

const dirtyLinked = { player_key: "PLAYERKEY-ALPHA", game_name: "SYNTHETIC-LINKED-NAME", tag_line: "SYNTHETIC-LINKED-TAG", checked_at: "2026-11-15T12:00:00Z" };
const dirtyMember = { id_user: "esclub-user-9", type_member: "MEMBER-ROLE-SENTINEL", ...dirtyLinked, LeaguePlayerNames: [dirtyLinked] };

// Rows as Sequelize would hand them back if every column had been loaded:
// the route must not forward any of the player data on them.
const dirtyParticipants = {
  Ahri: {
    lane: "mid",
    playerKey: "PLAYERKEY-ALPHA",
    id_oauth_riot: "oauth-riot-ALPHA",
    gameName: "Player01",
    tagLine: "T01",
    id_user: "esclub-user-9",
    ...dirtyMember,
  },
  Zed: {
    lane: null,
    playerKey: "PLAYERKEY-BRAVO",
    gameName: "Player02",
    tagLine: "T02",
  },
};

const dirtyGame = {
  series_id: SID,
  number: 1,
  played_at: new Date("2026-11-20T18:10:00Z"),
  picks: ["Ahri", "Zed"],
  first_pick: "blue",
  blue_side_team: 1,
  winner: "blue",
  complete: true,
  participants: dirtyParticipants,
  substitutions: [{ gameName: "sub-player-text", playerKey: "PLAYERKEY-ALPHA" }],
  unmatched_participants: 1,
  ...dirtyMember,
};

const team = (id, name) => ({
  id,
  name,
  acronym: "AAA",
  colors: {
    primary: "#111111",
    secondary: "eeeeee",
    private: { playerKey: "PLAYERKEY-ALPHA", ...dirtyMember },
  },
  owner_id: "requester-7",
  ...dirtyMember,
});

const dirtySeries = {
  id: SID,
  external_id: "ext-serie-1",
  tournament_id: TID,
  stage_id: STAGE,
  number: 1,
  starts_at: null,
  status: "finished",
  complete: true,
  best_of: 3,
  draft_type: "fearless",
  team1_id: TEAM_A,
  team2_id: TEAM_B,
  Team1: team(TEAM_A, "Alpha"),
  Team2: team(TEAM_B, "Bravo"),
  requested_by: "requester-7",
  participants: dirtyParticipants,
  ...dirtyMember,
};

const dirtySync = {
  id: YID,
  kind: "league",
  status: "failed",
  tournament_id: TID,
  stage_id: null,
  series_id: null,
  requested_by: "requester-7",
  via: "api",
  started_at: new Date("2026-11-14T10:00:00Z"),
  heartbeat_at: new Date("2026-11-14T10:00:30Z"),
  finished_at: new Date("2026-11-14T10:01:00Z"),
  request_count: 3,
  error_class: "EsclubUnavailable",
  error_message: "failed for requester-7 PLAYERKEY-ALPHA",
  summary: {
    seriesListed: 2,
    gamesWritten: 1,
    listLengths: [2, { playerKey: "PLAYERKEY-ALPHA" }],
    skipped: {
      "roster not in the stage's roster list": 1,
      "PLAYERKEY-ALPHA": 2,
      private: { id_user: "esclub-user-9" },
    },
    private: { playerKey: "PLAYERKEY-ALPHA", ...dirtyMember },
  },
  ...dirtyMember,
};

/** Every key and every string in a JSON value. */
function walk(value, keys, strings) {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, keys, strings);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      walk(v, keys, strings);
    }
  } else if (typeof value === "string") {
    strings.push(value);
  }
}

function expectClean(res) {
  const keys = [];
  const strings = [];
  walk(res.body, keys, strings);
  for (const key of FORBIDDEN_KEYS) expect(keys).not.toContain(key);
  // Champion names are keys of `lanes`; nothing else may be a player datum.
  const text = JSON.stringify(res.body);
  for (const value of FORBIDDEN_VALUES) expect(text).not.toContain(value);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(syncState, "markStale").mockResolvedValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(Tournament, "findByPk").mockResolvedValue({
    id: TID,
    name: "Spring",
    region: "na1",
    source: "esclub",
    last_synced_at: null,
    created_by: "requester-7",
    ...dirtyMember,
  });
  vi.spyOn(LeagueStage, "findAll").mockResolvedValue([
    { id: STAGE, name: "Season", last_synced_at: null, added_by: "requester-7", ...dirtyMember },
  ]);
  vi.spyOn(EsclubSync, "findOne").mockResolvedValue(dirtySync);
  vi.spyOn(syncState, "getSync").mockResolvedValue(dirtySync);
  vi.spyOn(syncState, "nextAvailableAt").mockResolvedValue(null);
  vi.spyOn(syncState, "usageToday").mockResolvedValue({ used: 0, budget: 10 });
  vi.spyOn(LeagueSeries, "findAll").mockResolvedValue([dirtySeries]);
  vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(dirtySeries);
  vi.spyOn(LeagueGame, "findAll").mockResolvedValue([dirtyGame]);
  vi.spyOn(syncState, "beginSync").mockResolvedValue({ off: "disabled" });
  vi.spyOn(addLeagueService, "addLeague").mockResolvedValue({ off: "disabled" });
  vi.spyOn(syncEngine, "runSync").mockResolvedValue({});
});

const ROUTES = [
  ["syncs", `/api/esclub/syncs/${YID}`],
  ["tournament", `/api/esclub/tournaments/${TID}`],
  ["series list", `/api/esclub/tournaments/${TID}/series`],
  ["series detail", `/api/esclub/series/${SID}`],
];

describe("no esclub read route returns player data", () => {
  it.each(ROUTES)("%s", async (_label, url) => {
    const res = await request(buildApp()).get(url);
    expect(res.status).toBe(200);
    expectClean(res);
  });

  it("projects nested summary counts and palette fields to the shared schemas", async () => {
    const sync = await request(buildApp()).get(`/api/esclub/syncs/${YID}`);
    expect(sync.body.sync.summary).toEqual({
      seriesListed: 2,
      gamesWritten: 1,
      listLengths: [2],
      skipped: { "roster not in the stage's roster list": 1, other: 2 },
    });
    expect(EsclubSyncSummarySchema.parse(sync.body.sync.summary)).toEqual(sync.body.sync.summary);
    const detail = await request(buildApp()).get(`/api/esclub/series/${SID}`);
    expect(detail.body.series.team1.colors).toEqual({ primary: "#111111", secondary: "eeeeee" });
    expect(EsclubTeamViewSchema.parse(detail.body.series.team1)).toEqual(detail.body.series.team1);
  });

  it("the series detail still carries lanes (the walk is not vacuous)", async () => {
    const res = await request(buildApp()).get(`/api/esclub/series/${SID}`);
    expect(res.body.series.games[0].lanes).toEqual({ Ahri: "mid" });
    expect(JSON.stringify(res.body)).toContain("Alpha");
  });

  it("the joined shared schema accepts D4's sync envelope and rejects the old one", async () => {
    const res = await request(buildApp()).get(`/api/esclub/syncs/${YID}`);
    expect(EsclubJoinedResponseSchema.safeParse(res.body).success).toBe(true);
    expect(EsclubJoinedResponseSchema.safeParse({ joined: res.body.sync }).success).toBe(false);
    expect(EsclubActionResponseSchema.safeParse({ joined: res.body.sync }).success).toBe(false);
  });

  it("the walk catches a leak", () => {
    const leaky = { body: { games: [{ participants: {} }] } };
    expect(() => expectClean(leaky)).toThrow();
    const leakyValue = { body: { note: "Player01" } };
    expect(() => expectClean(leakyValue)).toThrow();
    expect(() => expectClean({ body: { nested: { type_member: "Owner" } } })).toThrow();
    expect(() => expectClean({ body: { nested: { note: "MEMBER-ROLE-SENTINEL" } } })).toThrow();
  });
});

const POST_ROUTES = [
  ["add", "/api/esclub/leagues", "add"],
  ["tournament refresh", `/api/esclub/tournaments/${TID}/refresh`, "league"],
  ["series refresh", `/api/esclub/series/${SID}/refresh`, "serie"],
];

describe.each(POST_ROUTES)("%s responses carry no private data", (_label, url, kind) => {
  const dirtyActionSync = { ...dirtySync, kind, status: "running", finished_at: null };
  const outcomes = [
    ["new sync", { sync: dirtyActionSync }, 202],
    ["joined", { joined: dirtyActionSync }, 200],
    ["cooldown", { cooldown: { availableAt: new Date("2026-11-14T10:10:00Z"), ...dirtyMember } }, 200],
    ["limited", { limited: { retryAfter: 90, ...dirtyMember } }, 429],
    ["busy", { busy: { retryAfter: 60, ...dirtyMember } }, 409],
    ["off disabled", { off: "disabled" }, 503],
    ["off budget", { off: "budget" }, 503],
    ["unexpected result", {}, 500],
  ];
  if (kind === "add") {
    outcomes.push(
      ["known", { known: { tournamentId: TID, stageId: STAGE, participants: dirtyParticipants, ...dirtyMember } }, 200],
      ["invalid URL", { invalid: "URL" }, 400],
      ["invalid region", { invalid: "REGION" }, 400],
    );
  }

  const service = () => kind === "add" ? addLeagueService.addLeague : syncState.beginSync;
  it.each(outcomes)("%s", async (_outcome, outcome, status) => {
    service().mockResolvedValue({ ...outcome, ...dirtyMember, participants: dirtyParticipants });
    const res = await request(buildApp()).post(url).send({ url: "unused stub input", region: "na1" });
    expect(res.status).toBe(status);
    expect(Object.keys(res.body).length).toBeGreaterThan(0);
    expectClean(res);
    if (_outcome === "joined") {
      expect(Object.keys(res.body)).toEqual(["sync"]);
      expect(res.body.sync.id).toBe(YID);
      expect(EsclubJoinedResponseSchema.parse(res.body)).toEqual(res.body);
      expect(EsclubActionResponseSchema.parse(res.body)).toEqual(res.body);
    }
    if (_outcome === "new sync") {
      expect(res.body.sync.id).toBe(YID);
      expect(res.body.sync.summary.seriesListed).toBe(2);
      expect(syncEngine.runSync).toHaveBeenCalledTimes(kind === "add" ? 0 : 1);
    } else {
      expect(syncEngine.runSync).not.toHaveBeenCalled();
    }
  });

  it("thrown error (500)", async () => {
    service().mockRejectedValue(new Error(FORBIDDEN_VALUES.join(" ")));
    const res = await request(buildApp()).post(url).send({});
    expect(res.status).toBe(500);
    expectClean(res);
  });

  it("unauthenticated (401)", async () => {
    auth.protect.mockImplementation((_req, res) => res.status(401).json({ error: "Not authorized" }));
    const res = await request(buildApp()).post(url).send({});
    expect(res.status).toBe(401);
    expectClean(res);
  });

  if (kind !== "add") {
    it("missing mirror row (404)", async () => {
      Tournament.findByPk.mockResolvedValue(null);
      LeagueSeries.findByPk.mockResolvedValue(null);
      const res = await request(buildApp()).post(url);
      expect(res.status).toBe(404);
      expectClean(res);
    });
    it("invalid id (404)", async () => {
      const res = await request(buildApp()).post(url.replace(kind === "league" ? TID : SID, "invalid"));
      expect(res.status).toBe(404);
      expectClean(res);
    });
  }
});


it("projects new name summary counts and fixed skip reasons without private columns", async () => {
  const summary = { ...dirtySync.summary, nameMemberLists: 2, nameLookups: 9, namesResolved: 4, namesUnmatched: 1,
    ...dirtyLinked, skipped: { "names: request cap": 1, "names: daily budget": 2, "names: lookup limit": 3, "names: EsclubProtocolChanged": 4,
      "synthetic-discord-name": 1, private: dirtyLinked } };
  syncState.getSync.mockResolvedValue({ ...dirtySync, summary });
  const res = await request(buildApp()).get(`/api/esclub/syncs/${YID}`);
  expectClean(res);
  expect(res.body.sync.summary).toMatchObject({ nameMemberLists: 2, nameLookups: 9, namesResolved: 4, namesUnmatched: 1,
    skipped: { "names: request cap": 1, "names: daily budget": 2, "names: lookup limit": 3, "names: EsclubProtocolChanged": 4, other: 1 } });
  expect(EsclubSyncSummarySchema.parse(res.body.sync.summary)).toEqual(res.body.sync.summary);
});

it("a stubbed name step and sync console carry counts only, even on a private protocol error", async () => {
  syncEngine.runSync.mockRestore();
  const { fillPlayerNames } = require("../../services/esclub/playerNames");
  const { EsclubProtocolChanged } = require("../../services/esclub/errors");
  const spies = ["log", "error", "warn", "info", "debug"].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  const t = { id: TEAM_A, external_id: "synthetic-roster", entries: [{ teamNumber: 1, seriesId: "synthetic-series",
    game: { blueSideTeam: 1, playedAt: null, participants: { Ahri: { playerKey: "PLAYERKEY-ALPHA", side: "blue", gameName: null, tagLine: null } } } }] };
  const store = { inTransaction: async (work) => work({}), loadStageTeamPlayers: async () => ({ teams: [t], allTeams: [t], allKeys: new Set(["PLAYERKEY-ALPHA"]) }),
    loadPlayerNames: async () => [], upsertPlayerNames: vi.fn(), rebuildRoster: vi.fn() };
  const client = { request: async (name) => name === "fetch-members-by-serie" ? { members: [
    { id_parent: t.external_id, type_parent: "TeamRoster", id_user: "esclub-user-9", type_member: "Starter", time_start: 1, time_end: null },
    { id_parent: t.external_id, type_parent: "TeamRoster", id_user: "synthetic-protocol-user", type_member: "Starter", time_start: 0, time_end: null },
  ] } : { oauths: [{ type_oauth: "Riot", id_oauth_external: "PLAYERKEY-ALPHA", name: "Player01#T01" },
    { type_oauth: "Discord", id_oauth_external: "synthetic-discord-id", name: "synthetic-discord-name" }] } };
  const state = { limitsFromEnv: () => ({ cap: 400, budget: 2000 }), finishSync: vi.fn() };
  const run = (requests) => syncEngine.runSync({ id: YID, kind: "league" }, (c, summary) => fillPlayerNames(c, { tournament: { id: TID }, stage: { id: STAGE }, store, summary, requests }),
    { session: async (work) => work(client), state });
  const result = await run();
  expect(result.summary.namesResolved).toBe(1);
  const failed = await run({ fetchSerieRosterPlayers: async () => { throw new EsclubProtocolChanged(FORBIDDEN_VALUES.join(" ")); } });
  expect(failed.status).toBe("succeeded");
  const text = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
  for (const value of FORBIDDEN_VALUES) expect(text).not.toContain(value);
  expect(text).toContain("names-resolved 1");
});
