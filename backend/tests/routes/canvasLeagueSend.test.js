import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

/**
 * S3 Task 4: `POST /api/canvas/:canvasId/import/league-series` (plan D2–D5,
 * D11) through the real route and service, models mocked. The app mounts
 * routes/canvas.js first and routes/canvasLeague.js after it, as index.js
 * does, so the request has to fall through canvas.js. The SQL of each new
 * query is captured in tests/services/leagueCanvas/send.test.js.
 */

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const setupAssociations = require("../../models/associations");
const { Canvas, UserCanvas, CanvasGroup, CanvasDraft } = require("../../models/Canvas");
const Draft = require("../../models/Draft");
const VersusDraft = require("../../models/VersusDraft");
const LeagueSeries = require("../../models/LeagueSeries");
const LeagueGame = require("../../models/LeagueGame");
const UserTournament = require("../../models/UserTournament");
const teamAccess = require("../../services/teamAccess");
const canvasWriteGuards = require("../../services/canvasWriteGuards");
const canvasProjections = require("../../routes/canvasProjections");

const CANVAS = "cccccccc-0000-4000-8000-000000000001";
const USER = "eeeeeeee-0000-4000-8000-000000000001";
const TOURNAMENT = "dddddddd-0000-4000-8000-000000000001";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const sid = (n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;
const URL = `/api/canvas/${CANVAS}/import/league-series`;

beforeAll(() => setupAssociations());
afterEach(() => vi.restoreAllMocks());

function buildApp() {
  for (const mod of ["../../routes/canvas", "../../routes/canvasLeague"]) {
    delete require.cache[require.resolve(mod)];
  }
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  app.use("/api/canvas", require("../../routes/canvasLeague"));
  return app;
}

const team = (id, name) => ({ id, name, source: "esclub", owner_id: null });

// T2 is the roster esclub lists first: fix 7 can't pass by id or name order.
function seriesRow(n, overrides = {}) {
  return {
    id: sid(n),
    tournament_id: TOURNAMENT,
    number: n,
    team1_id: T2,
    team2_id: T1,
    best_of: 3,
    draft_type: "fearless",
    starts_at: new Date(`2026-11-1${n}T18:00:00.000Z`),
    status: "finished",
    complete: true,
    Team1: team(T2, "Zeta Wolves"),
    Team2: team(T1, "Alpha Owls"),
    Stage: { name: "Regular Season" },
    ...overrides,
  };
}

// Mirror games carry participants (as the mirror does); a mock returns what it
// is given, so this proves none of it is copied anywhere.
function gameRow(seriesId, number) {
  return {
    series_id: seriesId,
    number,
    picks: Array.from({ length: 20 }, (_, i) => `G${number}Champ${i}`),
    first_pick: "blue",
    blue_side_team: number % 2 === 0 ? 2 : 1,
    winner: "blue",
    complete: true,
    played_at: new Date("2026-11-11T19:00:00.000Z"),
    participants: {
      Ahri: { lane: "mid", playerKey: "oauth-riot-0007", gameName: "Player07", tagLine: "T07" },
      list: ["Player08#T08", { id_oauth_riot: "riot-0008" }],
    },
  };
}

// Deep walk: player keys anywhere, and gameName/tagLine anywhere except under
// a linked team's TeamPlayers roster (plan Q5 A). Strings are checked too,
// including strings inside arrays.
const FORBIDDEN_KEYS = new Set(["participants", "playerKey", "id_oauth_riot", "id_user"]);
const ROSTER_KEYS = new Set(["gameName", "tagLine"]);
const FORBIDDEN_STRINGS = ["Player07", "T07", "oauth-riot-0007", "Player08", "riot-0008"];

function walkForPlayerData(value, path = "", inRoster = false) {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...walkForPlayerData(v, `${path}[${i}]`, inRoster)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) hits.push(`${path}.${k}`);
      if (ROSTER_KEYS.has(k) && !inRoster) hits.push(`${path}.${k}`);
      const roster =
        inRoster || (k === "TeamPlayers" && /\.(Team1|Team2)$/.test(path));
      hits.push(...walkForPlayerData(v, `${path}.${k}`, roster));
    }
  } else if (typeof value === "string" && FORBIDDEN_STRINGS.some((s) => value.includes(s))) {
    hits.push(`${path}=${value}`);
  }
  return hits;
}

describe("the walker itself", () => {
  it("finds player data in keys, nested strings and arrays, but allows a linked roster", () => {
    expect(walkForPlayerData({ a: [{ participants: {} }] })).toEqual([".a[0].participants"]);
    expect(walkForPlayerData({ a: ["x", "Player08#T08"] })).toEqual([".a[1]=Player08#T08"]);
    expect(walkForPlayerData({ d: { gameName: "Roster01" } })).toEqual([".d.gameName"]);
    expect(
      walkForPlayerData({ g: [{ Team1: { TeamPlayers: [{ gameName: "Roster01", tagLine: "R01" }] } }] }),
    ).toEqual([]);
  });
});

