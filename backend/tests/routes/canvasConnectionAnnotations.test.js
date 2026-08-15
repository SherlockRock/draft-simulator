import { beforeEach, describe, expect, it, vi } from "vitest";
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
} = require("../../models/Canvas.js");

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

function connectionRow(overrides = {}) {
  const row = {
    id: "connection-1",
    canvas_id: "c1",
    source_draft_ids: [],
    target_draft_ids: [],
    vertices: [],
    style: "solid",
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
    toJSON: () => ({
      id: row.id,
      canvas_id: row.canvas_id,
      source_draft_ids: row.source_draft_ids,
      target_draft_ids: row.target_draft_ids,
      vertices: row.vertices,
      style: row.style,
    }),
    ...overrides,
  };
  return row;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([{ draft_id: "d1" }]);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([{ id: "g1" }]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([{ id: "a1" }]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
});

describe("annotation connection endpoints", () => {
  it("validates and formats annotation endpoints on create", async () => {
    const created = connectionRow();
    vi.spyOn(CanvasConnection, "create").mockImplementation(async (fields) => {
      Object.assign(created, fields);
      return created;
    });

    const res = await request(buildApp())
      .post("/api/canvas/c1/connections")
      .send({
        sourceDraftIds: [{ annotationId: "a1", anchorType: "right" }],
        targetDraftIds: [{ draftId: "d1", anchorType: "left" }],
      });

    expect(res.status).toBe(201);
    expect(created.source_draft_ids).toEqual([
      {
        type: "annotation",
        annotation_id: "a1",
        anchor_type: "right",
      },
    ]);
  });

  it("rejects an annotation source that is not on the canvas", async () => {
    CanvasAnnotation.findAll.mockResolvedValue([]);
    const create = vi.spyOn(CanvasConnection, "create");

    const res = await request(buildApp())
      .post("/api/canvas/c1/connections")
      .send({
        sourceDraftIds: [{ annotationId: "foreign" }],
        targetDraftIds: [{ draftId: "d1" }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "Source annotation foreign not found on canvas",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("adds an annotation target and does not duplicate it", async () => {
    const connection = connectionRow({
      source_draft_ids: [
        { type: "draft", draft_id: "d1", anchor_type: "bottom" },
      ],
      target_draft_ids: [
        { type: "annotation", annotation_id: "a1", anchor_type: "top" },
      ],
    });
    vi.spyOn(CanvasConnection, "findOne").mockResolvedValue(connection);

    const res = await request(buildApp())
      .patch("/api/canvas/c1/connections/connection-1")
      .send({ addTarget: { annotationId: "a1", anchorType: "left" } });

    expect(res.status).toBe(200);
    expect(connection.target_draft_ids).toHaveLength(1);
    expect(connection.changed).not.toHaveBeenCalledWith(
      "target_draft_ids",
      true,
    );
  });

  it("rejects an annotation target addition that is not on the canvas", async () => {
    const connection = connectionRow();
    vi.spyOn(CanvasConnection, "findOne").mockResolvedValue(connection);
    CanvasAnnotation.findAll.mockResolvedValue([]);

    const res = await request(buildApp())
      .patch("/api/canvas/c1/connections/connection-1")
      .send({ addTarget: { annotationId: "foreign" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Annotation foreign not found on canvas");
    expect(connection.save).not.toHaveBeenCalled();
  });
});
