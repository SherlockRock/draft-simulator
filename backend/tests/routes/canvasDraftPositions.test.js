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
  CanvasGroup,
  CanvasConnection,
} = require("../../models/Canvas");
const Draft = require("../../models/Draft.js");

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
  const t = { commit: vi.fn(), rollback: vi.fn(), finished: false };
  t.commit.mockImplementation(async () => {
    t.finished = "commit";
  });
  t.rollback.mockImplementation(async () => {
    t.finished = "rollback";
  });
  vi.spyOn(Canvas.sequelize, "transaction").mockResolvedValue(t);
  return t;
}

const BODY = {
  positions: [
    { draft_id: "d1", positionX: 16, positionY: 64 },
    { draft_id: "d2", positionX: 740, positionY: 64 },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  });
});

describe("PUT /:canvasId/draft-positions", () => {
  it("returns 403 for view-only permission and opens no transaction", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "view" });
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(BODY);

    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects malformed positions with 400", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({ positions: [{ draft_id: "d1", positionX: "nope" }] });

    expect(res.status).toBe(400);
  });

  it("updates every draft in one transaction and emits draftPositionsUpdated", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    const t = mockTransaction();
    const update = vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(BODY);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith(
      { positionX: 16, positionY: 64 },
      expect.objectContaining({
        where: { canvas_id: "c1", draft_id: "d1" },
        transaction: t,
      })
    );
    expect(t.commit).toHaveBeenCalled();
    expect(socketService.emitToRoom).toHaveBeenCalledWith(
      "c1",
      "draftPositionsUpdated",
      expect.objectContaining({ positions: BODY.positions, group: null })
    );
  });

  it("includes group_id in the draft update when provided", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    mockTransaction();
    const update = vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);

    await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        positions: [
          { draft_id: "d1", positionX: 16, positionY: 64, group_id: "g1" },
        ],
      });

    expect(update).toHaveBeenCalledWith(
      { positionX: 16, positionY: 64, group_id: "g1" },
      expect.objectContaining({ where: { canvas_id: "c1", draft_id: "d1" } })
    );
  });

  it("rolls back and 404s when a draft is not on the canvas", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    const t = mockTransaction();
    vi.spyOn(CanvasDraft, "update").mockResolvedValue([0]);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send(BODY);

    expect(res.status).toBe(404);
    expect(t.rollback).toHaveBeenCalled();
    expect(socketService.emitToRoom).not.toHaveBeenCalled();
  });

  it("merges group metadata and broadcasts the updated group", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    mockTransaction();
    vi.spyOn(CanvasDraft, "update").mockResolvedValue([1]);
    const groupRow = {
      id: "g1",
      metadata: { layout: "free", disabledChampions: ["Ahri"] },
      update: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({ id: "g1", metadata: { layout: "grid" } }),
    };
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(groupRow);

    const res = await request(buildApp())
      .put("/api/canvas/c1/draft-positions")
      .send({
        ...BODY,
        group: {
          id: "g1",
          width: 2200,
          height: 1800,
          metadata: { layout: "grid", gridCols: 3 },
        },
      });

    expect(res.status).toBe(200);
    expect(groupRow.update).toHaveBeenCalledWith(
      {
        width: 2200,
        height: 1800,
        metadata: {
          layout: "grid",
          gridCols: 3,
          disabledChampions: ["Ahri"],
        },
      },
      expect.anything()
    );
    expect(socketService.emitToRoom).toHaveBeenCalledWith(
      "c1",
      "draftPositionsUpdated",
      expect.objectContaining({ group: { id: "g1", metadata: { layout: "grid" } } })
    );
  });
});

describe("POST /:canvasId/draft/:draftId/copy grid placement", () => {
  // The source row as the DB actually returns it: group_id is a real column, so
  // an ungrouped draft carries null, never a missing key. Getting that wrong is
  // what let the group-inheritance branch look tested when it was not.
  const mockCopyDeps = (original) => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue({
      group_id: null,
      Draft: { name: "Orig", picks: Array(20).fill("") },
      ...original,
    });
    vi.spyOn(Draft, "create").mockResolvedValue({
      id: "new-draft",
      toJSON: () => ({ id: "new-draft" }),
    });
    // Broadcast fetches — return empty sets.
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    // touchCanvasTimestamp + broadcast both call Canvas.findByPk.
    vi.spyOn(Canvas, "findByPk").mockResolvedValue({
      changed: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
      toJSON: () => ({}),
    });
    return vi.spyOn(CanvasDraft, "create").mockResolvedValue({ toJSON: () => ({}) });
  };

  it("copy honors explicit position and group_id", async () => {
    const createCanvasDraft = mockCopyDeps({ positionX: 100, positionY: 100 });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({ positionX: 16, positionY: 64, group_id: "g1" });

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        positionX: 16,
        positionY: 64,
        group_id: "g1",
      })
    );
  });

  it("copy without a body falls back to offset placement", async () => {
    const createCanvasDraft = mockCopyDeps({ positionX: 100, positionY: 200 });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({});

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        positionX: 150,
        positionY: 250,
        group_id: null,
      })
    );
  });

  // d67ab28: a copy stays in its source's group. Copying a card out of a group
  // and having it land loose was the bug that commit fixed.
  it("copy without a body inherits the original's group", async () => {
    const createCanvasDraft = mockCopyDeps({
      positionX: 100,
      positionY: 200,
      group_id: "g9",
    });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({});

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: "g9" })
    );
  });

  // The escape hatch from that inheritance: an explicit null means "loose",
  // and must not be read as "no opinion".
  it("an explicit null group_id copies a grouped draft out of its group", async () => {
    const createCanvasDraft = mockCopyDeps({
      positionX: 100,
      positionY: 200,
      group_id: "g9",
    });

    const res = await request(buildApp())
      .post("/api/canvas/c1/draft/d1/copy")
      .send({ group_id: null });

    expect(res.status).toBe(201);
    expect(createCanvasDraft).toHaveBeenCalledWith(
      expect.objectContaining({ group_id: null })
    );
  });
});
