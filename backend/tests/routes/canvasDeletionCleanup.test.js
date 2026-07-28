// Canvas deletion paths used to leak rows: the group -> series FK is SET NULL
// and CanvasDrafts -> Drafts is CASCADE the wrong way round, so nothing in the
// database ever removed a manual series or a draft whose last card was deleted.
// These tests pin the app-level cleanup that closes those leaks.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const presenceEjection = require("../../services/presenceEjection");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
} = require("../../models/Canvas.js");
const Draft = require("../../models/Draft.js");
const VersusDraft = require("../../models/VersusDraft.js");

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

function mockTransaction() {
  const t = { finished: false };
  t.commit = vi.fn().mockImplementation(() => {
    t.finished = "commit";
  });
  t.rollback = vi.fn().mockImplementation(() => {
    t.finished = "rollback";
  });
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(t);
  return t;
}

function mockCanvasRow(id = "c-1") {
  return {
    id,
    toJSON: () => ({ id }),
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
  };
}

// A CanvasGroup instance as the route sees it, with the fields it reads.
function mockGroup({ id = "g-1", seriesId = null } = {}) {
  return {
    id,
    canvas_id: "c-1",
    positionX: 100,
    positionY: 200,
    versus_draft_id: seriesId,
    destroy: vi.fn().mockResolvedValue(),
    toJSON: () => ({ id }),
  };
}

function mockCanvasDraft(draftId, groupId = "g-1") {
  return {
    draft_id: draftId,
    group_id: groupId,
    positionX: 10,
    positionY: 20,
    update: vi.fn().mockResolvedValue(),
    destroy: vi.fn().mockResolvedValue(),
  };
}

function mockSeries(id = "vd-1") {
  return { id, origin: "manual", destroy: vi.fn().mockResolvedValue() };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(presenceEjection, "ejectUserFromCanvas").mockImplementation(
    () => {},
  );
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "admin" });
  vi.spyOn(UserCanvas, "destroy").mockResolvedValue(0);
  vi.spyOn(Canvas, "findByPk").mockResolvedValue(mockCanvasRow());
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "destroy").mockResolvedValue(0);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasDraft, "destroy").mockResolvedValue(0);
  vi.spyOn(CanvasDraft, "update").mockResolvedValue([0]);
  vi.spyOn(Draft, "findAll").mockResolvedValue([]);
  vi.spyOn(Draft, "update").mockResolvedValue([0]);
  vi.spyOn(Draft, "destroy").mockResolvedValue(0);
  vi.spyOn(VersusDraft, "findOne").mockResolvedValue(null);
  vi.spyOn(VersusDraft, "destroy").mockResolvedValue(0);
});

