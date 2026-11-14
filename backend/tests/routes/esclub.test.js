import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const sequelize = require("../../config/database");
const setupAssociations = require("../../models/associations");
const Tournament = require("../../models/Tournament");
const LeagueStage = require("../../models/LeagueStage");
const LeagueSeries = require("../../models/LeagueSeries");
const LeagueGame = require("../../models/LeagueGame");
const EsclubSync = require("../../models/EsclubSync");
const syncState = require("../../services/esclub/syncState");
const syncEngine = require("../../services/esclub/sync");
const addLeagueService = require("../../services/esclub/addLeague");

let associated = false;
const ensureAssociations = () => {
  if (associated) return;
  setupAssociations();
  associated = true;
};

function loadRouter() {
  const routePath = require.resolve("../../routes/esclub");
  delete require.cache[routePath];
  return require("../../routes/esclub");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/esclub", loadRouter());
  return app;
}

const TID = "44444444-4444-4444-8444-444444444444";
const SID = "55555555-5555-4555-8555-555555555555";
const YID = "66666666-6666-4666-8666-666666666666";
const STAGE = "77777777-7777-4777-8777-777777777777";
const TEAM_A = "88888888-8888-4888-8888-888888888888";
const TEAM_B = "99999999-9999-4999-8999-999999999999";
const LOG_SENTINELS = ["PLAYERKEY-LOG", "Player99#T99", "esclub-user-log", "MEMBER-ROLE-LOG"];
const privateError = () => {
  const err = new TypeError(LOG_SENTINELS.join(" "));
  // The mutable instance name is also untrusted; classify by the class.
  err.name = "PLAYERKEY-LOG";
  return err;
};
const expectPrivateLogs = () => {
  const text = JSON.stringify(console.error.mock.calls);
  for (const sentinel of LOG_SENTINELS) expect(text).not.toContain(sentinel);
};

const syncRow = (over = {}) => ({
  id: YID,
  kind: "league",
  status: "running",
  tournament_id: TID,
  stage_id: null,
  series_id: null,
  requested_by: "u1",
  via: "api",
  started_at: new Date("2026-11-14T10:00:00Z"),
  heartbeat_at: new Date("2026-11-14T10:00:30Z"),
  finished_at: null,
  request_count: 3,
  error_class: null,
  error_message: "secret detail",
  summary: { seriesListed: 4 },
  ...over,
});

const team = (id, name) => ({
  id,
  name,
  acronym: name.slice(0, 3).toUpperCase(),
  colors: { primary: "#111111", secondary: "#eeeeee" },
});

const seriesRow = (over = {}) => ({
  id: SID,
  external_id: "ext-serie-1",
  tournament_id: TID,
  stage_id: STAGE,
  number: 1,
  starts_at: new Date("2026-11-20T18:00:00Z"),
  status: "in_progress",
  complete: false,
  best_of: 3,
  draft_type: "fearless",
  team1_id: TEAM_A,
  team2_id: TEAM_B,
  Team1: team(TEAM_A, "Alpha"),
  Team2: team(TEAM_B, "Bravo"),
  ...over,
});

const gameRow = (over = {}) => ({
  series_id: SID,
  number: 1,
  played_at: new Date("2026-11-20T18:10:00Z"),
  picks: ["Ahri", "Zed"],
  first_pick: "blue",
  blue_side_team: 1,
  winner: "blue",
  complete: true,
  participants: {
    Ahri: { lane: "mid", playerKey: "k1", gameName: "Player01", tagLine: "T01" },
    Zed: { lane: null, playerKey: "k2", gameName: "Player02", tagLine: "T02" },
  },
  ...over,
});

let beginSync;
let runSync;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  beginSync = vi.spyOn(syncState, "beginSync");
  runSync = vi.spyOn(syncEngine, "runSync").mockResolvedValue({});
  vi.spyOn(syncEngine, "syncTournament").mockResolvedValue(undefined);
  vi.spyOn(syncEngine, "syncSerie").mockResolvedValue(undefined);
});

