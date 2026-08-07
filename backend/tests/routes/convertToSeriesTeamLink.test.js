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
    { id: "t-blue" },
    { id: "t-red" },
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
    const res = await convert({ team1_id: "t-blue", team2_id: "t-red" });

    expect(res.status).toBe(201);
    const patch = group.update.mock.calls.at(-1)[0];
    expect(patch.team1_id).toBe("t-blue");
    expect(patch.team2_id).toBe("t-red");
    expect(transaction.commit).toHaveBeenCalled();
  });

  // Without this the candidate set could silently widen to every team in the
  // system and the "does not own" test below would still pass.
  it("only considers teams owned by the requesting user", async () => {
    await convert({ team1_id: "t-blue" });

    expect(Team.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { owner_id: "u1" } }),
    );
  });

  it("leaves team links untouched when the body omits them", async () => {
    const res = await convert({});

    expect(res.status).toBe(201);
    const patch = group.update.mock.calls.at(-1)[0];
    expect(patch).not.toHaveProperty("team1_id");
    expect(patch).not.toHaveProperty("team2_id");
  });

  it("rejects a team the requesting user does not own", async () => {
    const res = await convert({ team1_id: "t-someone-else" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team1_id must reference a team you own");
    expect(VersusDraft.create).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("returns the group hydrated with its linked teams so the client can render Scout", async () => {
    const hydrated = {
      toJSON: () => ({
        id: "g-1",
        type: "series",
        team1_id: "t-blue",
        Team1: { id: "t-blue", name: "MEOW", region: "na1", TeamPlayers: [] },
        Team2: null,
      }),
    };
    CanvasGroup.findOne.mockImplementation(async (options) =>
      options?.include ? hydrated : group,
    );

    const res = await convert({ team1_id: "t-blue" });

    expect(res.status).toBe(201);
    expect(res.body.group.team1_id).toBe("t-blue");
    expect(res.body.group.Team1).toMatchObject({ id: "t-blue", name: "MEOW" });
  });
});
