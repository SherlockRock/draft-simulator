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
const Team = require("../../models/Team");
const canvasMutations = require("../../services/canvasMutations");

/**
 * Which socket event `PUT /:canvasId/group/:groupId` broadcasts.
 *
 * `groupMoved` carries a position and nothing else — its Zod schema strips the
 * rest — so any request that also changes metadata has to take the full
 * `canvasUpdate` branch instead. The caller that sends both is a left-edge
 * resize, which since 5a-0 persists the manual size floor
 * (`metadata.manualWidth`/`manualHeight`); a client left on a stale floor would
 * resolve the container to the wrong size on its next drop.
 */

function buildCanvasApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

let group;

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
    name: "Container",
    type: "custom",
    positionX: 100,
    positionY: 100,
    width: 600,
    height: 400,
    versus_draft_id: null,
    metadata: { layout: "grid", gridCols: 3 },
    // Sequelize's `update` mutates the instance, and the route reads
    // `group.width` / `group.positionX` back out for the broadcast.
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
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(Team, "findAll").mockResolvedValue([]);
});

const emittedEvents = () =>
  socketService.emitToRoom.mock.calls.map((call) => call[1]);

describe("PUT /:canvasId/group/:groupId broadcast selection", () => {
  // This is the RESIZE route. The container drag — the only caller that ever
  // sent a bare position — commits through `PUT /draft-positions` since 5a-2,
  // where the server fans the delta out over the subtree. A `groupMoved` from
  // here would tell receivers to move child Groups by a left-edge delta that
  // moved the frame's edge, not world space.
  it("never emits groupMoved, even for a bare move", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ positionX: 250, positionY: 300 });

    expect(res.status).toBe(200);
    expect(emittedEvents()).not.toContain("groupMoved");
  });

  it("emits groupResized with the new left edge for a left-edge resize", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ positionX: 60, width: 640, height: 400 });

    expect(res.status).toBe(200);
    expect(emittedEvents()).toEqual(["groupResized"]);
    expect(socketService.emitToRoom).toHaveBeenCalledWith(
      "c-1",
      "groupResized",
      expect.objectContaining({ groupId: "g-1", positionX: 60 }),
    );
  });

  // GroupResizedSchema requires BOTH dimensions numeric, and the route accepts
  // one or an explicit null — so this would emit an event every client drops.
  it("falls back to canvasUpdate when only one dimension is a number", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ positionX: 60, width: 640, height: null });

    expect(res.status).toBe(200);
    expect(emittedEvents()).toEqual(["canvasUpdate"]);
  });

  it("emits canvasUpdate when a left-edge resize also stores the manual floor", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({
        positionX: 60,
        width: 640,
        height: 400,
        metadata: { manualWidth: 640, manualHeight: 400 },
      });

    expect(res.status).toBe(200);
    expect(emittedEvents()).toEqual(["canvasUpdate"]);
    expect(group.update.mock.calls.at(-1)[0].metadata).toMatchObject({
      layout: "grid",
      gridCols: 3,
      manualWidth: 640,
      manualHeight: 400,
    });
  });

  it("emits groupResized for a size-only change", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ width: 640, height: 400 });

    expect(res.status).toBe(200);
    expect(emittedEvents()).toEqual(["groupResized"]);
    expect(socketService.emitToRoom).toHaveBeenCalledWith("c-1", "groupResized", {
      groupId: "g-1",
      width: 640,
      height: 400,
    });
  });

  it("emits canvasUpdate for a rename", async () => {
    const res = await request(buildCanvasApp())
      .put("/api/canvas/c-1/group/g-1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(emittedEvents()).toEqual(["canvasUpdate"]);
  });
});