let calls;
let transaction;
let seriesRows;
let gameRows;
let existingGroups;
let canvasRow;
let permissions;
let ids;

beforeEach(() => {
  calls = [];
  ids = 0;
  canvasRow = { id: CANVAS };
  permissions = "edit";
  seriesRows = [seriesRow(1)];
  gameRows = [gameRow(sid(1), 1), gameRow(sid(1), 0)];
  existingGroups = [];
  transaction = {
    commit: vi.fn(async () => {
      calls.push("commit");
      transaction.finished = "commit";
    }),
    rollback: vi.fn(async () => {
      calls.push("rollback");
      transaction.finished = "rollback";
    }),
    finished: undefined,
  };
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: USER };
    next();
  });
  vi.spyOn(UserCanvas, "findOne").mockImplementation(async () => {
    calls.push("UserCanvas.findOne");
    return { permissions };
  });
  vi.spyOn(Canvas.sequelize, "transaction").mockImplementation(async () => {
    calls.push("transaction");
    return transaction;
  });
  vi.spyOn(Canvas, "findOne").mockImplementation(async () => {
    calls.push("Canvas.findOne");
    return canvasRow;
  });
  vi.spyOn(LeagueSeries, "findAll").mockImplementation(async () => {
    calls.push("LeagueSeries.findAll");
    return seriesRows;
  });
  vi.spyOn(LeagueGame, "findAll").mockImplementation(async () => {
    calls.push("LeagueGame.findAll");
    return gameRows;
  });
  vi.spyOn(CanvasGroup, "findAll").mockImplementation(async (opts) => {
    if (opts.attributes?.length === 1 && opts.attributes[0] === "name") return [];
    calls.push("CanvasGroup.findAll(existing)");
    return existingGroups;
  });
  vi.spyOn(VersusDraft, "create").mockImplementation(async (v) => ({ ...v, id: `vd-${++ids}` }));
  vi.spyOn(Draft, "create").mockImplementation(async (v) => ({ ...v, id: `d-${++ids}` }));
  vi.spyOn(CanvasGroup, "create").mockImplementation(async (v) => ({ ...v, id: `g-${++ids}` }));
  vi.spyOn(CanvasDraft, "create").mockImplementation(async (v) => ({ ...v, id: `cd-${++ids}` }));
  vi.spyOn(UserTournament, "bulkCreate").mockImplementation(async () => {
    calls.push("UserTournament.bulkCreate");
    return [];
  });
  vi.spyOn(UserTournament, "update");
  vi.spyOn(canvasWriteGuards, "touchCanvasTimestamp").mockImplementation(async () => {
    calls.push("touch");
  });
  // The snapshot as the clients would get it: the created groups with their
  // linked teams (rosters included, plan Q5 A) and the created drafts.
  vi.spyOn(canvasProjections, "buildCanvasSnapshot").mockImplementation(async () => {
    calls.push("snapshot");
    const roster = [{ gameName: "Roster01", tagLine: "R01", role: "mid" }];
    return {
      canvas: { id: CANVAS },
      groups: CanvasGroup.create.mock.calls.map(([g], i) => ({
        ...g,
        id: `snap-g-${i}`,
        Team1: { id: g.team1_id, name: "Zeta Wolves", TeamPlayers: roster },
        Team2: { id: g.team2_id, name: "Alpha Owls", TeamPlayers: roster },
      })),
      drafts: CanvasDraft.create.mock.calls.map(([cd], i) => ({
        ...cd,
        Draft: Draft.create.mock.calls[i][0],
      })),
    };
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {
    calls.push("emit");
  });
});

const post = (body) =>
  request(buildApp())
    .post(URL)
    .send({ leagueSeriesIds: [sid(1)], positionX: 400, positionY: 300, ...body });

