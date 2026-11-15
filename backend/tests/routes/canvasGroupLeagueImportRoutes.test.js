import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

/**
 * S3 Task 3 (D8): every path that hands a client a group carries
 * `LeagueImport` (a missing key erases it on reconciling clients) and never
 * the raw `VersusDraft` → `LeagueSeries` rows: the GET canvas route, the
 * convert-to-series reload, the group PUT reload, and their broadcasts.
 */

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const canvasMutations = require("../../services/canvasMutations");
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
const { GROUP_INCLUDE } = require("../../routes/canvasProjections");

const SERIES_ID = "11111111-1111-4111-8111-111111111111";
const TOURNAMENT_ID = "22222222-2222-4222-8222-222222222222";

const LEAGUE_IMPORT = {
  leagueSeriesId: SERIES_ID,
  tournamentId: TOURNAMENT_ID,
  stageName: "Regular Season",
  startsAt: "2026-11-11T18:00:00.000Z",
  status: "finished",
  complete: true,
  esclubUrl: "https://esclub.gg/serie/9876",
};

const importedVersusDraft = () => ({
  id: "vd-1",
  league_series_id: SERIES_ID,
  LeagueSeries: {
    id: SERIES_ID,
    external_id: "9876",
    tournament_id: TOURNAMENT_ID,
    starts_at: new Date("2026-11-11T18:00:00.000Z"),
    status: "finished",
    complete: true,
    Stage: { id: "s-1", name: "Regular Season" },
  },
});

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

// A group instance as Sequelize hands it back with GROUP_INCLUDE.
function groupInstance(overrides = {}) {
  return {
    id: "g-1",
    canvas_id: "c-1",
    name: "Series",
    type: "series",
    positionX: 0,
    positionY: 0,
    width: null,
    height: null,
    versus_draft_id: "vd-1",
    team1_id: null,
    team2_id: null,
    metadata: {},
    VersusDraft: importedVersusDraft(),
    update: vi.fn(async function (values) {
      Object.assign(this, values);
    }),
    toJSON() {
      const { update: _update, toJSON: _toJSON, ...rest } = this;
      return rest;
    },
    ...overrides,
  };
}

let transaction;

beforeEach(() => {
  vi.restoreAllMocks();
  transaction = {
    commit: vi.fn().mockResolvedValue(),
    rollback: vi.fn().mockResolvedValue(),
    finished: false,
  };
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(auth, "getUserFromRequest").mockResolvedValue({ id: "u1" });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({
    permissions: "edit",
    lastViewportX: 0,
    lastViewportY: 0,
    lastZoomLevel: 1,
  });
  vi.spyOn(canvasMutations, "assertCanvasAccess").mockResolvedValue(undefined);
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(transaction);
  vi.spyOn(Canvas, "findOne").mockResolvedValue({
    id: "c-1",
    name: "Canvas",
    description: "",
    cardLayout: "wide",
    toJSON: () => ({ id: "c-1", name: "Canvas" }),
  });
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
    toJSON: () => ({ id: "c-1" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "count").mockResolvedValue(0);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "count").mockResolvedValue(0);
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
});

const broadcastGroups = () => {
  const call = socketService.emitToRoom.mock.calls.find(
    (c) => c[1] === "canvasUpdate",
  );
  return call?.[2]?.groups;
};

describe("GET /:canvasId", () => {
  it("loads groups with GROUP_INCLUDE and returns LeagueImport, not the raw rows", async () => {
    const findAll = vi
      .spyOn(CanvasGroup, "findAll")
      .mockResolvedValue([
        groupInstance(),
        groupInstance({ id: "g-2", versus_draft_id: null, VersusDraft: null }),
      ]);

    const res = await request(buildApp()).get("/api/canvas/c-1");

    expect(res.status).toBe(200);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ include: GROUP_INCLUDE }),
    );
    expect(res.body.groups[0].LeagueImport).toEqual(LEAGUE_IMPORT);
    expect(res.body.groups[0].isInProgress).toBe(false);
    expect(res.body.groups[1].LeagueImport).toBeNull();
    for (const group of res.body.groups) {
      expect(group).not.toHaveProperty("VersusDraft");
    }
  });
});

describe("POST /:canvasId/group/:groupId/convert-to-series", () => {
  it("reloads the group with GROUP_INCLUDE; a new manual series gets LeagueImport: null", async () => {
    const custom = groupInstance({
      type: "custom",
      versus_draft_id: null,
      VersusDraft: undefined,
    });
    const reloaded = groupInstance({
      VersusDraft: { id: "vd-1", league_series_id: null, LeagueSeries: null },
    });
    const findOne = vi
      .spyOn(CanvasGroup, "findOne")
      .mockImplementation(async (options) =>
        options?.include ? reloaded : custom,
      );
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasDraft, "create").mockImplementation(async (values) => ({
      ...values,
      toJSON: () => values,
    }));
    vi.spyOn(Draft, "create").mockImplementation(async (values) => ({
      ...values,
      id: "d-1",
      toJSON: () => values,
    }));
    vi.spyOn(VersusDraft, "create").mockResolvedValue({
      id: "vd-1",
      blueTeamName: "Blue",
      redTeamName: "Red",
      length: 1,
      type: "standard",
      disabledChampions: [],
    });

    const res = await request(buildApp())
      .post("/api/canvas/c-1/group/g-1/convert-to-series")
      .send({
        name: "Custom Series",
        blueTeamName: "Blue",
        redTeamName: "Red",
        length: 1,
        type: "standard",
        disabledChampions: [],
      });

    expect(res.status).toBe(201);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ include: GROUP_INCLUDE }),
    );
    expect(res.body.group).toHaveProperty("LeagueImport", null);
    expect(res.body.group).not.toHaveProperty("VersusDraft");
  });
});

describe("PUT /:canvasId/group/:groupId", () => {
  it("reloads with GROUP_INCLUDE; the response and broadcast carry LeagueImport", async () => {
    const group = groupInstance();
    const findOne = vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([groupInstance()]);

    const res = await request(buildApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ positionX: 250, positionY: 300 });

    expect(res.status).toBe(200);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ include: GROUP_INCLUDE }),
    );
    expect(res.body.group.LeagueImport).toEqual(LEAGUE_IMPORT);
    expect(res.body.group).not.toHaveProperty("VersusDraft");
    const groups = broadcastGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].LeagueImport).toEqual(LEAGUE_IMPORT);
    expect(groups[0]).not.toHaveProperty("VersusDraft");
  });
});
