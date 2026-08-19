import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const socketService = require("../../middleware/socketService");
const Draft = require("../../models/Draft");
// Required as a namespace, not destructured: the route re-requires this module
// at call time, so a spy has to be installed on the shared exports object.
const helpers = require("../../helpers");
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
  CanvasAnnotation,
  CanvasPoolPlacement,
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
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
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

  it("keeps blueSideTeam and firstPick in the canvas broadcast", async () => {
    const emitted = [];
    socketService.emitToRoom.mockImplementation((room, event, payload) => {
      emitted.push({ room, event, payload });
    });

    const draft = mockDraft({ ownerId: "u1" });
    vi.spyOn(Draft, "findByPk").mockResolvedValue(draft);
    vi.spyOn(Canvas, "findByPk").mockResolvedValue({
      toJSON: () => ({ id: "c-1" }),
    });
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([]);

    await request(buildApp())
      .put("/api/drafts/d-1?canvas_id=c-1")
      .send({ description: "changed" })
      .expect(200);

    const update = emitted.find((event) => event.event === "canvasUpdate");
    expect(update).toBeDefined();
    const projected = CanvasDraft.findAll.mock.calls.at(-1)[0];
    const draftAttrs = projected.include[0].attributes;
    expect(draftAttrs).toContain("blueSideTeam");
    expect(draftAttrs).toContain("firstPick");
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

  it("de-duplicates a rename against the canvas the edit is on, not the first association", async () => {
    const draft = mockDraft({ ownerId: "u1" });
    vi.spyOn(Draft, "findByPk").mockResolvedValue(draft);
    // Draft lives on two canvases; the request is scoped to the SECOND one.
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([
      { canvas_id: "c-first" },
      { canvas_id: "c-current" },
    ]);
    vi.spyOn(Canvas, "findByPk").mockResolvedValue(null);
    const unique = vi
      .spyOn(helpers, "generateUniqueCanvasDraftName")
      .mockResolvedValue("Renamed");

    await request(buildApp())
      .put("/api/drafts/d-1?canvas_id=c-current")
      .send({ name: "Renamed" })
      .expect(200);

    expect(unique).toHaveBeenCalledWith("Renamed", "c-current", "d-1");
  });

  it("falls back to the first association when the draft is not on the named canvas", async () => {
    const draft = mockDraft({ ownerId: "u1" });
    vi.spyOn(Draft, "findByPk").mockResolvedValue(draft);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([
      { canvas_id: "c-first" },
    ]);
    vi.spyOn(Canvas, "findByPk").mockResolvedValue(null);
    const unique = vi
      .spyOn(helpers, "generateUniqueCanvasDraftName")
      .mockResolvedValue("Renamed");

    await request(buildApp())
      .put("/api/drafts/d-1?canvas_id=c-elsewhere")
      .send({ name: "Renamed" })
      .expect(200);

    expect(unique).toHaveBeenCalledWith("Renamed", "c-first", "d-1");
  });

  it("leaves public untouched when a rename omits it, and emits the narrow event", async () => {
    // Renaming used to send `public: false`, which silently un-published the
    // draft AND pushed the broadcast down the full-canvasUpdate branch.
    const draft = mockDraft({ ownerId: "u1" });
    draft.public = true;
    vi.spyOn(Draft, "findByPk").mockResolvedValue(draft);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([{ canvas_id: "c-1" }]);
    vi.spyOn(Canvas, "findByPk").mockResolvedValue({
      toJSON: () => ({ id: "c-1" }),
    });
    vi.spyOn(helpers, "generateUniqueCanvasDraftName").mockResolvedValue(
      "Renamed",
    );
    const emitted = [];
    socketService.emitToRoom.mockImplementation((room, event, payload) => {
      emitted.push({ room, event, payload });
    });

    await request(buildApp())
      .put("/api/drafts/d-1?canvas_id=c-1")
      .send({ name: "Renamed" })
      .expect(200);

    expect(draft.public).toBe(true);
    const canvasEvents = emitted.filter((e) => e.room === "c-1");
    expect(canvasEvents.map((e) => e.event)).toEqual(["draftNameUpdated"]);
    expect(canvasEvents[0].payload).toEqual({
      draftId: "d-1",
      name: "Renamed",
    });
  });
});
