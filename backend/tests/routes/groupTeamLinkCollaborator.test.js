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
const VersusDraft = require("../../models/VersusDraft.js");
const Team = require("../../models/Team");
const canvasMutations = require("../../services/canvasMutations");

/**
 * A collaborator (edit access, owns no teams) saving settings on a group that
 * the canvas owner linked to the owner's team. The Group Settings dialog always
 * sends the group's current team1_id/team2_id back, so the save must not be
 * refused for an id that did not change (Teams decision 10).
 */

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

let group;
let transaction;
let versusDraft;

beforeEach(() => {
  vi.restoreAllMocks();
  transaction = {
    commit: vi.fn().mockResolvedValue(),
    rollback: vi.fn().mockResolvedValue(),
    finished: false,
  };
  group = {
    id: "g-1",
    canvas_id: "c-1",
    name: "Series",
    type: "series",
    positionX: 0,
    positionY: 0,
    width: 600,
    height: 400,
    versus_draft_id: "vd-1",
    team1_id: "t-owner",
    team2_id: null,
    metadata: { gameType: "scrim" },
    update: vi.fn(async function (values) {
      Object.assign(this, values);
    }),
    toJSON() {
      return { ...this };
    },
  };
  versusDraft = {
    id: "vd-1",
    origin: "manual",
    name: "Series",
    blueTeamName: "MEOW",
    redTeamName: "TSR",
    length: 1,
    type: "standard",
    disabledChampions: [],
    update: vi.fn().mockResolvedValue(),
    toJSON() {
      return { ...this };
    },
  };

  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u-editor" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  vi.spyOn(canvasMutations, "assertCanvasAccess").mockResolvedValue(undefined);
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(transaction);
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
    toJSON: () => ({ id: "c-1" }),
  });
  vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(VersusDraft, "findByPk").mockResolvedValue(versusDraft);
  // The editor owns no teams.
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
});

const putGroup = (body) =>
  request(buildApp()).put("/api/canvas/c-1/group/g-1").send(body);

describe("PUT group by a collaborator who owns no teams", () => {
  it("saves a setting when the dialog sends the unchanged team ids back", async () => {
    const res = await putGroup({
      metadata: { disabledChampions: ["Ahri"] },
      team1_id: "t-owner",
      team2_id: null,
    });

    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(versusDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({ disabledChampions: ["Ahri"] }),
      expect.anything(),
    );
    const patch = group.update.mock.calls.at(-1)[0];
    expect(patch.metadata).toMatchObject({ gameType: "scrim" });
    expect(patch.team1_id).toBe("t-owner");
    expect(patch.team2_id).toBe(null);
    expect(transaction.commit).toHaveBeenCalled();
  });

  it("still refuses a team that is neither owned nor already linked", async () => {
    const res = await putGroup({
      metadata: { disabledChampions: ["Ahri"] },
      team1_id: "t-other",
      team2_id: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team1_id must reference a team you own");
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(group.update).not.toHaveBeenCalled();
  });

  it("refuses the linked id moved into the other slot", async () => {
    const res = await putGroup({ team1_id: null, team2_id: "t-owner" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team2_id must reference a team you own");
  });
});
