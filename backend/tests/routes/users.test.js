import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const sequelize = require("../../config/database");
const socketService = require("../../middleware/socketService");
const canvasProjections = require("../../routes/canvasProjections");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasGroup,
  CanvasConnection,
  CanvasAnnotation,
} = require("../../models/Canvas");
const Draft = require("../../models/Draft");
const VersusDraft = require("../../models/VersusDraft");
const UserToken = require("../../models/UserToken");

const IMPORT_FORBIDDEN =
  "Forbidden: You don't have permission to import into this canvas";

function loadRouter() {
  const routePath = require.resolve("../../routes/users");
  delete require.cache[routePath];
  return require("../../routes/users");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", loadRouter());
  return app;
}

function importBody() {
  return {
    data: {
      drafts: [{ name: "Imported Draft", picks: Array(20).fill("") }],
      versusSeries: [],
    },
    options: { dedupeStrategy: "skip" },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
  vi.spyOn(canvasProjections, "buildCanvasSnapshot").mockResolvedValue({
    canvas: { id: "c-1" },
    drafts: [],
    groups: [],
    connections: [],
    annotations: [],
  });
});

describe("user import route canvas access", () => {
  it("POST /me/import/canvas/:canvasId returns original 403 text and does not create a transaction for view permission", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "view" });
    const transaction = vi.spyOn(sequelize, "transaction");

    const res = await request(buildApp())
      .post("/api/users/me/import/canvas/c-1")
      .send(importBody());

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: IMPORT_FORBIDDEN });
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("annotation deletion cleanup", () => {
  it("new_canvases overwrite clears annotations from an existing same-name canvas", async () => {
    const transaction = {
      finished: false,
      commit: vi.fn().mockImplementation(async () => {
        transaction.finished = "commit";
      }),
      rollback: vi.fn().mockImplementation(async () => {
        transaction.finished = "rollback";
      }),
    };
    vi.spyOn(sequelize, "transaction").mockResolvedValue(transaction);
    const destinationCanvas = {
      id: "c-1",
      update: vi.fn().mockResolvedValue(),
      changed: vi.fn(),
      save: vi.fn().mockResolvedValue(),
    };
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({
      Canvas: destinationCanvas,
    });
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasDraft, "destroy").mockResolvedValue(0);
    vi.spyOn(CanvasConnection, "destroy").mockResolvedValue(0);
    vi.spyOn(CanvasGroup, "destroy").mockResolvedValue(1);
    const annotationDestroy = vi
      .spyOn(CanvasAnnotation, "destroy")
      .mockResolvedValue(3);

    const res = await request(buildApp())
      .post("/api/users/me/import")
      .send({
        exportData: {
          exportedAt: "2026-08-12T00:00:00.000Z",
          canvases: [
            {
              id: "source-canvas",
              name: "Collision",
              drafts: [],
              groups: [],
              annotations: [],
            },
          ],
          versusSeries: [],
        },
        options: {
          canvasIds: ["source-canvas"],
          versusSeriesIds: [],
          dedupeStrategy: "overwrite",
          canvasImportMode: "new_canvases",
        },
      });

    expect(res.status).toBe(200);
    expect(annotationDestroy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { canvas_id: "c-1" } }),
    );
    expect(annotationDestroy.mock.invocationCallOrder[0]).toBeLessThan(
      CanvasGroup.destroy.mock.invocationCallOrder[0],
    );
  });

  it("account deletion destroys annotations before each owned canvas", async () => {
    const user = { id: "u1", email: "owner@example.com", destroy: vi.fn() };
    vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
      req.user = user;
      next();
    });
    vi.spyOn(UserCanvas, "findAll").mockResolvedValue([{ canvas_id: "c-1" }]);
    vi.spyOn(UserCanvas, "destroy").mockResolvedValue(1);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "destroy").mockResolvedValue(0);
    const annotationDestroy = vi
      .spyOn(CanvasAnnotation, "destroy")
      .mockResolvedValue(2);
    vi.spyOn(Canvas, "destroy").mockResolvedValue(1);
    vi.spyOn(Draft, "destroy").mockResolvedValue(0);
    vi.spyOn(VersusDraft, "update").mockResolvedValue([0]);
    vi.spyOn(UserToken, "destroy").mockResolvedValue(1);

    const res = await request(buildApp())
      .delete("/api/users/me")
      .send({ confirmEmail: "owner@example.com" });

    expect(res.status).toBe(200);
    expect(annotationDestroy).toHaveBeenCalledWith({
      where: { canvas_id: "c-1" },
    });
    expect(annotationDestroy.mock.invocationCallOrder[0]).toBeLessThan(
      Canvas.destroy.mock.invocationCallOrder[0],
    );
  });
});
