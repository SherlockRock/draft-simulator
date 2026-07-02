import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const Draft = require("../../models/Draft");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
} = require("../../models/Canvas.js");

const EDIT_FORBIDDEN =
  "Forbidden: You don't have permission to edit this canvas";

function loadRouter() {
  const routePath = require.resolve("../../routes/drafts");
  delete require.cache[routePath];
  return require("../../routes/drafts");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/drafts", loadRouter());
  return app;
}

function mockCanvasAccess(permissions) {
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue(
    permissions ? { permissions } : null,
  );
}

function mockDraft({ ownerId = "owner-1" } = {}) {
  return {
    id: "d-1",
    owner_id: ownerId,
    name: "Draft",
    public: false,
    type: "canvas",
    description: "",
    icon: "",
    save: vi.fn().mockResolvedValue(),
    toJSON() {
      return {
        id: this.id,
        owner_id: this.owner_id,
        name: this.name,
        public: this.public,
        type: this.type,
        description: this.description,
        icon: this.icon,
      };
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(socketService, "emitToRoom").mockImplementation(() => {});
});

describe("draft route canvas access", () => {
  it("POST / with canvas_id returns original 403 text for view permission", async () => {
    vi.spyOn(Canvas, "findByPk").mockResolvedValue({ id: "c-1" });
    mockCanvasAccess("view");
    vi.spyOn(Draft, "create").mockResolvedValue(mockDraft({ ownerId: "u1" }));

    const res = await request(buildApp()).post("/api/drafts").send({
      name: "New Draft",
      canvas_id: "c-1",
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: EDIT_FORBIDDEN });
    expect(Draft.create).not.toHaveBeenCalled();
  });

  it("PUT /:id allows a non-owner with canvas edit permission", async () => {
    const draft = mockDraft({ ownerId: "owner-1" });
    vi.spyOn(Draft, "findByPk").mockResolvedValue(draft);
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue({ canvas_id: "c-1" });
    mockCanvasAccess("edit");
    vi.spyOn(Canvas, "findByPk").mockResolvedValue(null);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);

    const res = await request(buildApp())
      .put("/api/drafts/d-1?canvas_id=c-1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(draft.save).toHaveBeenCalled();
  });

  it("PUT /:id keeps the existing draft 403 for non-owner view permission", async () => {
    const draft = mockDraft({ ownerId: "owner-1" });
    vi.spyOn(Draft, "findByPk").mockResolvedValue(draft);
    vi.spyOn(CanvasDraft, "findOne").mockResolvedValue({ canvas_id: "c-1" });
    mockCanvasAccess("view");
    vi.spyOn(Canvas, "findByPk").mockResolvedValue(null);
    vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);

    const res = await request(buildApp())
      .put("/api/drafts/d-1?canvas_id=c-1")
      .send({ name: "Renamed" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not authorized to edit this draft" });
    expect(draft.save).not.toHaveBeenCalled();
  });
});
