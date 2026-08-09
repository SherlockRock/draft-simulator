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
const canvasMutations = require("../../services/canvasMutations");

/**
 * What `PUT /:canvasId/group/:groupId` returns when a manual series' LENGTH
 * changes.
 *
 * New game Cards are created server-side in `syncManualSeriesLength`, so the
 * saving client's own store holds the pre-growth count. `footprintOf` derives a
 * series' column span from those Cards, so without them the client reflows the
 * parent grid against a stale footprint and displaces nothing. Returning the
 * Cards to the saving client also makes it the SINGLE writer — the canvasUpdate
 * broadcast reaches every editor and names no group, so reflowing from it would
 * have N clients each commit (design §6.1).
 */

function buildCanvasApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

const SERIES_PADDING_X = 0;
const SERIES_PADDING_Y = 20;
const SERIES_HEADER_HEIGHT = 56;
const SERIES_GAME_STEP = 380;

// A stored game Card, in the shape the response builder reads it back in.
const cardRow = (index) => ({
  id: `cd-${index}`,
  canvas_id: "c-1",
  draft_id: `d-${index}`,
  group_id: "g-1",
  positionX: SERIES_PADDING_X + index * SERIES_GAME_STEP,
  positionY: SERIES_HEADER_HEIGHT + SERIES_PADDING_Y,
  is_locked: false,
  source_type: "versus",
  Draft: {
    id: `d-${index}`,
    seriesIndex: index,
    toJSON() {
      return { id: `d-${index}`, seriesIndex: index };
    },
  },
  toJSON() {
    const { Draft: _draft, toJSON: _toJSON, ...rest } = this;
    return rest;
  },
});

let group;
let versusDraft;

beforeEach(() => {
  vi.restoreAllMocks();
  const transaction = {
    commit: vi.fn().mockResolvedValue(),
    rollback: vi.fn().mockResolvedValue(),
    finished: false,
  };

  group = {
    id: "g-1",
    canvas_id: "c-1",
    name: "Series",
    type: "series",
    positionX: 100,
    positionY: 100,
    width: null,
    height: null,
    versus_draft_id: "vd-1",
    parent_group_id: "p-1",
    metadata: { seriesType: "standard", length: 3 },
    update: vi.fn(async function (values) {
      Object.assign(this, values);
    }),
    toJSON() {
      return { ...this };
    },
  };

  versusDraft = {
    id: "vd-1",
    name: "Series",
    origin: "manual",
    owner_id: "u1",
    length: 3,
    type: "standard",
    update: vi.fn(async function (values) {
      Object.assign(this, values);
    }),
    toJSON() {
      return { ...this };
    },
  };

  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
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
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
  vi.spyOn(VersusDraft, "findByPk").mockResolvedValue(versusDraft);

  // The series holds 3 games before the change.
  vi.spyOn(Draft, "findAll").mockResolvedValue(
    [0, 1, 2].map((i) => ({ id: `d-${i}`, seriesIndex: i, picks: [] })),
  );
  vi.spyOn(Draft, "create").mockImplementation(async (values) => ({
    id: `d-${values.seriesIndex}`,
    ...values,
  }));
  vi.spyOn(CanvasDraft, "create").mockResolvedValue({});
  vi.spyOn(CanvasDraft, "destroy").mockResolvedValue(0);
  // Read back AFTER the growth: five Cards.
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue(
    [0, 1, 2, 3, 4].map(cardRow),
  );
});

describe("PUT /:canvasId/group/:groupId series length response", () => {
  it("returns the group's CanvasDrafts when a manual series' length changes", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ metadata: { length: 5, seriesType: "standard" } });

    expect(res.status).toBe(200);
    expect(res.body.group.CanvasDrafts).toHaveLength(5);
    expect(res.body.group.CanvasDrafts[0]).toHaveProperty("Draft");
  });

  // The reflow runs off this payload, so a request that did NOT change the
  // length must not carry one — an absent key is how the client tells "no
  // growth happened" from "grew to the same size".
  it("omits CanvasDrafts when the length did not change", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.group.CanvasDrafts).toBeUndefined();
  });

  it("omits CanvasDrafts when the length is resent unchanged", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ metadata: { length: 3, seriesType: "standard" } });

    expect(res.status).toBe(200);
    expect(res.body.group.CanvasDrafts).toBeUndefined();
  });
});
