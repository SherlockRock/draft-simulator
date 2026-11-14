import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import express from "express";
import request from "supertest";

/**
 * S3 Task 5: `POST /api/canvas/:canvasId/group/:groupId/league-refresh` (plan
 * D6, D12, Q2 B, Q3 A) through the real route and service, models mocked and
 * stateful (a second press sees what the first wrote). The app mounts
 * routes/canvas.js first and routes/canvasLeague.js after it, as index.js
 * does. The SQL of each new query is captured in
 * tests/services/leagueCanvas/refresh.test.js.
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
const canvasWriteGuards = require("../../services/canvasWriteGuards");
const canvasProjections = require("../../routes/canvasProjections");
const { nextSeriesCardOrigin } = require("../../utils/seriesCardLayout");

const CANVAS = "cccccccc-0000-4000-8000-000000000001";
const OTHER_CANVAS = "cccccccc-0000-4000-8000-000000000002";
const GROUP = "99999999-0000-4000-8000-000000000001";
const VD = "77777777-0000-4000-8000-000000000001";
const SERIES = "bbbbbbbb-0000-4000-8000-000000000001";
const USER = "eeeeeeee-0000-4000-8000-000000000001";
const OWNER = "eeeeeeee-0000-4000-8000-000000000002";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const D0 = "dddddddd-0000-4000-8000-000000000000";
const D1 = "dddddddd-0000-4000-8000-000000000001";
const FIRST_Y = 172.5;
const urlFor = (canvasId = CANVAS, groupId = GROUP) =>
  `/api/canvas/${canvasId}/group/${groupId}/league-refresh`;

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

const picks = (tag) => Array.from({ length: 20 }, (_, i) => `${tag}Champ${i}`);

// Mirror games carry participants, as the mirror does: a mock returns what it
// is given, so this proves none of it is copied anywhere.
function gameRow(number, overrides = {}) {
  return {
    series_id: SERIES,
    number,
    picks: picks(`G${number}`),
    first_pick: "blue",
    blue_side_team: number % 2 === 0 ? 2 : 1,
    winner: "blue",
    complete: true,
    played_at: new Date("2026-11-11T19:00:00.000Z"),
    participants: {
      Ahri: { lane: "mid", playerKey: "oauth-riot-0007", gameName: "Player07", tagLine: "T07" },
      list: ["Player08#T08", { id_oauth_riot: "riot-0008" }],
    },
    ...overrides,
  };
}

function draftRow(id, number, overrides = {}) {
  const g = gameRow(number);
  return {
    id,
    versus_draft_id: VD,
    seriesIndex: number,
    picks: [...g.picks],
    picksVersion: 0,
    lastPickMutationId: null,
    firstPick: g.first_pick,
    blueSideTeam: g.blue_side_team,
    winner: g.winner,
    completed: true,
    ...overrides,
  };
}

// Deep walk: player keys anywhere, and gameName/tagLine anywhere except under
// a linked team's TeamPlayers roster (plan Q5 A). Strings are checked too,
// including strings inside arrays.
const FORBIDDEN_KEYS = new Set(["participants", "playerKey", "id_oauth_riot", "id_user"]);
const ROSTER_KEYS = new Set(["gameName", "tagLine"]);
const FORBIDDEN_STRINGS = ["Player07", "T07", "oauth-riot-0007", "Player08", "riot-0008"];

function walkForPlayerData(value, p = "", inRoster = false) {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...walkForPlayerData(v, `${p}[${i}]`, inRoster)));
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) hits.push(`${p}.${k}`);
      if (ROSTER_KEYS.has(k) && !inRoster) hits.push(`${p}.${k}`);
      const roster = inRoster || (k === "TeamPlayers" && /\.(Team1|Team2)$/.test(p));
      hits.push(...walkForPlayerData(v, `${p}.${k}`, roster));
    }
  } else if (typeof value === "string" && FORBIDDEN_STRINGS.some((s) => value.includes(s))) {
    hits.push(`${p}=${value}`);
  }
  return hits;
}

describe("the walker itself", () => {
  it("finds player data in keys, strings inside arrays, but allows a linked roster", () => {
    expect(walkForPlayerData({ a: [{ participants: {} }] })).toEqual([".a[0].participants"]);
    expect(walkForPlayerData({ a: ["x", "Player08#T08"] })).toEqual([".a[1]=Player08#T08"]);
    expect(walkForPlayerData({ d: { gameName: "Roster01" } })).toEqual([".d.gameName"]);
    expect(
      walkForPlayerData({ g: [{ Team1: { TeamPlayers: [{ gameName: "Roster01", tagLine: "R01" }] } }] }),
    ).toEqual([]);
  });
});

// The stored state, mutated by the mocked writes.
let db;
let calls;
let transaction;
let permissions;
let ids;

function freshDb() {
  return {
    group: {
      id: GROUP,
      canvas_id: CANVAS,
      name: "Week 3 · renamed by hand",
      type: "series",
      positionX: 1200,
      positionY: -340,
      versus_draft_id: VD,
      metadata: {
        blueTeamName: "Zeta Wolves",
        redTeamName: "Alpha Owls",
        gameType: "scrim",
        length: 3,
        disabledChampions: ["Ahri"],
        origin: "manual",
      },
    },
    versusDraft: {
      id: VD,
      name: "Zeta Wolves vs Alpha Owls",
      owner_id: OWNER,
      blueTeamName: "Zeta Wolves",
      redTeamName: "Alpha Owls",
      league_series_id: SERIES,
    },
    drafts: [draftRow(D0, 0)],
    cards: [{ id: "cd-0", canvas_id: CANVAS, group_id: GROUP, draft_id: D0, positionX: 0, positionY: FIRST_Y }],
    games: [gameRow(0)],
    series: {
      id: SERIES,
      status: "finished",
      complete: true,
      team1_id: T2,
      team2_id: T1,
      Team1: { id: T2, name: "Zeta Wolves" },
      Team2: { id: T1, name: "Alpha Owls" },
    },
  };
}

beforeEach(() => {
  db = freshDb();
  calls = [];
  ids = 0;
  permissions = "edit";
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
    transaction.finished = undefined;
    return transaction;
  });
  vi.spyOn(CanvasGroup, "findOne").mockImplementation(async ({ where }) => {
    calls.push("CanvasGroup.findOne");
    const g = db.group;
    return g && g.id === where.id && g.canvas_id === where.canvas_id
      ? { ...g, metadata: { ...g.metadata } }
      : null;
  });
  vi.spyOn(VersusDraft, "findOne").mockImplementation(async ({ where }) => {
    calls.push("VersusDraft.findOne");
    return db.versusDraft && db.versusDraft.id === where.id ? { ...db.versusDraft } : null;
  });
  vi.spyOn(Draft, "findAll").mockImplementation(async ({ where }) => {
    calls.push("Draft.findAll");
    return db.drafts.filter((d) => d.versus_draft_id === where.versus_draft_id).map((d) => ({ ...d }));
  });
  vi.spyOn(CanvasDraft, "findAll").mockImplementation(async ({ where }) => {
    calls.push("CanvasDraft.findAll");
    return db.cards
      .filter((c) => c.canvas_id === where.canvas_id && c.group_id === where.group_id)
      .map((c) => ({ ...c }));
  });
  vi.spyOn(LeagueGame, "findAll").mockImplementation(async () => {
    calls.push("LeagueGame.findAll");
    return db.games;
  });
  vi.spyOn(LeagueSeries, "findOne").mockImplementation(async () => {
    calls.push("LeagueSeries.findOne");
    return db.series;
  });
  vi.spyOn(Draft, "create").mockImplementation(async (v) => {
    const row = { picksVersion: 0, lastPickMutationId: null, ...v, id: `d-new-${++ids}` };
    db.drafts.push(row);
    return { ...row };
  });
  vi.spyOn(CanvasDraft, "create").mockImplementation(async (v) => {
    const row = { ...v, id: `cd-new-${++ids}` };
    db.cards.push(row);
    return { ...row };
  });
  vi.spyOn(Draft, "update").mockImplementation(async (values, { where }) => {
    calls.push("Draft.update");
    const d = db.drafts.find((x) => x.id === where.id && x.versus_draft_id === where.versus_draft_id);
    if (!d) return [0];
    for (const [k, v] of Object.entries(values)) {
      d[k] = k === "picksVersion" ? d.picksVersion + 1 : v;
    }
    return [1];
  });
  vi.spyOn(CanvasGroup, "update").mockImplementation(async (values) => {
    calls.push("CanvasGroup.update");
    Object.assign(db.group, values);
    return [1];
  });
  vi.spyOn(VersusDraft, "update").mockImplementation(async (values) => {
    calls.push("VersusDraft.update");
    Object.assign(db.versusDraft, values);
    return [1];
  });
  vi.spyOn(CanvasDraft, "update");
  vi.spyOn(canvasWriteGuards, "touchCanvasTimestamp").mockImplementation(async () => {
    calls.push("touch");
  });
  // The snapshot as clients get it: the group with linked teams (rosters
  // allowed, Q5 A) and the cards with their Drafts.
  vi.spyOn(canvasProjections, "buildCanvasSnapshot").mockImplementation(async () => {
    calls.push("snapshot");
    const roster = [{ gameName: "Roster01", tagLine: "R01", role: "mid" }];
    return {
      canvas: { id: CANVAS },
      groups: [
        {
          ...db.group,
          Team1: { id: T2, name: db.series.Team1?.name, TeamPlayers: roster },
          Team2: { id: T1, name: db.series.Team2?.name, TeamPlayers: roster },
        },
      ],
      drafts: db.cards.map((c) => ({ ...c, Draft: db.drafts.find((d) => d.id === c.draft_id) })),
    };
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {
    calls.push("emit");
  });
});

const press = (canvasId, groupId) => request(buildApp()).post(urlFor(canvasId, groupId)).send({});

describe("POST /api/canvas/:canvasId/group/:groupId/league-refresh", () => {
  it("401 without a session, before any query", async () => {
    auth.protect.mockRestore();
    const res = await press();
    expect(res.status).toBe(401);
    expect(UserCanvas.findOne).not.toHaveBeenCalled();
    expect(Canvas.sequelize.transaction).not.toHaveBeenCalled();
  });

  it("403 for a viewer, nothing read", async () => {
    permissions = "view";
    const res = await press();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: You don't have permission to edit this canvas" });
    expect(UserCanvas.findOne).toHaveBeenCalledWith({ where: { canvas_id: CANVAS, user_id: USER } });
    expect(Canvas.sequelize.transaction).not.toHaveBeenCalled();
    expect(CanvasGroup.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-uuid canvas id", "not-a-uuid", GROUP],
    ["a non-uuid group id", CANVAS, "1;DROP"],
  ])("400 for %s, before any query", async (_label, canvasId, groupId) => {
    const res = await press(canvasId, groupId);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(calls).toEqual([]);
  });

  it("404 for a group on another canvas, rolled back, no broadcast", async () => {
    db.group.canvas_id = OTHER_CANVAS;
    const res = await press();
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Group not found" });
    expect(CanvasGroup.findOne.mock.calls[0][0].where).toEqual({ id: GROUP, canvas_id: CANVAS });
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(VersusDraft.findOne).not.toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it.each([
    ["a manual series", () => { db.versusDraft.league_series_id = null; }],
    ["a purged import (league_series_id set NULL)", () => {
      db.versusDraft.league_series_id = null;
      db.group.team1_id = null;
    }],
    ["a non-series group", () => {
      db.group.type = "custom";
      db.group.versus_draft_id = null;
    }],
  ])("400 for %s, nothing written, no broadcast", async (_label, arrange) => {
    arrange();
    const res = await press();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Not an imported series" });
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(Draft.create).not.toHaveBeenCalled();
    expect(Draft.update).not.toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it("locks the VersusDraft row before the Drafts are read, after the access check", async () => {
    await press().expect(200);
    expect(calls.slice(0, 5)).toEqual([
      "UserCanvas.findOne",
      "transaction",
      "CanvasGroup.findOne",
      "VersusDraft.findOne",
      "Draft.findAll",
    ]);
    expect(VersusDraft.findOne.mock.calls[0][0]).toMatchObject({ where: { id: VD }, lock: true, transaction });
  });

  it("appends after the last card by positionX; never moves a card or the group; one snapshot, one broadcast", async () => {
    db.drafts.push(draftRow(D1, 1));
    // The last card by x is not the last in the array.
    db.cards = [
      { id: "cd-1", canvas_id: CANVAS, group_id: GROUP, draft_id: D1, positionX: 380, positionY: FIRST_Y },
      { id: "cd-0", canvas_id: CANVAS, group_id: GROUP, draft_id: D0, positionX: 0, positionY: FIRST_Y },
    ];
    db.games = [gameRow(0), gameRow(1), gameRow(2)];
    const groupBefore = { ...db.group };
    const res = await press();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: 1, updated: 0, series: { status: "finished", complete: true } });

    const origin = nextSeriesCardOrigin({ positionX: 380, positionY: FIRST_Y });
    expect(CanvasDraft.create).toHaveBeenCalledTimes(1);
    expect(CanvasDraft.create.mock.calls[0][0]).toEqual({
      canvas_id: CANVAS,
      group_id: GROUP,
      draft_id: "d-new-1",
      positionX: origin.x,
      positionY: origin.y,
      is_locked: true,
      source_type: "versus",
    });
    expect(Draft.create.mock.calls[0][0]).toMatchObject({ versus_draft_id: VD, seriesIndex: 2, owner_id: OWNER });
    expect(CanvasDraft.update).not.toHaveBeenCalled();
    expect(CanvasGroup.update).not.toHaveBeenCalled();
    expect(db.group).toEqual(groupBefore);
    expect(db.cards.slice(0, 2).map((c) => c.positionX)).toEqual([380, 0]);

    expect(calls.slice(calls.indexOf("commit"))).toEqual(["commit", "touch", "snapshot", "emit"]);
    expect(canvasWriteGuards.touchCanvasTimestamp).toHaveBeenCalledWith(CANVAS);
    expect(canvasProjections.buildCanvasSnapshot).toHaveBeenCalledTimes(1);
    expect(canvasProjections.buildCanvasSnapshot).toHaveBeenCalledWith(CANVAS);
    expect(socketService.emitToRoom).toHaveBeenCalledTimes(1);
    const [room, event, payload] = socketService.emitToRoom.mock.calls[0];
    expect([room, event]).toEqual([CANVAS, "canvasUpdate"]);
    expect(payload).toBe(await canvasProjections.buildCanvasSnapshot.mock.results[0].value);
  });

  it("a card dragged out of the group: not re-added, still updated", async () => {
    db.drafts.push(draftRow(D1, 1, { winner: null, completed: false }));
    // D1's card sits on the canvas outside the group.
    db.cards.push({ id: "cd-1", canvas_id: CANVAS, group_id: null, draft_id: D1, positionX: 5000, positionY: 5000 });
    db.games = [gameRow(0), gameRow(1)];
    const res = await press();
    expect(res.body).toMatchObject({ added: 0, updated: 1 });
    expect(Draft.create).not.toHaveBeenCalled();
    expect(CanvasDraft.create).not.toHaveBeenCalled();
    const d1 = db.drafts.find((d) => d.id === D1);
    expect(d1).toMatchObject({ winner: "blue", completed: true });
    expect(db.cards.find((c) => c.id === "cd-1")).toMatchObject({ group_id: null, positionX: 5000 });
  });

  it("winner filled where null (completed, completedAt)", async () => {
    db.drafts = [draftRow(D0, 0, { winner: null, completed: false })];
    const res = await press();
    expect(res.body).toMatchObject({ added: 0, updated: 1 });
    expect(db.drafts[0]).toMatchObject({
      winner: "blue",
      completed: true,
      completedAt: new Date("2026-11-11T19:00:00.000Z"),
    });
    expect(db.drafts[0].picksVersion).toBe(0);
  });

  it("Q2 B: picks follow an incomplete mirror game, bumping picksVersion and clearing lastPickMutationId", async () => {
    db.drafts = [draftRow(D0, 0, { winner: null, completed: false, picksVersion: 4, lastPickMutationId: "m-1" })];
    db.games = [gameRow(0, { picks: picks("Live"), winner: null, complete: false })];
    db.series = { ...db.series, status: "in_progress", complete: false };
    const res = await press();
    expect(res.body).toEqual({ added: 0, updated: 1, series: { status: "in_progress", complete: false } });
    expect(db.drafts[0]).toMatchObject({ picks: picks("Live"), picksVersion: 5, lastPickMutationId: null, winner: null });
  });

  it("names rewritten from the linked teams on group and VersusDraft; gameType and group name kept", async () => {
    db.series = {
      ...db.series,
      Team1: { id: T2, name: "Zeta Wolves II" },
      Team2: { id: T1, name: "Alpha Owls Academy" },
    };
    const res = await press();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 0, updated: 0 });
    expect(db.group.metadata).toEqual({
      blueTeamName: "Zeta Wolves II",
      redTeamName: "Alpha Owls Academy",
      gameType: "scrim",
      length: 3,
      disabledChampions: ["Ahri"],
      origin: "manual",
    });
    expect(db.group.name).toBe("Week 3 · renamed by hand");
    expect(db.group).toMatchObject({ positionX: 1200, positionY: -340 });
    expect(Object.keys(CanvasGroup.update.mock.calls[0][0])).toEqual(["metadata"]);
    expect(db.versusDraft).toMatchObject({ blueTeamName: "Zeta Wolves II", redTeamName: "Alpha Owls Academy" });
    expect(socketService.emitToRoom).toHaveBeenCalledTimes(1);
  });

  it("nothing changed: 200, no timestamp touch, no snapshot, no broadcast", async () => {
    const res = await press();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: 0, updated: 0, series: { status: "finished", complete: true } });
    expect(canvasWriteGuards.touchCanvasTimestamp).not.toHaveBeenCalled();
    expect(canvasProjections.buildCanvasSnapshot).not.toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it("idempotent: the second press changes nothing and broadcasts nothing", async () => {
    db.drafts = [draftRow(D0, 0, { winner: null, completed: false, picks: picks("Old") })];
    db.games = [gameRow(0), gameRow(1), gameRow(2)];
    db.series = { ...db.series, Team1: { id: T2, name: "Zeta Wolves II" } };
    const first = await press();
    expect(first.body).toMatchObject({ added: 2, updated: 1 });
    expect(socketService.emitToRoom).toHaveBeenCalledTimes(1);
    const draftsAfter = JSON.stringify(db.drafts);
    const cardsAfter = JSON.stringify(db.cards);

    const second = await press();
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ added: 0, updated: 0, series: { status: "finished", complete: true } });
    expect(socketService.emitToRoom).toHaveBeenCalledTimes(1);
    expect(canvasWriteGuards.touchCanvasTimestamp).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.drafts)).toBe(draftsAfter);
    expect(JSON.stringify(db.cards)).toBe(cardsAfter);
  });

  it("no player data in the response or the broadcast (deep walk, strings in arrays too)", async () => {
    db.drafts = [draftRow(D0, 0, { winner: null, completed: false, picks: picks("Old") })];
    db.games = [gameRow(0), gameRow(1)];
    const res = await press();
    expect(res.status).toBe(200);
    expect(walkForPlayerData(res.body)).toEqual([]);
    const broadcast = socketService.emitToRoom.mock.calls[0][2];
    expect(broadcast.drafts).toHaveLength(2);
    expect(walkForPlayerData(broadcast)).toEqual([]);
    expect(walkForPlayerData(db.drafts)).toEqual([]);
  });

  it("500 on a failed write: rolled back, generic body, only the error class logged", async () => {
    db.games = [gameRow(0), gameRow(1)];
    Draft.create.mockRejectedValueOnce(new TypeError("row Player07#T07 broke"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await press();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to refresh league series" });
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([["Failed to refresh league series:", "TypeError"]]);
  });
});

describe("no esclub module behind the route", () => {
  it("requiring routes/canvasLeague in a fresh process loads nothing from services/esclub", () => {
    const backendDir = path.resolve(path.dirname(require.resolve("../../routes/canvasLeague")), "..");
    const script = [
      "require('./routes/canvasLeague');",
      "const loaded = Object.keys(require.cache).filter((k) => k.split(require('path').sep).join('/').includes('/services/esclub/'));",
      "process.stdout.write(JSON.stringify({ ok: true, loaded }));",
    ].join("\n");
    const out = execFileSync(process.execPath, ["-e", script], {
      cwd: backendDir,
      timeout: 60000,
      env: { ...process.env, DB_NAME: "no_db", DB_HOST: "127.0.0.1" },
      encoding: "utf8",
    });
    const parsed = JSON.parse(out.slice(out.indexOf("{")));
    expect(parsed.ok).toBe(true);
    expect(parsed.loaded).toEqual([]);
  });

  it("a refresh press never touches the esclub client (its module would throw if constructed)", async () => {
    const clientPath = require.resolve("../../services/esclub/client");
    const transportPath = require.resolve("../../services/esclub/requests");
    const saved = [clientPath, transportPath].map((p) => [p, require.cache[p]]);
    try {
      for (const p of [clientPath, transportPath]) {
        require.cache[p] = {
          id: p,
          filename: p,
          loaded: true,
          get exports() {
            throw new Error(`esclub module required: ${p}`);
          },
        };
      }
      db.games = [gameRow(0), gameRow(1)];
      const res = await press();
      expect(res.status).toBe(200);
      expect(res.body.added).toBe(1);
    } finally {
      for (const [p, mod] of saved) {
        if (mod) require.cache[p] = mod;
        else delete require.cache[p];
      }
    }
  });
});