const esclubTournament = (over = {}) => ({
  id: TID,
  name: "Spring",
  region: "euw1",
  source: "esclub",
  last_synced_at: new Date("2026-11-14T09:00:00Z"),
  ...over,
});

describe("auth", () => {
  beforeEach(() => {
    auth.protect.mockImplementation((_req, res) =>
      res.status(401).json({ error: "Not authorized, no token" }),
    );
  });
  it.each([
    ["post", "/api/esclub/leagues"],
    ["post", `/api/esclub/tournaments/${TID}/refresh`],
    ["post", `/api/esclub/series/${SID}/refresh`],
    ["get", `/api/esclub/syncs/${YID}`],
    ["get", `/api/esclub/tournaments/${TID}`],
    ["get", `/api/esclub/tournaments/${TID}/series`],
    ["get", `/api/esclub/series/${SID}`],
  ])("401 on %s %s without a session", async (method, url) => {
    const spy = vi.spyOn(Tournament, "findByPk");
    const add = vi.spyOn(addLeagueService, "addLeague");
    const res = await request(buildApp())[method](url).send({});
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(beginSync).not.toHaveBeenCalled();
  });
});

describe("id validation comes before any query", () => {
  it.each([
    ["post", "/api/esclub/tournaments/nope/refresh"],
    ["post", "/api/esclub/series/nope/refresh"],
    ["get", "/api/esclub/syncs/nope"],
    ["get", "/api/esclub/tournaments/nope"],
    ["get", "/api/esclub/tournaments/nope/series"],
    ["get", "/api/esclub/series/nope"],
    ["get", "/api/esclub/series/1;drop"],
  ])("404 for %s %s", async (method, url) => {
    const spies = [
      vi.spyOn(Tournament, "findByPk"),
      vi.spyOn(LeagueSeries, "findByPk"),
      vi.spyOn(LeagueSeries, "findAll"),
      vi.spyOn(LeagueGame, "findAll"),
      vi.spyOn(LeagueStage, "findAll"),
      vi.spyOn(EsclubSync, "findOne"),
      vi.spyOn(syncState, "getSync"),
    ];
    const res = await request(buildApp())[method](url).send({});
    expect(res.status).toBe(404);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(beginSync).not.toHaveBeenCalled();
  });
});

describe("POST /leagues", () => {
  let addLeague;
  beforeEach(() => {
    addLeague = vi.spyOn(addLeagueService, "addLeague");
  });
  const post = (body = { url: "https://esclub.gg/x", region: "na1" }) =>
    request(buildApp()).post("/api/esclub/leagues").send(body);

  it("passes the url, region, user and via", async () => {
    addLeague.mockResolvedValue({ known: { tournamentId: TID, stageId: STAGE } });
    await post();
    expect(addLeague).toHaveBeenCalledWith({
      url: "https://esclub.gg/x",
      region: "na1",
      userId: "u1",
      via: "api",
    });
  });

  it("400 INVALID_URL names the accepted form", async () => {
    addLeague.mockResolvedValue({ invalid: "URL" });
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_URL");
    expect(res.body.error).toBe(
      `Paste an esclub series link, like ${addLeagueService.ACCEPTED_LINK_EXAMPLE}`,
    );
  });

  it("400 INVALID_REGION", async () => {
    addLeague.mockResolvedValue({ invalid: "REGION" });
    const res = await post();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REGION");
  });

  it("200 known", async () => {
    addLeague.mockResolvedValue({ known: { tournamentId: TID, stageId: STAGE } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ known: { tournamentId: TID, stageId: STAGE } });
  });

  it("202 sync, as a view without who asked", async () => {
    addLeague.mockResolvedValue({ sync: syncRow({ kind: "add" }) });
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body.sync.id).toBe(YID);
    expect(res.body.sync).not.toHaveProperty("requested_by");
    expect(res.body.sync).not.toHaveProperty("error_message");
    expect(res.body.sync).not.toHaveProperty("via");
  });

  it("200 joined", async () => {
    addLeague.mockResolvedValue({ joined: syncRow() });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.sync.id).toBe(YID);
    expect(res.body).not.toHaveProperty("joined");
  });

  it("409 busy", async () => {
    addLeague.mockResolvedValue({ busy: { retryAfter: 60 } });
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ retryAfter: 60 });
  });

  it("200 cooldown", async () => {
    const availableAt = new Date("2026-11-14T10:10:00Z");
    addLeague.mockResolvedValue({ cooldown: { availableAt } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cooldown: { availableAt: availableAt.toISOString() },
    });
  });

  it("429 limited with Retry-After", async () => {
    addLeague.mockResolvedValue({ limited: { retryAfter: 90 } });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ retryAfter: 90 });
    expect(res.headers["retry-after"]).toBe("90");
  });

  it("503 disabled", async () => {
    addLeague.mockResolvedValue({ off: "disabled" });
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ reason: "disabled", error: "esclub sync is off" });
  });

  it("503 budget", async () => {
    addLeague.mockResolvedValue({ off: "budget" });
    const res = await post();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      reason: "budget",
      error: "esclub sync paused until tomorrow",
    });
  });

  it("500 with a generic message and a safe error classification when it throws", async () => {
    addLeague.mockRejectedValue(privateError());
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Something went wrong" });
    expectPrivateLogs();
    expect(console.error).toHaveBeenCalledWith("esclub route failed", {
      route: "POST /api/esclub/leagues", errorClass: "TypeError",
    });
  });

  it("copes with no body", async () => {
    addLeague.mockResolvedValue({ invalid: "URL" });
    const res = await request(buildApp()).post("/api/esclub/leagues");
    expect(res.status).toBe(400);
  });
});

