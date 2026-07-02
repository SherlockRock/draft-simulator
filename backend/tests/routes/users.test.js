import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const sequelize = require("../../config/database");
const { UserCanvas } = require("../../models/Canvas");

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
