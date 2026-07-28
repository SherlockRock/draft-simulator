import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import { Op } from "sequelize";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const { Canvas } = require("../../models/Canvas");
const VersusDraft = require("../../models/VersusDraft");
const VersusParticipant = require("../../models/VersusParticipant");
const NavigatorSession = require("../../models/NavigatorSession");

function buildApp() {
  const routePath = require.resolve("../../routes/activity");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/activity", require("../../routes/activity"));
  return app;
}

const versusRow = (id, name, origin) => ({
  id,
  name,
  description: "",
  blueTeamName: "Blue",
  redTeamName: "Red",
  length: 3,
  competitive: false,
  type: "fearless",
  origin,
  disabledChampions: [],
  updatedAt: new Date("2026-07-27T12:00:00Z"),
  createdAt: new Date("2026-07-27T12:00:00Z"),
  icon: "",
  owner_id: "u1",
  Drafts: [],
});

const ALL_SERIES = [
  versusRow("v-live", "Real Live Series", "live"),
  versusRow("v-manual", "Canvas Series", "manual"),
];

let versusWhere;

beforeEach(() => {
  vi.restoreAllMocks();
  versusWhere = undefined;

  vi.spyOn(auth, "getUserFromRequest").mockResolvedValue({ id: "u1" });
  vi.spyOn(Canvas, "findAll").mockResolvedValue([]);
  vi.spyOn(NavigatorSession, "findAll").mockResolvedValue([]);
  vi.spyOn(VersusParticipant, "findAll").mockReturnValue({
    then: (fn) => Promise.resolve(fn([])),
  });

  // Stand in for the database: capture the where clause, then honour its
  // origin condition against the fixtures. A query-shape assertion alone
  // would still pass if the clause were built but never applied.
  vi.spyOn(VersusDraft, "findAll").mockImplementation(async ({ where }) => {
    versusWhere = where;
    const excluded = where?.origin?.[Op.ne];
    return ALL_SERIES.filter((row) => !excluded || row.origin !== excluded);
  });
});

const names = (body) => body.activities.map((a) => a.resource_name);

describe("GET /api/activity/recent", () => {
  // Canvas-authored series are VersusDraft rows with origin "manual". They
  // belong to their canvas and should not surface in activity views.
  it("excludes canvas-created (manual) series", async () => {
    const res = await request(buildApp()).get("/api/activity/recent");

    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(["Real Live Series"]);
    expect(names(res.body)).not.toContain("Canvas Series");
  });

  it("asks the database to exclude them rather than filtering after the fetch", async () => {
    await request(buildApp()).get("/api/activity/recent");

    // Filtering post-fetch would break pagination: the route slices a page of
    // 12 out of the merged result, so discarded rows would shorten pages.
    expect(versusWhere.origin).toEqual({ [Op.ne]: "manual" });
  });

  it("still excludes them when a search term is supplied", async () => {
    const res = await request(buildApp()).get(
      "/api/activity/recent?search=Canvas",
    );

    expect(versusWhere.origin).toEqual({ [Op.ne]: "manual" });
    expect(names(res.body)).not.toContain("Canvas Series");
  });

  it("still excludes them when filtering to the versus resource type", async () => {
    const res = await request(buildApp()).get(
      "/api/activity/recent?resource_type=versus",
    );

    expect(versusWhere.origin).toEqual({ [Op.ne]: "manual" });
    expect(names(res.body)).toEqual(["Real Live Series"]);
  });

  it("leaves genuine live series reachable", async () => {
    const res = await request(buildApp()).get("/api/activity/recent");

    const live = res.body.activities.find((a) => a.resource_id === "v-live");
    expect(live).toBeDefined();
    expect(live.resource_type).toBe("versus");
    expect(live.origin).toBe("live");
  });
});