describe("POST /tournaments/:id/refresh", () => {
  const post = () =>
    request(buildApp()).post(`/api/esclub/tournaments/${TID}/refresh`);

  it("404 for a missing tournament and for a manual one, with no sync", async () => {
    const find = vi.spyOn(Tournament, "findByPk").mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    find.mockResolvedValue(esclubTournament({ source: "manual" }));
    expect((await post()).status).toBe(404);
    expect(beginSync).not.toHaveBeenCalled();
  });

  it("starts the sync in the background and answers 202 at once", async () => {
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    beginSync.mockResolvedValue({ sync: syncRow() });
    let finish;
    runSync.mockReturnValue(new Promise((r) => (finish = r)));
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body.sync.id).toBe(YID);
    expect(beginSync).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "league",
        tournamentId: TID,
        userId: "u1",
        via: "api",
        now: expect.any(Date),
      }),
    );
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(runSync.mock.calls[0][0].id).toBe(YID);
    // The work handed to runSync syncs this tournament.
    const client = {};
    const summary = {};
    await runSync.mock.calls[0][1](client, summary);
    expect(syncEngine.syncTournament).toHaveBeenCalledWith(client, {
      tournamentId: TID,
      summary,
    });
    finish({});
  });

  it.each(["reject", "throw", "late rejection"])("logs a safe background classification on %s and still answers 202", async (mode) => {
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    beginSync.mockResolvedValue({ sync: syncRow() });
    let reject;
    if (mode === "reject") runSync.mockRejectedValue(privateError());
    else if (mode === "throw") runSync.mockImplementation(() => { throw privateError(); });
    else runSync.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const res = await post();
    expect(res.status).toBe(202);
    if (reject) reject(privateError());
    await new Promise((r) => setImmediate(r));
    expectPrivateLogs();
    expect(console.error).toHaveBeenCalledWith("esclub sync failed", {
      route: "POST /api/esclub/tournaments/:id/refresh", id: TID,
      errorClass: "TypeError", syncId: YID, tournamentId: TID,
      stageId: null, seriesId: null,
    });
  });

  it.each([
    [{ joined: syncRow() }, 200],
    [{ busy: { retryAfter: 60 } }, 409],
    [{ cooldown: { availableAt: new Date() } }, 200],
    [{ limited: { retryAfter: 5 } }, 429],
    [{ off: "disabled" }, 503],
    [{ off: "budget" }, 503],
  ])("maps %j to %i and starts nothing", async (outcome, status) => {
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    beginSync.mockResolvedValue(outcome);
    const res = await post();
    expect(res.status).toBe(status);
    expect(runSync).not.toHaveBeenCalled();
  });

  it("503 bodies carry the reason", async () => {
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    beginSync.mockResolvedValue({ off: "budget" });
    const res = await post();
    expect(res.body.reason).toBe("budget");
  });

  it("500 when beginSync throws", async () => {
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    beginSync.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe("POST /series/:id/refresh", () => {
  const post = () => request(buildApp()).post(`/api/esclub/series/${SID}/refresh`);

  it("404 for a missing series", async () => {
    vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(beginSync).not.toHaveBeenCalled();
  });

  it("begins a serie sync for the series' tournament and runs syncSerie", async () => {
    vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(
      seriesRow({ tournament_id: TID }),
    );
    beginSync.mockResolvedValue({ sync: syncRow({ kind: "serie", series_id: SID }) });
    const res = await post();
    expect(res.status).toBe(202);
    expect(beginSync).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "serie",
        tournamentId: TID,
        seriesId: SID,
        userId: "u1",
        via: "api",
      }),
    );
    const client = {};
    const summary = {};
    await runSync.mock.calls[0][1](client, summary);
    expect(syncEngine.syncSerie).toHaveBeenCalledWith(client, {
      seriesId: SID,
      summary,
    });
  });

  it.each([
    [{ joined: syncRow() }, 200],
    [{ busy: { retryAfter: 60 } }, 409],
    [{ cooldown: { availableAt: new Date() } }, 200],
    [{ limited: { retryAfter: 5 } }, 429],
    [{ off: "disabled" }, 503],
  ])("maps %j to %i", async (outcome, status) => {
    vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(seriesRow());
    beginSync.mockResolvedValue(outcome);
    const res = await post();
    expect(res.status).toBe(status);
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe("GET /syncs/:id", () => {
  it("returns the view only", async () => {
    vi.spyOn(syncState, "getSync").mockResolvedValue(
      syncRow({ status: "failed", error_class: "EsclubUnavailable" }),
    );
    const res = await request(buildApp()).get(`/api/esclub/syncs/${YID}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.sync).sort()).toEqual(
      [
        "errorClass",
        "finishedAt",
        "id",
        "kind",
        "requestCount",
        "seriesId",
        "stageId",
        "startedAt",
        "status",
        "summary",
        "tournamentId",
      ].sort(),
    );
    expect(res.body.sync.errorClass).toBe("EsclubUnavailable");
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
    expect(JSON.stringify(res.body)).not.toContain("u1");
  });

  it("404 when missing", async () => {
    vi.spyOn(syncState, "getSync").mockResolvedValue(null);
    const res = await request(buildApp()).get(`/api/esclub/syncs/${YID}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /tournaments/:id", () => {
  const get = () => request(buildApp()).get(`/api/esclub/tournaments/${TID}`);
  let findOne;
  let nextAvailableAt;
  let usageToday;

  beforeEach(() => {
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    vi.spyOn(LeagueStage, "findAll").mockResolvedValue([
      { id: STAGE, name: "Regular season", last_synced_at: null },
    ]);
    findOne = vi.spyOn(EsclubSync, "findOne").mockResolvedValue(null);
    nextAvailableAt = vi.spyOn(syncState, "nextAvailableAt").mockResolvedValue(null);
    usageToday = vi
      .spyOn(syncState, "usageToday")
      .mockResolvedValue({ day: "2026-11-14", used: 10, budget: 2000 });
    vi.spyOn(syncState, "limitsFromEnv").mockReturnValue({
      enabled: true,
      budget: 2000,
      cap: 400,
    });
  });

  it("404 for a manual tournament and a missing one", async () => {
    Tournament.findByPk.mockResolvedValue(esclubTournament({ source: "manual" }));
    expect((await get()).status).toBe(404);
    Tournament.findByPk.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(LeagueStage.findAll).not.toHaveBeenCalled();
  });

  it("returns tournament, stages and an idle sync state", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tournament: {
        id: TID,
        name: "Spring",
        region: "euw1",
        lastSyncedAt: "2026-11-14T09:00:00.000Z",
      },
      stages: [{ id: STAGE, name: "Regular season", lastSyncedAt: null }],
      sync: {
        running: null,
        availableAt: null,
        syncEnabled: true,
        budgetPaused: false,
      },
    });
    expect(findOne.mock.calls[0][0].where).toEqual({
      tournament_id: TID,
      status: "running",
    });
    expect(nextAvailableAt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "league", tournamentId: TID }),
    );
  });

  it("shows a running sync, the cooldown, the switch and the budget", async () => {
    findOne.mockResolvedValue(syncRow());
    const at = new Date("2026-11-14T10:10:00Z");
    nextAvailableAt.mockResolvedValue(at);
    usageToday.mockResolvedValue({ day: "d", used: 2000, budget: 2000 });
    syncState.limitsFromEnv.mockReturnValue({ enabled: false, budget: 2000, cap: 400 });
    const res = await get();
    expect(res.body.sync.running.id).toBe(YID);
    expect(res.body.sync.running).not.toHaveProperty("requested_by");
    expect(res.body.sync.availableAt).toBe(at.toISOString());
    expect(res.body.sync.syncEnabled).toBe(false);
    expect(res.body.sync.budgetPaused).toBe(true);
  });
});

describe("GET /tournaments/:id/series", () => {
  const get = (qs = "") =>
    request(buildApp()).get(`/api/esclub/tournaments/${TID}/series${qs}`);
  let findAll;
  let games;

  beforeEach(() => {
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    findAll = vi.spyOn(LeagueSeries, "findAll").mockResolvedValue([seriesRow()]);
    games = vi.spyOn(LeagueGame, "findAll").mockResolvedValue([
      { series_id: SID, winner: "blue", blue_side_team: 1 },
      { series_id: SID, winner: "blue", blue_side_team: 2 },
      { series_id: SID, winner: "red", blue_side_team: 2 },
      { series_id: SID, winner: null, blue_side_team: 1 },
    ]);
  });

  it("404 for a manual tournament", async () => {
    Tournament.findByPk.mockResolvedValue(esclubTournament({ source: "manual" }));
    expect((await get()).status).toBe(404);
    expect(findAll).not.toHaveBeenCalled();
  });

  it.each([
    ["?stage=nope"],
    ["?team=nope"],
    ["?status=done"],
    ["?status=upcoming&status=finished"],
  ])("400 for %s before any query", async (qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(Tournament.findByPk).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
  });

  it("returns items with teams, game count and wins from sides", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.series).toEqual([
      {
        id: SID,
        externalId: "ext-serie-1",
        stageId: STAGE,
        number: 1,
        startsAt: "2026-11-20T18:00:00.000Z",
        status: "in_progress",
        complete: false,
        bestOf: 3,
        draftType: "fearless",
        team1: { id: TEAM_A, name: "Alpha", acronym: "ALP", colors: { primary: "#111111", secondary: "#eeeeee" } },
        team2: { id: TEAM_B, name: "Bravo", acronym: "BRA", colors: { primary: "#111111", secondary: "#eeeeee" } },
        gameCount: 4,
        // blue/1 -> team1; blue/2 -> team2; red with blue=2 -> team1.
        wins: { team1: 2, team2: 1 },
      },
    ]);
  });

  it("null teams stay null", async () => {
    findAll.mockResolvedValue([seriesRow({ Team1: null, Team2: null })]);
    games.mockResolvedValue([]);
    const res = await get();
    expect(res.body.series[0].team1).toBeNull();
    expect(res.body.series[0].team2).toBeNull();
  });

  it("filters by tournament, stage, status and either team; orders by date then number", async () => {
    await get(`?stage=${STAGE}&team=${TEAM_A}&status=upcoming`);
    const opts = findAll.mock.calls[0][0];
    const { Op } = require("sequelize");
    expect(opts.where).toEqual({
      tournament_id: TID,
      stage_id: STAGE,
      status: "upcoming",
      [Op.or]: [{ team1_id: TEAM_A }, { team2_id: TEAM_A }],
    });
    expect(opts.order.slice(0, 2)).toEqual([
      ["starts_at", "ASC NULLS LAST"],
      ["number", "ASC"],
    ]);
  });

  it("loads the games of all listed series in one query and no participants", async () => {
    findAll.mockResolvedValue([
      seriesRow(),
      seriesRow({ id: YID, number: 2 }),
    ]);
    await get();
    expect(games).toHaveBeenCalledTimes(1);
    expect(games.mock.calls[0][0].where).toEqual({ series_id: [SID, YID] });
    expect(games.mock.calls[0][0].attributes).not.toContain("participants");
  });

  it("makes no game query for an empty list", async () => {
    findAll.mockResolvedValue([]);
    const res = await get();
    expect(res.body).toEqual({ series: [] });
    expect(games).not.toHaveBeenCalled();
  });
});

