import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const viewportPersistence = require("../../services/viewportPersistence");

function buildApp() {
  const routePath = require.resolve("../../routes/canvas");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/canvas", require("../../routes/canvas"));
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "getUserFromRequest").mockResolvedValue({ id: "u1" });
});

const body = { x: 1, y: 2, zoom: 0.5 };

describe("PATCH /api/canvas/:canvasId/viewport", () => {
  it("delegates to persistViewport with the caller's identity and echoes the viewport", async () => {
    const spy = vi
      .spyOn(viewportPersistence, "persistViewport")
      .mockResolvedValue("saved");
    const res = await request(buildApp()).patch("/api/canvas/c1/viewport").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "Viewport updated",
      viewport: body,
      persisted: true,
    });
    expect(spy).toHaveBeenCalledWith({ userId: "u1", canvasId: "c1", viewport: body });
  });

  it("answers 200 persisted:false on a lock timeout — the client must not retry", async () => {
    vi.spyOn(viewportPersistence, "persistViewport").mockResolvedValue("lock-timeout");
    const res = await request(buildApp()).patch("/api/canvas/c1/viewport").send(body);
    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(false);
  });

  it("answers 403 when the user has no membership row", async () => {
    vi.spyOn(viewportPersistence, "persistViewport").mockResolvedValue("no-access");
    const res = await request(buildApp()).patch("/api/canvas/c1/viewport").send(body);
    expect(res.status).toBe(403);
  });

  it("answers 400 on a non-numeric body without touching the service", async () => {
    const spy = vi.spyOn(viewportPersistence, "persistViewport");
    const res = await request(buildApp())
      .patch("/api/canvas/c1/viewport")
      .send({ x: "1", y: 2, zoom: 0.5 });
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers 401 with no user", async () => {
    auth.getUserFromRequest.mockResolvedValue(null);
    const res = await request(buildApp()).patch("/api/canvas/c1/viewport").send(body);
    expect(res.status).toBe(401);
  });

  it("answers 500 when the service throws", async () => {
    vi.spyOn(viewportPersistence, "persistViewport").mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).patch("/api/canvas/c1/viewport").send(body);
    expect(res.status).toBe(500);
  });
});
