import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
  CanvasAnnotation,
  CanvasPoolPlacement,
} = require("../../models/Canvas.js");
const Draft = require("../../models/Draft.js");
const VersusDraft = require("../../models/VersusDraft.js");
const Team = require("../../models/Team");

function loadRouter() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  return require("../../routes/canvas");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", loadRouter());
  return app;
}

const T_BLUE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const T_RED = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T_ELSE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const T_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// The custom group that is about to become a series. `update` records the
// persisted patch so the test can assert team links survive the conversion.
function mockGroup() {
  return {
    id: "g-1",
    canvas_id: "c-1",
    type: "custom",
    positionX: 0,
    positionY: 0,
    metadata: {},
    update: vi.fn().mockResolvedValue(),
    toJSON() {
      return { id: this.id, canvas_id: this.canvas_id, type: "series" };
    },
  };
}

let group;
let transaction;

beforeEach(() => {
  vi.restoreAllMocks();
  group = mockGroup();
  transaction = {
    commit: vi.fn().mockResolvedValue(),
    rollback: vi.fn().mockResolvedValue(),
    finished: false,
  };

  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(transaction);
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
    toJSON: () => ({ id: "c-1" }),
  });

  vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "count").mockResolvedValue(0);
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasDraft, "create").mockImplementation(async (values) => ({
    ...values,
    toJSON: () => values,
  }));
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "count").mockResolvedValue(0);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(Draft, "create").mockImplementation(async (values) => ({
    ...values,
    id: "d-1",
    toJSON: () => values,
  }));
  vi.spyOn(VersusDraft, "create").mockResolvedValue({
    id: "vd-1",
    blueTeamName: "MEOW",
    redTeamName: "TSR",
    length: 1,
    type: "standard",
    disabledChampions: [],
  });
  vi.spyOn(Team, "findAll").mockResolvedValue([
    { id: T_BLUE, source: "esclub", owner_id: null },
    { id: T_RED, source: "manual", owner_id: "u1" },
  ]);
});

const convert = (body) =>
  request(buildApp())
    .post("/api/canvas/c-1/group/g-1/convert-to-series")
    .send({
      name: "Custom Series",
      blueTeamName: "MEOW",
      redTeamName: "TSR",
      length: 1,
      type: "standard",
      disabledChampions: [],
      ...body,
    });

describe("POST convert-to-series team linking", () => {
  it("persists team1_id/team2_id chosen at series-creation time", async () => {
    const res = await convert({ team1_id: T_BLUE, team2_id: T_RED });

    expect(res.status).toBe(201);
    const patch = group.update.mock.calls.at(-1)[0];
    expect(patch.team1_id).toBe(T_BLUE);
    expect(patch.team2_id).toBe(T_RED);
    expect(transaction.commit).toHaveBeenCalled();
  });

  // One query, for exactly the ids in the body. The candidate set must never
  // widen to "every team the user owns" (or every team).
  it("makes one Team query for exactly the new ids, inside the transaction", async () => {
    await convert({ team1_id: T_BLUE, team2_id: T_RED });

    expect(Team.findAll).toHaveBeenCalledTimes(1);
    expect(Team.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: [T_BLUE, T_RED] },
        transaction,
      }),
    );
  });

  it("links an imported team for an editor who owns nothing", async () => {
    const res = await convert({ team1_id: T_BLUE });

    expect(res.status).toBe(201);
    expect(group.update.mock.calls.at(-1)[0].team1_id).toBe(T_BLUE);
  });

  it("refuses someone else's pickup team that the editor only sees through this canvas", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_ELSE, source: "manual", owner_id: "someone-else" },
    ]);

    const res = await convert({ team2_id: T_ELSE });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team2_id must reference a team you can link");
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("does not query teams for an unchanged or null id", async () => {
    group.team1_id = T_OWNER;
    const res = await convert({ team1_id: T_OWNER, team2_id: null });

    expect(res.status).toBe(201);
    expect(Team.findAll).not.toHaveBeenCalled();
  });

  it("leaves team links untouched when the body omits them", async () => {
    const res = await convert({});

    expect(res.status).toBe(201);
    const patch = group.update.mock.calls.at(-1)[0];
    expect(patch).not.toHaveProperty("team1_id");
    expect(patch).not.toHaveProperty("team2_id");
  });

  it("rejects a team the requesting user cannot link", async () => {
    const res = await convert({ team1_id: T_ELSE });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team1_id must reference a team you can link");
    expect(VersusDraft.create).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("passes the team already linked on the group for a user who does not own it", async () => {
    group.team1_id = T_OWNER;
    group.team2_id = null;

    const res = await convert({ team1_id: T_OWNER });

    expect(res.status).toBe(201);
    expect(group.update.mock.calls.at(-1)[0].team1_id).toBe(T_OWNER);
  });

  it("returns the group hydrated with its linked teams so the client can render Scout", async () => {
    const hydrated = {
      toJSON: () => ({
        id: "g-1",
        type: "series",
        team1_id: T_BLUE,
        Team1: { id: T_BLUE, name: "MEOW", region: "na1", TeamPlayers: [] },
        Team2: null,
      }),
    };
    CanvasGroup.findOne.mockImplementation(async (options) =>
      options?.include ? hydrated : group,
    );

    const res = await convert({ team1_id: T_BLUE });

    expect(res.status).toBe(201);
    expect(res.body.group.team1_id).toBe(T_BLUE);
    expect(res.body.group.Team1).toMatchObject({ id: T_BLUE, name: "MEOW" });
  });
});
