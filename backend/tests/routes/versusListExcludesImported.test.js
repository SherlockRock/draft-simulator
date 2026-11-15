import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const sequelize = require("../../config/database");
const setupAssociations = require("../../models/associations");
const VersusDraft = require("../../models/VersusDraft");

/**
 * S3 plan D10: imported series leave `GET /api/versus-drafts`, so the Import
 * Versus Series tab can't put a second group on an imported VersusDraft
 * (deleting either group would destroy the other's cards). Manual series stay.
 */

function buildApp() {
  // The route destructures `authenticate` at load, so re-require it after the
  // spy is installed.
  const routePath = require.resolve("../../routes/versus");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/versus-drafts", require("../../routes/versus"));
  return app;
}

let associated = false;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "authenticate").mockImplementation((req, _res, next) => {
    req.user = { id: "u-1" };
    next();
  });
  if (!associated) {
    setupAssociations();
    associated = true;
  }
});

describe("GET /api/versus-drafts", () => {
  it("asks only for the user's series without a league_series_id", async () => {
    const findAll = vi.spyOn(VersusDraft, "findAll").mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/versus-drafts");

    expect(res.status).toBe(200);
    expect(findAll.mock.calls[0][0].where).toEqual({
      owner_id: "u-1",
      league_series_id: null,
    });
  });

  it("renders league_series_id IS NULL next to the owner in the SQL", async () => {
    const query = vi.spyOn(sequelize, "query").mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/versus-drafts");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(typeof sql).toBe("string");
    expect(sql).toMatch(/FROM "VersusDrafts" AS "VersusDraft"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "Drafts" AS "Drafts"/);
    expect(sql).toMatch(
      /WHERE "VersusDraft"\."owner_id" = 'u-1' AND "VersusDraft"\."league_series_id" IS NULL/,
    );
  });
});
