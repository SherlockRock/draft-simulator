import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const { Canvas, CanvasDraft, CanvasGroup, CanvasConnection, CanvasAnnotation, CanvasPoolPlacement } =
  require("../../models/Canvas");
const Draft = require("../../models/Draft.js");
// The route destructures assertCanvasAccess at module load, so the spy must be
// installed BEFORE buildApp() re-requires the router — which is why buildApp
// deletes the route from the require cache on every call.
const canvasMutations = require("../../services/canvasMutations");

const CANVAS_ID = "canvas-1";
const DRAFT_ID = "draft-1";

function buildApp() {
  // Re-require the router each time so route-level module state is fresh.
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

// The row the route mutates; assertions read its .update calls.
let canvasDraftRow;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "user-1" };
    next();
  });
  canvasDraftRow = { update: vi.fn().mockResolvedValue(undefined) };
  vi.spyOn(CanvasDraft, "findOne").mockResolvedValue(canvasDraftRow);
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  // A group carrying a linked Team proves TEAM_INCLUDE survived the broadcast.
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([
    {
      toJSON: () => ({ id: "g1", Team1: { id: "t1", name: "T1" } }),
      id: "g1",
      Team1: { id: "t1", name: "T1" },
    },
  ]);
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    toJSON: () => ({ id: CANVAS_ID }),
  });
  vi.spyOn(canvasMutations, "assertCanvasAccess").mockResolvedValue(undefined);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(Draft, "update").mockResolvedValue([1]);
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
});

describe("PUT /canvas/:canvasId/draft/:draftId team names", () => {
  it("persists both names onto the CanvasDraft row", async () => {
    await request(buildApp())
      .put(`/api/canvas/${CANVAS_ID}/draft/${DRAFT_ID}`)
      .send({ team1Name: "T1", team2Name: "Gen.G" })
      .expect(200);

    expect(canvasDraftRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ team1Name: "T1", team2Name: "Gen.G" }),
    );
  });

  it("stores a blank name as null so it inherits again", async () => {
    await request(buildApp())
      .put(`/api/canvas/${CANVAS_ID}/draft/${DRAFT_ID}`)
      .send({ team1Name: "   " })
      .expect(200);

    expect(canvasDraftRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ team1Name: null }),
    );
  });

  it("rejects a user without edit access", async () => {
    canvasMutations.assertCanvasAccess.mockRejectedValueOnce(
      new canvasMutations.NotAuthorizedError(),
    );
    await request(buildApp())
      .put(`/api/canvas/${CANVAS_ID}/draft/${DRAFT_ID}`)
      .send({ team1Name: "T1" })
      .expect(403);
    expect(canvasDraftRow.update).not.toHaveBeenCalled();
  });

  it("broadcasts a canvasUpdate whose groups still carry Team1/Team2", async () => {
    const emitted = [];
    socketService.emitToRoom.mockImplementation((room, event, payload) => {
      emitted.push({ room, event, payload });
    });

    await request(buildApp())
      .put(`/api/canvas/${CANVAS_ID}/draft/${DRAFT_ID}`)
      .send({ team1Name: "T1" })
      .expect(200);

    const update = emitted.find((e) => e.event === "canvasUpdate");
    expect(update).toBeDefined();
    expect(update.payload.groups[0].Team1).toBeDefined();

    // The mock's toJSON always carries Team1, so the assertion above cannot by
    // itself detect the regression this test exists for. What actually matters
    // is that the group query asked for the team association at all — the old
    // hand-built payload fetched groups with no include and silently stripped
    // Team1/Team2 from every client's store.
    const groupQuery = CanvasGroup.findAll.mock.calls.at(-1)[0];
    expect(groupQuery.include).toBeDefined();
  });
});
