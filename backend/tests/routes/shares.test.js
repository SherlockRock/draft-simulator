import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const auth = require("../../middleware/auth");
const { Canvas, UserCanvas } = require("../../models/Canvas");

function loadRouter() {
  const routePath = require.resolve("../../routes/shares");
  delete require.cache[routePath];
  return require("../../routes/shares");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/shares", loadRouter());
  return app;
}

function shareToken({ permissions = "view", expiresIn = "7d", secret } = {}) {
  return jwt.sign({ canvasId: "canvas-1", permissions }, secret ?? SECRET, {
    expiresIn,
  });
}

function verify(token) {
  return request(buildApp()).get(
    `/api/shares/verify-canvas-link?token=${token}`,
  );
}

const SECRET = "test-share-secret";

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.SHARE_JWT_SECRET = SECRET;
  vi.spyOn(auth, "getUserFromRequest").mockResolvedValue({ id: "u1" });
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({ id: "canvas-1" });
  vi.spyOn(UserCanvas, "create").mockResolvedValue({});
});

describe("GET /shares/verify-canvas-link", () => {
  it("lets an existing member back in on an expired link", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({ permissions: "view" });

    const res = await verify(shareToken({ expiresIn: "-1h" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, canvasId: "canvas-1" });
  });

  it("does not upgrade an existing member's permissions on an expired link", async () => {
    const update = vi.fn();
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({
      permissions: "view",
      update,
    });

    const res = await verify(
      shareToken({ permissions: "edit", expiresIn: "-1h" }),
    );

    expect(res.status).toBe(200);
    expect(update).not.toHaveBeenCalled();
  });

  it("upgrades an existing member from view to edit on a live link", async () => {
    const update = vi.fn();
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue({
      permissions: "view",
      update,
    });

    const res = await verify(shareToken({ permissions: "edit" }));

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ permissions: "edit" });
  });

  it("answers 410, not 401, when a non-member opens an expired link", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue(null);

    const res = await verify(shareToken({ expiresIn: "-1h" }));

    expect(res.status).toBe(410);
    expect(UserCanvas.create).not.toHaveBeenCalled();
  });

  it("answers 400, not 401, for a token signed with a stale secret", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue(null);

    const res = await verify(shareToken({ secret: "rotated-secret" }));

    expect(res.status).toBe(400);
    expect(UserCanvas.create).not.toHaveBeenCalled();
  });

  it("grants access to a new member on a live link", async () => {
    vi.spyOn(UserCanvas, "findOne").mockResolvedValue(null);

    const res = await verify(shareToken({ permissions: "edit" }));

    expect(res.status).toBe(200);
    expect(UserCanvas.create).toHaveBeenCalledWith({
      canvas_id: "canvas-1",
      user_id: "u1",
      permissions: "edit",
    });
  });

  it("reserves 401 for a genuinely unauthenticated requester", async () => {
    auth.getUserFromRequest.mockResolvedValue(null);

    const res = await verify(shareToken());

    expect(res.status).toBe(401);
  });
});
