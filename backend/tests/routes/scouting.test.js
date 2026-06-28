// backend/tests/routes/scouting.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

// Load CJS modules via Node's resolver so we can spy on the exports the route
// calls at request-time (auth.protect, scoutService.scoutPlayer). This mirrors
// the existing backend tests (e.g. tests/services/navigatorEngine.test.js),
// which use createRequire + vi.spyOn rather than ESM vi.mock for CJS interop.
const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const scoutService = require("../../services/scoutService");
const { makeScoutingRouter } = require("../../routes/scouting");

const envelope = {
  provider: "ugg", schemaVersion: 1, fetchedAt: "2026-06-28T12:00:00.000Z",
  season: "2026-S1", queue: "ranked_solo_5x5",
  entries: [{ championId: "Sylas", role: "mid", games: 37, wins: 22, lastPlayed: null, recentWindowGames: null }],
};

// Fresh app + isolated throttle per call — no cross-test throttle-budget leak.
function buildApp(opts) {
  const app = express();
  app.use(express.json());
  app.use("/api/scouting", makeScoutingRouter(opts));
  return app;
}

let scoutSpy;
beforeEach(() => {
  vi.restoreAllMocks();
  // Stub auth so requests are "authenticated" without a real JWT/cookie.
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  scoutSpy = vi.spyOn(scoutService, "scoutPlayer");
});

describe("POST /api/scouting/player", () => {
  it("400 when fields missing (and the service is not called)", async () => {
    scoutSpy.mockResolvedValue(envelope);
    const res = await request(buildApp()).post("/api/scouting/player").send({ region: "na1" });
    expect(res.status).toBe(400);
    expect(scoutSpy).not.toHaveBeenCalled();
  });

  it("200 returns the envelope from the service", async () => {
    scoutSpy.mockResolvedValue(envelope);
    const res = await request(buildApp())
      .post("/api/scouting/player")
      .send({ region: "na1", gameName: "Foo", tagLine: "NA1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(envelope);
    expect(scoutSpy).toHaveBeenCalledWith({ region: "na1", gameName: "Foo", tagLine: "NA1" });
  });

  it("502 when the upstream client throws", async () => {
    scoutSpy.mockRejectedValue(new Error("u.gg down"));
    const res = await request(buildApp())
      .post("/api/scouting/player")
      .send({ region: "na1", gameName: "Foo", tagLine: "NA1" });
    expect(res.status).toBe(502);
  });

  it("429 after exceeding the throttle within one isolated router", async () => {
    scoutSpy.mockResolvedValue(envelope);
    const app = buildApp({ windowMs: 10_000, max: 3 });
    const body = { region: "na1", gameName: "Foo", tagLine: "NA1" };
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).post("/api/scouting/player").send(body);
      expect(ok.status).toBe(200);
    }
    const res = await request(app).post("/api/scouting/player").send(body);
    expect(res.status).toBe(429);
  });
});
