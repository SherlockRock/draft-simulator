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
} = require("../../models/Canvas");

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  // canvas.js mounts the annotation router with a static `require("./canvasAnnotations")`
  // at its own top level. Deleting only canvas.js's cache entry re-executes canvas.js
  // (so its own `const { protect } = require(...)` picks up this test's spy), but
  // node still serves the cached canvasAnnotations.js module — whose `protect` was
  // captured once, on the first buildApp() call, and never updates. Every test after
  // the first would run the REAL auth middleware and 401 instead of hitting the mock.
  const annotationsRoutePath =
    require.resolve("../../routes/canvasAnnotations");
  delete require.cache[routePath];
  delete require.cache[annotationsRoutePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

function expectCanvasUpdateBroadcast() {
  expect(socketService.emitToRoom).toHaveBeenCalledWith(
    "c1",
    "canvasUpdate",
    expect.objectContaining({ annotations: [] }),
  );
}

const annotationRow = (overrides = {}) => ({
  id: "a1",
  canvas_id: "c1",
  group_id: null,
  positionX: 10,
  positionY: 20,
  width: 380,
  height: 120,
  // Null by default: no hand-set floor. The copy route must carry whatever
  // value is here through unchanged — see the manualWidth/manualHeight tests
  // in the copy describe block below.
  manualWidth: null,
  manualHeight: null,
  text: "why we lost this one",
  color: "slate",
  fontSize: "md",
  update: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  toJSON() {
    const { update, destroy, toJSON, ...rest } = this;
    return rest;
  },
  ...overrides,
});

const connectionRow = (overrides = {}) => ({
  source_draft_ids: [{ type: "draft", draft_id: "d1", anchor_type: "bottom" }],
  target_draft_ids: [
    { type: "annotation", annotation_id: "a1", anchor_type: "top" },
  ],
  changed: vi.fn(),
  save: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

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
    toJSON: () => ({ id: "c1" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
});

describe("annotation routes — the Canvas Mutation Gate", () => {
  for (const [name, send] of [
    [
      "create",
      (app) => request(app).post("/api/canvas/c1/annotations").send({}),
    ],
    [
      "update",
      (app) =>
        request(app).patch("/api/canvas/c1/annotations/a1").send({ text: "x" }),
    ],
    ["delete", (app) => request(app).delete("/api/canvas/c1/annotations/a1")],
    [
      "duplicate",
      (app) => request(app).post("/api/canvas/c1/annotations/a1/copy").send({}),
    ],
  ]) {
    it(`403s ${name} for a view-only user and writes nothing`, async () => {
      vi.spyOn(UserCanvas, "findOne").mockResolvedValue({
        permissions: "view",
      });
      const create = vi.spyOn(CanvasAnnotation, "create");
      const res = await send(buildApp());
      expect(res.status).toBe(403);
      expect(create).not.toHaveBeenCalled();
    });
  }
});

describe("POST /:canvasId/annotations", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  it("creates a loose annotation and broadcasts the snapshot", async () => {
    vi.spyOn(CanvasAnnotation, "create").mockResolvedValue(annotationRow());
    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations")
      .send({ positionX: 10, positionY: 20 });

    expect(res.status).toBe(201);
    expect(res.body.annotation.id).toBe("a1");
    const broadcast = socketService.emitToRoom.mock.calls.find(
      ([, event]) => event === "canvasUpdate",
    );
    expect(broadcast?.[2]).toHaveProperty("annotations");
  });

  it("persists the hand-set size floor on create", async () => {
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockResolvedValue(
        annotationRow({ manualWidth: 440, manualHeight: 260 }),
      );

    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations")
      .send({ manualWidth: 440, manualHeight: 260 });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ manualWidth: 440, manualHeight: 260 }),
    );
  });

  it("defaults an omitted hand-set size floor to null, not zero", async () => {
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockResolvedValue(annotationRow());

    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations")
      .send({});

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ manualWidth: null, manualHeight: null }),
    );
  });

  // Containment, not authorization (design §3): the Gate said yes, and the
  // group_id still belongs to somebody else's canvas.
  it("404s a group_id that is not on this canvas", async () => {
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const create = vi.spyOn(CanvasAnnotation, "create");
    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations")
      .send({ positionX: 0, positionY: 0, group_id: "gForeign" });

    expect(res.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unknown colour with 400", async () => {
    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations")
      .send({ positionX: 0, positionY: 0, color: "chartreuse" });
    expect(res.status).toBe(400);
  });

  // `none` is a palette entry (D6), not a missing value.
  it("accepts colour `none`", async () => {
    vi.spyOn(CanvasAnnotation, "create").mockResolvedValue(
      annotationRow({ color: "none" }),
    );
    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations")
      .send({ positionX: 0, positionY: 0, color: "none" });
    expect(res.status).toBe(201);
  });
});