describe("POST /api/canvas/:canvasId/import/league-series", () => {
  it("401 without a session, before any query", async () => {
    auth.protect.mockRestore();
    const res = await post();
    expect(res.status).toBe(401);
    expect(UserCanvas.findOne).not.toHaveBeenCalled();
    expect(Canvas.sequelize.transaction).not.toHaveBeenCalled();
  });

  it("403 for a viewer, and nothing is read from the mirror", async () => {
    permissions = "view";
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: You don't have permission to edit this canvas" });
    expect(UserCanvas.findOne).toHaveBeenCalledWith({ where: { canvas_id: CANVAS, user_id: USER } });
    expect(Canvas.sequelize.transaction).not.toHaveBeenCalled();
    expect(LeagueSeries.findAll).not.toHaveBeenCalled();
  });

  it.each([
    ["no ids", { leagueSeriesIds: undefined }],
    ["an empty list", { leagueSeriesIds: [] }],
    ["51 ids", { leagueSeriesIds: Array.from({ length: 51 }, (_, i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`) }],
    ["a non-uuid", { leagueSeriesIds: ["1; DROP TABLE"] }],
    ["duplicates", { leagueSeriesIds: [sid(1), sid(1)] }],
    ["positionX missing", { positionX: undefined }],
    ["positionY a string", { positionY: "300" }],
    ["rowStep a string", { rowStep: "900" }],
  ])("400 for %s, before any query", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(calls).toEqual([]);
  });

  it("404 when the canvas row is gone, rolled back", async () => {
    canvasRow = null;
    const res = await post();
    expect(res.status).toBe(404);
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it("locks the Canvas row first in the transaction, after the access check", async () => {
    await post().expect(201);
    expect(calls.slice(0, 3)).toEqual(["UserCanvas.findOne", "transaction", "Canvas.findOne"]);
    expect(Canvas.findOne.mock.calls[0][0]).toMatchObject({
      where: { id: CANVAS },
      lock: true,
      transaction,
    });
  });

  it("201: one series sent; commit, touch, ONE snapshot, then ONE broadcast of that snapshot", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      created: [{ leagueSeriesId: sid(1), groupId: "g-4" }],
      existing: [],
      skipped: [],
    });
    const tail = calls.slice(calls.indexOf("commit"));
    expect(tail).toEqual(["commit", "touch", "snapshot", "emit"]);
    expect(canvasWriteGuards.touchCanvasTimestamp).toHaveBeenCalledWith(CANVAS);
    expect(canvasProjections.buildCanvasSnapshot).toHaveBeenCalledTimes(1);
    expect(canvasProjections.buildCanvasSnapshot).toHaveBeenCalledWith(CANVAS);
    expect(socketService.emitToRoom).toHaveBeenCalledTimes(1);
    const [room, event, payload] = socketService.emitToRoom.mock.calls[0];
    expect([room, event]).toEqual([CANVAS, "canvasUpdate"]);
    expect(payload).toBe(await canvasProjections.buildCanvasSnapshot.mock.results[0].value);
    expect(CanvasGroup.create.mock.calls[0][0]).toMatchObject({ canvas_id: CANVAS, positionX: 400, positionY: 300 });
  });

  it("D4: a series already on the canvas → 200, under existing, nothing created, no snapshot or broadcast", async () => {
    existingGroups = [{ id: "g-old", VersusDraft: { league_series_id: sid(1) } }];
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      created: [],
      existing: [{ leagueSeriesId: sid(1), groupId: "g-old" }],
      skipped: [],
    });
    expect(VersusDraft.create).not.toHaveBeenCalled();
    expect(CanvasGroup.create).not.toHaveBeenCalled();
    expect(canvasProjections.buildCanvasSnapshot).not.toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
    expect(canvasWriteGuards.touchCanvasTimestamp).not.toHaveBeenCalled();
    const existingQuery = CanvasGroup.findAll.mock.calls.find((c) => c[0].include);
    expect(existingQuery[0].where).toEqual({ canvas_id: CANVAS });
  });

  it("D3: refusals and unknown ids come back under skipped with 200 when nothing is created", async () => {
    seriesRows = [
      seriesRow(1, { status: "upcoming" }),
      seriesRow(2, { team1_id: null, Team1: null }),
      seriesRow(3, { best_of: 9 }),
      seriesRow(4),
    ];
    gameRows = [gameRow(sid(1), 0), gameRow(sid(2), 0), gameRow(sid(3), 0)];
    const res = await post({ leagueSeriesIds: [sid(1), sid(2), sid(3), sid(4), sid(9)] });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toEqual([
      { leagueSeriesId: sid(1), reason: "upcoming" },
      { leagueSeriesId: sid(2), reason: "no-teams" },
      { leagueSeriesId: sid(3), reason: "unsupported-length" },
      { leagueSeriesId: sid(4), reason: "no-games" },
      { leagueSeriesId: sid(9), reason: "not-found" },
    ]);
    expect(res.body.created).toEqual([]);
    expect(UserTournament.bulkCreate).not.toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it("D5 bulk: one transaction, one snapshot, one broadcast, newest at the top, no gap for existing or skipped", async () => {
    seriesRows = [1, 2, 3, 4, 5].map((n) => seriesRow(n, n === 2 ? { status: "upcoming" } : {}));
    gameRows = [1, 2, 3, 4, 5].map((n) => gameRow(sid(n), 0));
    existingGroups = [{ id: "g-old", VersusDraft: { league_series_id: sid(4) } }];
    const res = await post({
      leagueSeriesIds: [sid(1), sid(2), sid(3), sid(4), sid(5)],
      positionX: -100,
      positionY: 50,
      rowStep: 1000,
    });
    expect(res.status).toBe(201);
    expect(res.body.created.map((c) => c.leagueSeriesId)).toEqual([sid(5), sid(3), sid(1)]);
    expect(res.body.existing).toEqual([{ leagueSeriesId: sid(4), groupId: "g-old" }]);
    expect(res.body.skipped).toEqual([{ leagueSeriesId: sid(2), reason: "upcoming" }]);
    expect(CanvasGroup.create.mock.calls.map(([g]) => [g.positionX, g.positionY])).toEqual([
      [-100, 50],
      [-100, 1050],
      [-100, 2050],
    ]);
    expect(Canvas.sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(canvasProjections.buildCanvasSnapshot).toHaveBeenCalledTimes(1);
    expect(socketService.emitToRoom).toHaveBeenCalledTimes(1);
  });

  it("fix 7 end to end: team1 of the series is team1 on the group, its metadata, the VersusDraft and the broadcast", async () => {
    await post().expect(201);
    const group = CanvasGroup.create.mock.calls[0][0];
    const versusDraft = VersusDraft.create.mock.calls[0][0];
    expect(group.team1_id).toBe(T2);
    expect(group.team2_id).toBe(T1);
    expect(group.metadata.blueTeamName).toBe("Zeta Wolves");
    expect(group.metadata.redTeamName).toBe("Alpha Owls");
    expect(versusDraft.blueTeamName).toBe("Zeta Wolves");
    expect(versusDraft.redTeamName).toBe("Alpha Owls");
    // Sides stay per game (game 0 had team 2 on blue).
    expect(Draft.create.mock.calls.map(([d]) => [d.seriesIndex, d.blueSideTeam])).toEqual([
      [0, 2],
      [1, 1],
    ]);
    const broadcast = socketService.emitToRoom.mock.calls[0][2];
    expect(broadcast.groups[0]).toMatchObject({ team1_id: T2, team2_id: T1 });
    expect(broadcast.groups[0].metadata.blueTeamName).toBe("Zeta Wolves");
  });

  it("D11: canLinkTeam is consulted for both teams; a refusal skips not-linkable", async () => {
    const spy = vi.spyOn(teamAccess, "canLinkTeam").mockImplementation((t) => t.id !== T1);
    const res = await post();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: T2 }), USER);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: T1 }), USER);
    expect(res.status).toBe(200);
    expect(res.body.skipped).toEqual([{ leagueSeriesId: sid(1), reason: "not-linkable" }]);
    expect(VersusDraft.create).not.toHaveBeenCalled();
  });

  it("R3: the UserTournaments row is inserted if missing, never updated (an archived row stays archived)", async () => {
    await post().expect(201);
    expect(UserTournament.bulkCreate).toHaveBeenCalledTimes(1);
    expect(UserTournament.bulkCreate.mock.calls[0]).toEqual([
      [{ user_id: USER, tournament_id: TOURNAMENT, archived_at: null }],
      { ignoreDuplicates: true, transaction },
    ]);
    expect(UserTournament.update).not.toHaveBeenCalled();
  });

  it("no player data in the response, the broadcast or any row written", async () => {
    seriesRows = [seriesRow(1), seriesRow(2)];
    gameRows = [gameRow(sid(1), 0), gameRow(sid(1), 1), gameRow(sid(2), 0)];
    const res = await post({ leagueSeriesIds: [sid(1), sid(2)] });
    expect(res.status).toBe(201);
    expect(walkForPlayerData(res.body)).toEqual([]);
    const broadcast = socketService.emitToRoom.mock.calls[0][2];
    expect(broadcast.groups).toHaveLength(2);
    expect(broadcast.drafts).toHaveLength(3);
    expect(walkForPlayerData(broadcast)).toEqual([]);
    const written = [VersusDraft, Draft, CanvasGroup, CanvasDraft].flatMap((m) =>
      m.create.mock.calls.map((c) => c[0]),
    );
    expect(walkForPlayerData(written)).toEqual([]);
  });

  it("500 on a failed write: rolled back, generic body, only the error class logged", async () => {
    const leaky = new TypeError("row Player07#T07 broke");
    CanvasGroup.create.mockRejectedValueOnce(leaky);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to send league series" });
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(["Failed to send league series:", "TypeError"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Player07");
  });
});