describe("DELETE /:canvasId/group/:groupId series cleanup", () => {
  it("destroys the manual series backing the group", async () => {
    mockTransaction();
    const group = mockGroup({ seriesId: "vd-1" });
    const series = mockSeries();
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
    VersusDraft.findOne.mockResolvedValue(series);
    CanvasDraft.findAll.mockResolvedValueOnce([mockCanvasDraft("d-1")]);

    const res = await request(buildApp()).delete("/api/canvas/c-1/group/g-1");

    expect(res.status).toBe(200);
    expect(series.destroy).toHaveBeenCalled();
  });

  it("never destroys a live series", async () => {
    mockTransaction();
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(
      mockGroup({ seriesId: "vd-live" }),
    );
    // origin: "manual" is part of the lookup, so a live series never matches.
    VersusDraft.findOne.mockResolvedValue(null);
    CanvasDraft.findAll.mockResolvedValueOnce([mockCanvasDraft("d-1")]);

    const res = await request(buildApp()).delete("/api/canvas/c-1/group/g-1");

    expect(res.status).toBe(200);
    expect(VersusDraft.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "vd-live", origin: "manual" },
      }),
    );
    expect(VersusDraft.destroy).not.toHaveBeenCalled();
  });

  it("detaches the games before destroying the series when keepDrafts=true", async () => {
    mockTransaction();
    const group = mockGroup({ seriesId: "vd-1" });
    const series = mockSeries();
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(group);
    VersusDraft.findOne.mockResolvedValue(series);
    CanvasDraft.findAll.mockResolvedValueOnce([mockCanvasDraft("d-1")]);
    Draft.findAll.mockResolvedValueOnce([{ id: "d-1" }, { id: "d-2" }]);

    const res = await request(buildApp()).delete(
      "/api/canvas/c-1/group/g-1?keepDrafts=true",
    );

    expect(res.status).toBe(200);
    // Without this the versus_draft_id cascade would delete the kept drafts.
    expect(Draft.update).toHaveBeenCalledWith(
      { versus_draft_id: null, seriesIndex: null },
      expect.objectContaining({ where: { id: ["d-1", "d-2"] } }),
    );
    expect(CanvasDraft.update).toHaveBeenCalledWith(
      { source_type: "canvas" },
      expect.objectContaining({ where: { draft_id: ["d-1", "d-2"] } }),
    );
    expect(series.destroy).toHaveBeenCalled();
    // The cards themselves survive as loose drafts.
    expect(CanvasDraft.destroy).not.toHaveBeenCalled();
  });

  it("destroys drafts the group leaves unreferenced when keepDrafts is absent", async () => {
    mockTransaction();
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(mockGroup());
    CanvasDraft.findAll
      .mockResolvedValueOnce([mockCanvasDraft("d-1"), mockCanvasDraft("d-2")])
      // No cards remain pointing at either draft.
      .mockResolvedValueOnce([]);

    const res = await request(buildApp()).delete("/api/canvas/c-1/group/g-1");

    expect(res.status).toBe(200);
    expect(Draft.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ["d-1", "d-2"], versus_draft_id: null },
      }),
    );
  });
});

describe("DELETE /:canvasId series cleanup", () => {
  it("destroys manual series before the canvas cascade hides the groups", async () => {
    mockTransaction();
    vi.spyOn(Canvas, "destroy").mockResolvedValue(1);
    CanvasGroup.findAll.mockResolvedValue([
      { versus_draft_id: "vd-1" },
      { versus_draft_id: null },
      { versus_draft_id: "vd-2" },
    ]);

    const res = await request(buildApp()).delete("/api/canvas/c-1");

    expect(res.status).toBe(200);
    expect(VersusDraft.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ["vd-1", "vd-2"], origin: "manual" },
      }),
    );
    // Reading the groups has to happen while the canvas still exists.
    expect(VersusDraft.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      Canvas.destroy.mock.invocationCallOrder[0],
    );
  });

  it("skips the series delete when the canvas has no groups", async () => {
    mockTransaction();
    vi.spyOn(Canvas, "destroy").mockResolvedValue(1);
    CanvasGroup.findAll.mockResolvedValue([]);

    const res = await request(buildApp()).delete("/api/canvas/c-1");

    expect(res.status).toBe(200);
    expect(VersusDraft.destroy).not.toHaveBeenCalled();
  });
});

describe("DELETE /:canvasId/draft/:draftId draft cleanup", () => {
  function arrangeDraftDelete({ remainingCards = [] } = {}) {
    mockTransaction();
    const canvasDraft = mockCanvasDraft("d-1", null);
    CanvasDraft.findAll
      // Cards matching this canvas + draft.
      .mockResolvedValueOnce([canvasDraft])
      // The unreferenced-draft check.
      .mockResolvedValueOnce(remainingCards)
      // The canvas refresh payload.
      .mockResolvedValue([]);
    return canvasDraft;
  }

  it("destroys the underlying draft once no card references it", async () => {
    const canvasDraft = arrangeDraftDelete();

    const res = await request(buildApp()).delete(
      "/api/canvas/c-1/draft/d-1",
    );

    expect(res.status).toBe(200);
    expect(canvasDraft.destroy).toHaveBeenCalled();
    expect(Draft.destroy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ["d-1"], versus_draft_id: null },
      }),
    );
  });

  it("keeps the draft when another canvas still shows it", async () => {
    arrangeDraftDelete({ remainingCards: [{ draft_id: "d-1" }] });

    const res = await request(buildApp()).delete(
      "/api/canvas/c-1/draft/d-1",
    );

    expect(res.status).toBe(200);
    expect(Draft.destroy).not.toHaveBeenCalled();
  });
});