describe("PATCH /:canvasId/annotations/:annotationId", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  it("404s an annotation on another canvas", async () => {
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(null);
    const res = await request(buildApp())
      .patch("/api/canvas/c1/annotations/aX")
      .send({ text: "hello" });
    expect(res.status).toBe(404);
  });

  // Containment, not authorization (design §3): the Gate said yes, and the
  // group_id still belongs to somebody else's canvas. findGroupNotOnCanvas
  // runs before the row lookup, so a foreign group_id must stop the request
  // before CanvasAnnotation.findOne is ever called.
  it("404s a group_id that is not on this canvas", async () => {
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const findOne = vi.spyOn(CanvasAnnotation, "findOne");
    const res = await request(buildApp())
      .patch("/api/canvas/c1/annotations/a1")
      .send({ text: "x", group_id: "gForeign" });
    expect(res.status).toBe(404);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("writes only the fields the request carries", async () => {
    const row = annotationRow();
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(row);
    await request(buildApp())
      .patch("/api/canvas/c1/annotations/a1")
      .send({ text: "their jungler always flexes here" });

    expect(row.update).toHaveBeenCalledWith({
      text: "their jungler always flexes here",
    });
    expectCanvasUpdateBroadcast();
  });

  // An empty text is a legal state (D3) — a bare champion strip. A truthiness
  // guard here would make clearing a note impossible.
  it("accepts an empty text", async () => {
    const row = annotationRow();
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(row);
    const res = await request(buildApp())
      .patch("/api/canvas/c1/annotations/a1")
      .send({ text: "" });
    expect(res.status).toBe(200);
    expect(row.update).toHaveBeenCalledWith({ text: "" });
  });

  it("400s when the body carries no writable field", async () => {
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(annotationRow());
    const res = await request(buildApp())
      .patch("/api/canvas/c1/annotations/a1")
      .send({ nonsense: 1 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /:canvasId/annotations/:annotationId", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  // Immediate and unconfirmed, matching Card delete (D11).
  it("destroys the row and broadcasts", async () => {
    const row = annotationRow();
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(row);
    const res = await request(buildApp()).delete(
      "/api/canvas/c1/annotations/a1",
    );
    expect(res.status).toBe(200);
    expect(row.destroy).toHaveBeenCalled();
    expectCanvasUpdateBroadcast();
  });

  it("trims an annotation endpoint while preserving a non-empty side", async () => {
    const row = annotationRow();
    const connection = connectionRow({
      target_draft_ids: [
        { type: "annotation", annotation_id: "a1", anchor_type: "top" },
        { type: "annotation", annotation_id: "a2", anchor_type: "top" },
      ],
    });
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(row);
    CanvasConnection.findAll.mockResolvedValue([connection]);

    const res = await request(buildApp()).delete(
      "/api/canvas/c1/annotations/a1",
    );

    expect(res.status).toBe(200);
    expect(connection.destroy).not.toHaveBeenCalled();
    expect(connection.target_draft_ids).toEqual([
      { type: "annotation", annotation_id: "a2", anchor_type: "top" },
    ]);
    expect(connection.changed).toHaveBeenCalledWith("target_draft_ids", true);
    expect(connection.save).toHaveBeenCalled();
  });

  it("destroys a connection when annotation deletion empties either side", async () => {
    const row = annotationRow();
    const connection = connectionRow();
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(row);
    CanvasConnection.findAll.mockResolvedValue([connection]);

    const res = await request(buildApp()).delete(
      "/api/canvas/c1/annotations/a1",
    );

    expect(res.status).toBe(200);
    expect(connection.destroy).toHaveBeenCalled();
    expect(connection.save).not.toHaveBeenCalled();
  });
});

describe("POST /:canvasId/annotations/:annotationId/copy", () => {
  beforeEach(() => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "edit" });
  });

  it("copies every content field and takes the caller's placement", async () => {
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(
      annotationRow({
        color: "purple",
        manualWidth: 320,
        manualHeight: 96,
      }),
    );
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockResolvedValue(annotationRow({ id: "a2" }));

    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations/a1/copy")
      .send({ positionX: 500, positionY: 300, group_id: null });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas_id: "c1",
        positionX: 500,
        positionY: 300,
        group_id: null,
        color: "purple",
        text: "why we lost this one",
        // The hand-set floor is part of the note's identity (router comment):
        // a duplicate that dropped it would silently start auto-shrinking
        // where the original never did.
        manualWidth: 320,
        manualHeight: 96,
      }),
    );
    expectCanvasUpdateBroadcast();
  });

  // Negative case for the same guarantee: a source that never had a hand-set
  // floor must produce a copy that also has none — not coerced to 0 or left
  // undefined, which would silently turn "no floor" into "a floor of zero".
  it("keeps manualWidth/manualHeight null when the source never set a floor", async () => {
    vi.spyOn(CanvasAnnotation, "findOne").mockResolvedValue(annotationRow());
    const create = vi
      .spyOn(CanvasAnnotation, "create")
      .mockResolvedValue(annotationRow({ id: "a2" }));

    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations/a1/copy")
      .send({ positionX: 0, positionY: 0 });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ manualWidth: null, manualHeight: null }),
    );
  });

  // Containment, not authorization (design §3): the Gate said yes, and the
  // group_id still belongs to somebody else's canvas. findGroupNotOnCanvas
  // runs before the source lookup, so a foreign group_id must stop the
  // request before CanvasAnnotation.findOne/create are ever called.
  it("404s a group_id that is not on this canvas", async () => {
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    const findOne = vi.spyOn(CanvasAnnotation, "findOne");
    const create = vi.spyOn(CanvasAnnotation, "create");
    const res = await request(buildApp())
      .post("/api/canvas/c1/annotations/a1/copy")
      .send({ positionX: 0, positionY: 0, group_id: "gForeign" });
    expect(res.status).toBe(404);
    expect(findOne).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
