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

const T_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T_IMPORTED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
    team1_id: T_OWNER,
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
      team1_id: T_OWNER,
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
    expect(patch.team1_id).toBe(T_OWNER);
    expect(patch.team2_id).toBe(null);
    expect(transaction.commit).toHaveBeenCalled();
  });

  it("still refuses a team that is neither owned nor already linked", async () => {
    const res = await putGroup({
      metadata: { disabledChampions: ["Ahri"] },
      team1_id: T_OTHER,
      team2_id: null,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team1_id must reference a team you can link");
    expect(transaction.rollback).toHaveBeenCalled();
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(group.update).not.toHaveBeenCalled();
  });

  it("refuses the linked id moved into the other slot", async () => {
    const res = await putGroup({ team1_id: null, team2_id: T_OWNER });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team2_id must reference a team you can link");
  });

  it("does not query teams at all when every id is unchanged or null", async () => {
    await putGroup({ team1_id: T_OWNER, team2_id: null });

    expect(Team.findAll).not.toHaveBeenCalled();
  });

  it("makes one Team query for exactly the new ids, inside the transaction", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_IMPORTED, source: "esclub", owner_id: null },
    ]);

    const res = await putGroup({ team1_id: T_OWNER, team2_id: T_IMPORTED });

    expect(res.status).toBe(200);
    expect(Team.findAll).toHaveBeenCalledTimes(1);
    expect(Team.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: [T_IMPORTED] },
        transaction,
      }),
    );
  });

  it("lets any editor link an imported team", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_IMPORTED, source: "esclub", owner_id: null },
    ]);

    const res = await putGroup({ team2_id: T_IMPORTED });

    expect(res.status).toBe(200);
    expect(group.update.mock.calls.at(-1)[0].team2_id).toBe(T_IMPORTED);
  });

  it("refuses someone else's pickup team that is only visible through this canvas", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_OTHER, source: "manual", owner_id: "someone-else" },
    ]);

    const res = await putGroup({ team2_id: T_OTHER });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team2_id must reference a team you can link");
    expect(group.update).not.toHaveBeenCalled();
  });

  it("refuses to move the canvas-only team into the other slot", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_OWNER, source: "manual", owner_id: "someone-else" },
    ]);

    const res = await putGroup({ team1_id: null, team2_id: T_OWNER });

    expect(res.status).toBe(400);
    expect(Team.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: [T_OWNER] } }),
    );
  });

  it("unlinks with null from any editor", async () => {
    const res = await putGroup({ team1_id: null });

    expect(res.status).toBe(200);
    expect(group.update.mock.calls.at(-1)[0].team1_id).toBe(null);
    expect(Team.findAll).not.toHaveBeenCalled();
  });

  it("answers 400 (not a database error) for a malformed id", async () => {
    const res = await putGroup({ team1_id: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(Team.findAll).not.toHaveBeenCalled();
  });
});

// Teams T3 Task 5 (Rourke's Q2 A): a team already linked on a group of THIS
// canvas may be linked onto another group, or the other slot, by any editor of
// the canvas, even a teammate's pickup team the editor cannot link in their own
// right. Anywhere else the own-right rule still holds.
describe("PUT group: linking a team already linked on this canvas", () => {
  const T_MATE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  // Stands in for the CanvasGroups table: the link lookup is the only
  // findAll with these attributes, and it honours canvas_id like the database.
  const linkedRows = (rows) => {
    CanvasGroup.findAll.mockImplementation(async (options) => {
      if (!options?.attributes || options.attributes.join() !== "team1_id,team2_id") {
        return [];
      }
      const canvasId = options.where.canvas_id;
      return rows.filter((row) => canvasId === undefined || row.canvas_id === canvasId);
    });
  };
  const matesTeam = () =>
    Team.findAll.mockResolvedValue([
      { id: T_MATE, source: "manual", owner_id: "teammate" },
    ]);

  it("links the teammate's team, linked on another group of the canvas, to this group", async () => {
    matesTeam();
    linkedRows([{ canvas_id: "c-1", team1_id: T_MATE, team2_id: null }]);

    const res = await putGroup({ team2_id: T_MATE });

    expect(res.status).toBe(200);
    expect(group.update.mock.calls.at(-1)[0].team2_id).toBe(T_MATE);
    expect(CanvasGroup.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ canvas_id: "c-1" }),
        transaction,
      }),
    );
  });

  it("swaps the two slots of the same group", async () => {
    group.team1_id = T_OWNER;
    group.team2_id = T_MATE;
    Team.findAll.mockResolvedValue([
      { id: T_OWNER, source: "manual", owner_id: "teammate" },
      { id: T_MATE, source: "manual", owner_id: "teammate" },
    ]);
    linkedRows([{ canvas_id: "c-1", team1_id: T_OWNER, team2_id: T_MATE }]);

    const res = await putGroup({ team1_id: T_MATE, team2_id: T_OWNER });

    expect(res.status).toBe(200);
    const patch = group.update.mock.calls.at(-1)[0];
    expect(patch.team1_id).toBe(T_MATE);
    expect(patch.team2_id).toBe(T_OWNER);
  });

  it("refuses the same id when it is linked only on another canvas", async () => {
    matesTeam();
    linkedRows([{ canvas_id: "c-2", team1_id: T_MATE, team2_id: null }]);

    const res = await putGroup({ team2_id: T_MATE });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("team2_id must reference a team you can link");
    expect(group.update).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalled();
  });

  it("refuses a team linked nowhere on the canvas", async () => {
    matesTeam();
    linkedRows([]);

    const res = await putGroup({ team2_id: T_MATE });

    expect(res.status).toBe(400);
  });

  it("looks the canvas links up only for ids the own-right rule refused", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_IMPORTED, source: "esclub", owner_id: null },
    ]);
    linkedRows([]);

    const res = await putGroup({ team2_id: T_IMPORTED });

    expect(res.status).toBe(200);
    expect(CanvasGroup.findAll).not.toHaveBeenCalledWith(
      expect.objectContaining({ attributes: ["team1_id", "team2_id"] }),
    );
  });

  it("still links the editor's own team and still unlinks with null", async () => {
    Team.findAll.mockResolvedValue([
      { id: T_MATE, source: "manual", owner_id: "u-editor" },
    ]);
    linkedRows([]);

    const linked = await putGroup({ team2_id: T_MATE });
    expect(linked.status).toBe(200);
    expect(group.update.mock.calls.at(-1)[0].team2_id).toBe(T_MATE);

    const unlinked = await putGroup({ team1_id: null });
    expect(unlinked.status).toBe(200);
    expect(group.update.mock.calls.at(-1)[0].team1_id).toBe(null);
  });
});
