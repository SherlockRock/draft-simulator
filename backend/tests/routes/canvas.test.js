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
require("../../models/Draft.js");

const EDIT_FORBIDDEN =
  "Forbidden: You don't have permission to edit this canvas";
const ADMIN_REMOVE_FORBIDDEN =
  "Forbidden: You must be an admin to remove users";
const ADMIN_DELETE_FORBIDDEN =
  "Forbidden: You must be an admin to delete this canvas";

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

function mockCanvasAccess(permissions) {
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue(
    permissions ? { permissions } : null,
  );
}

function mockCanvasJson(id = "c-1") {
  return {
    id,
    name: "Canvas",
    description: "",
    cardLayout: "wide",
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        description: this.description,
        cardLayout: this.cardLayout,
      };
    },
    changed: vi.fn(),
    save: vi.fn().mockResolvedValue(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(CanvasDraft, "findOne").mockResolvedValue(null);
  vi.spyOn(UserCanvas, "destroy").mockResolvedValue(0);
  vi.spyOn(presenceEjection, "ejectUserFromCanvas").mockImplementation(
    () => {},
  );
});

describe("canvas route mutation access", () => {
  it("PUT /:canvasId/draft/:draftId returns original 403 text when access row is missing", async () => {
    mockCanvasAccess(null);

    const res = await request(buildApp())
      .put("/api/canvas/c-1/draft/d-1")
      .send({ positionX: 10 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: EDIT_FORBIDDEN });
    expect(CanvasDraft.findOne).not.toHaveBeenCalled();
  });

  it("PUT /:canvasId/draft/:draftId returns original 403 text for view permission", async () => {
    mockCanvasAccess("view");

    const res = await request(buildApp())
      .put("/api/canvas/c-1/draft/d-1")
      .send({ positionX: 10 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: EDIT_FORBIDDEN });
    expect(CanvasDraft.findOne).not.toHaveBeenCalled();
  });

  it("PUT /:canvasId/draft/:draftId proceeds with edit permission", async () => {
    mockCanvasAccess("edit");
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue({
      update: vi.fn().mockResolvedValue(),
    });
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);
    vi.spyOn(Canvas, "findByPk").mockResolvedValue(mockCanvasJson());

    const res = await request(buildApp())
      .put("/api/canvas/c-1/draft/d-1")
      .send({ positionX: 10 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: "Draft updated" });
  });

  it("DELETE /:canvasId/users/:userId returns original admin 403 text for edit permission", async () => {
    mockCanvasAccess("edit");

    const res = await request(buildApp()).delete("/api/canvas/c-1/users/u2");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: ADMIN_REMOVE_FORBIDDEN });
    expect(UserCanvas.destroy).not.toHaveBeenCalled();
  });

  it("DELETE /:canvasId/users/:userId succeeds for admin permission and ejects the user's sockets", async () => {
    mockCanvasAccess("admin");
    vi.spyOn(UserCanvas, "destroy").mockResolvedValue(1);

    const res = await request(buildApp()).delete("/api/canvas/c-1/users/u2");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "User removed from canvas",
    });
    expect(presenceEjection.ejectUserFromCanvas).toHaveBeenCalledWith(
      "c-1",
      "u2",
    );
  });

  it("DELETE /:canvasId/users/:userId does not eject when no access row was removed", async () => {
    mockCanvasAccess("admin");

    const res = await request(buildApp()).delete("/api/canvas/c-1/users/u2");

    expect(res.status).toBe(404);
    expect(presenceEjection.ejectUserFromCanvas).not.toHaveBeenCalled();
  });

  it("PUT /:canvasId/users/:userId updates permissions for admin without ejecting", async () => {
    mockCanvasAccess("admin");
    vi.spyOn(UserCanvas, "update").mockResolvedValue([1]);

    const res = await request(buildApp())
      .put("/api/canvas/c-1/users/u2")
      .send({ permissions: "view" });

    expect(res.status).toBe(200);
    expect(UserCanvas.update).toHaveBeenCalledWith(
      { permissions: "view" },
      { where: { canvas_id: "c-1", user_id: "u2" } },
    );
    expect(presenceEjection.ejectUserFromCanvas).not.toHaveBeenCalled();
  });

  it("PUT /:canvasId/users/:userId rejects a permissions value outside the enum", async () => {
    mockCanvasAccess("admin");
    vi.spyOn(UserCanvas, "update").mockResolvedValue([1]);

    const res = await request(buildApp())
      .put("/api/canvas/c-1/users/u2")
      .send({ permissions: "banana" });

    expect(res.status).toBe(400);
    expect(UserCanvas.update).not.toHaveBeenCalled();
  });

  it("DELETE /:canvasId returns original admin 403 text and does not create a transaction when access fails", async () => {
    mockCanvasAccess("edit");
    const transaction = vi.spyOn(Canvas.sequelize, "transaction");

    const res = await request(buildApp()).delete("/api/canvas/c-1");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: ADMIN_DELETE_FORBIDDEN });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("falls back to 500 when a non-gate error is thrown after access passes", async () => {
    mockCanvasAccess("edit");
    vi.spyOn(CanvasDraft, "findOne").mockRejectedValue(new Error("db down"));

    const res = await request(buildApp())
      .put("/api/canvas/c-1/draft/d-1")
      .send({ positionX: 10 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to update canvas draft" });
  });
});