describe("GET /series/:id", () => {
  const get = () => request(buildApp()).get(`/api/esclub/series/${SID}`);

  it("404 for a missing series", async () => {
    vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });

  it("returns the item, the page link and games with lanes only", async () => {
    vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(seriesRow());
    const findGames = vi
      .spyOn(LeagueGame, "findAll")
      .mockResolvedValue([gameRow()]);
    const res = await get();
    expect(res.status).toBe(200);
    const s = res.body.series;
    expect(s.esclubUrl).toBe("https://esclub.gg/multimedia/serie/ext-serie-1");
    expect(s.gameCount).toBe(1);
    expect(s.wins).toEqual({ team1: 1, team2: 0 });
    expect(s.games).toEqual([
      {
        number: 1,
        playedAt: "2026-11-20T18:10:00.000Z",
        picks: ["Ahri", "Zed"],
        firstPick: "blue",
        blueSideTeam: 1,
        winner: "blue",
        complete: true,
        lanes: { Ahri: "mid" },
      },
    ]);
    expect(findGames.mock.calls[0][0].where).toEqual({ series_id: SID });
    expect(findGames.mock.calls[0][0].order).toEqual([["number", "ASC"]]);
  });
});

describe("SQL the routes make", () => {
  const capture = () => {
    ensureAssociations();
    return vi.spyOn(sequelize, "query").mockResolvedValue([]);
  };

  it.each(["refresh", "series"])("tournament id/source lookup for %s selects only its scope columns", async (action) => {
    const query = capture().mockResolvedValue(Tournament.build(esclubTournament()));
    beginSync.mockResolvedValue({ cooldown: { availableAt: new Date("2026-11-14T10:10:00Z") } });
    vi.spyOn(LeagueSeries, "findAll").mockResolvedValue([]);
    const app = request(buildApp());
    const res = action === "refresh"
      ? await app.post(`/api/esclub/tournaments/${TID}/refresh`)
      : await app.get(`/api/esclub/tournaments/${TID}/series`);
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(
      `SELECT "id", "source" FROM "Tournaments" AS "Tournament" WHERE "Tournament"."id" = '${TID}';`,
    );
  });

  it("tournament view selects only public tournament columns by primary key", async () => {
    const query = capture().mockResolvedValue(Tournament.build(esclubTournament()));
    vi.spyOn(LeagueStage, "findAll").mockResolvedValue([]);
    vi.spyOn(EsclubSync, "findOne").mockResolvedValue(null);
    vi.spyOn(syncState, "nextAvailableAt").mockResolvedValue(null);
    vi.spyOn(syncState, "usageToday").mockResolvedValue({ used: 0, budget: 1 });
    const res = await request(buildApp()).get(`/api/esclub/tournaments/${TID}`);
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(
      `SELECT "id", "name", "region", "source", "last_synced_at" FROM "Tournaments" AS "Tournament" WHERE "Tournament"."id" = '${TID}';`,
    );
  });

  it("series-refresh lookup selects only id, tournament and stage by primary key", async () => {
    const query = capture().mockResolvedValue(LeagueSeries.build(seriesRow()));
    beginSync.mockResolvedValue({ cooldown: { availableAt: new Date("2026-11-14T10:10:00Z") } });
    const res = await request(buildApp()).post(`/api/esclub/series/${SID}/refresh`);
    expect(res.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(
      `SELECT "id", "tournament_id", "stage_id" FROM "LeagueSeries" AS "LeagueSeries" WHERE "LeagueSeries"."id" = '${SID}';`,
    );
    expect(beginSync).toHaveBeenCalledWith(expect.objectContaining({
      tournamentId: TID, stageId: STAGE, seriesId: SID,
    }));
  });

  it("series list: one filtered, ordered select with two team joins", async () => {
    const query = capture();
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    await request(buildApp()).get(
      `/api/esclub/tournaments/${TID}/series?stage=${STAGE}&team=${TEAM_A}&status=finished`,
    );
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/FROM "LeagueSeries" AS "LeagueSeries"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team1"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team2"/);
    expect(sql).toMatch(/"LeagueSeries"\."tournament_id" = '44444444/);
    expect(sql).toMatch(/"LeagueSeries"\."stage_id" = '77777777/);
    expect(sql).toMatch(/"LeagueSeries"\."status" = 'finished'/);
    expect(sql).toMatch(
      /\("LeagueSeries"\."team1_id" = '88888888[^)]*' OR "LeagueSeries"\."team2_id" = '88888888[^)]*'\)/,
    );
    expect(sql).toMatch(
      /ORDER BY "LeagueSeries"\."starts_at" ASC NULLS LAST, "LeagueSeries"\."number" ASC, "LeagueSeries"\."id" ASC/,
    );
    // No player data is selected.
    expect(sql).not.toMatch(/participants|substitutions/);
  });

  it("series list games: one IN query without participants", async () => {
    const query = capture();
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    vi.spyOn(LeagueSeries, "findAll").mockResolvedValue([seriesRow()]);
    await request(buildApp()).get(`/api/esclub/tournaments/${TID}/series`);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/FROM "LeagueGames" AS "LeagueGame"/);
    expect(sql).toMatch(/"series_id" IN \('55555555/);
    expect(sql).toMatch(/"winner"/);
    expect(sql).not.toMatch(/participants|substitutions|external_match_id/);
  });

  it("series detail: games by series ordered by number, no substitutions", async () => {
    const query = capture();
    vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(seriesRow());
    await request(buildApp()).get(`/api/esclub/series/${SID}`);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/"series_id" = '55555555/);
    expect(sql).toMatch(/ORDER BY "LeagueGame"\."number" ASC/);
    expect(sql).not.toMatch(/substitutions|unmatched/);
  });

  it("series detail: the series select joins both teams on public columns", async () => {
    const query = capture();
    await request(buildApp()).get(`/api/esclub/series/${SID}`);
    const sql = query.mock.calls[0][0];
    expect(sql).toMatch(/FROM "LeagueSeries" AS "LeagueSeries"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team1"/);
    expect(sql).toMatch(/"LeagueSeries"\."id" = '55555555/);
    expect(sql).not.toMatch(/owner_id|external_org_id/);
  });

  it("tournament: stages by tournament and the running sync, public columns only", async () => {
    const query = capture();
    vi.spyOn(Tournament, "findByPk").mockResolvedValue(esclubTournament());
    vi.spyOn(syncState, "nextAvailableAt").mockResolvedValue(null);
    vi.spyOn(syncState, "usageToday").mockResolvedValue({ used: 0, budget: 1 });
    await request(buildApp()).get(`/api/esclub/tournaments/${TID}`);
    const [stagesSql, syncSql] = query.mock.calls.map((c) => c[0]);
    expect(stagesSql).toMatch(/FROM "LeagueStages" AS "LeagueStage"/);
    expect(stagesSql).toMatch(/"tournament_id" = '44444444/);
    expect(stagesSql).not.toMatch(/added_by|external_id/);
    expect(syncSql).toMatch(/FROM "EsclubSyncs" AS "EsclubSync"/);
    expect(syncSql).toMatch(/"tournament_id" = '44444444[^']*' AND "EsclubSync"\."status" = 'running'/);
    expect(syncSql).not.toMatch(/requested_by|error_message|via/);
  });
});
