import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");
const TeamPlayer = require("../../models/TeamPlayer");
const sequelize = require("../../config/database");

function loadRouter() {
  const routePath = require.resolve("../../routes/teams");
  delete require.cache[routePath];
  return require("../../routes/teams");
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/teams", loadRouter());
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
});

describe("validateRosterPlayers", () => {
  const { validateRosterPlayers } = loadRouter();

  it("accepts an empty roster", () => {
    expect(validateRosterPlayers([])).toEqual({ ok: true });
  });

  it("accepts up to 10 valid players", () => {
    const players = Array.from({ length: 10 }, (_, i) => ({
      role: null,
      gameName: `p${i}`,
      tagLine: "NA1",
      ordinal: i,
    }));
    expect(validateRosterPlayers(players)).toEqual({ ok: true });
  });

  it("rejects more than 10 players", () => {
    const players = Array.from({ length: 11 }, (_, i) => ({
      role: null,
      gameName: `p${i}`,
      tagLine: "NA1",
      ordinal: i,
    }));
    expect(validateRosterPlayers(players).ok).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(
      validateRosterPlayers([
        { role: "coach", gameName: "x", tagLine: "y", ordinal: 0 },
      ]).ok,
    ).toBe(false);
  });

  it("rejects a duplicate non-null role", () => {
    expect(
      validateRosterPlayers([
        { role: "mid", gameName: "a", tagLine: "1", ordinal: 0 },
        { role: "mid", gameName: "b", tagLine: "2", ordinal: 1 },
      ]).ok,
    ).toBe(false);
  });

  it("allows multiple bench (null-role) players", () => {
    expect(
      validateRosterPlayers([
        { role: null, gameName: "a", tagLine: "1", ordinal: 0 },
        { role: null, gameName: "b", tagLine: "2", ordinal: 1 },
      ]).ok,
    ).toBe(true);
  });

  it("rejects an empty gameName or tagLine", () => {
    expect(
      validateRosterPlayers([{ role: null, gameName: "", tagLine: "1" }]).ok,
    ).toBe(false);
    expect(
      validateRosterPlayers([{ role: null, gameName: "a", tagLine: "" }]).ok,
    ).toBe(false);
  });

  it("rejects oversized gameName (>64) or tagLine (>16) with a 400-able result", () => {
    expect(
      validateRosterPlayers([
        { role: null, gameName: "x".repeat(65), tagLine: "1" },
      ]).ok,
    ).toBe(false);
    expect(
      validateRosterPlayers([
        { role: null, gameName: "a", tagLine: "x".repeat(17) },
      ]).ok,
    ).toBe(false);
  });
});

describe("PUT /:id/roster", () => {
  it("returns 403 for another user's team", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue({
      id: "t1",
      owner_id: "someone-else",
    });
    const res = await request(buildApp())
      .put("/api/teams/t1/roster")
      .send({ players: [] });
    expect(res.status).toBe(403);
  });

  it("returns 400 on a duplicate role without touching the DB", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue({ id: "t1", owner_id: "u1" });
    const destroy = vi.spyOn(TeamPlayer, "destroy");
    const res = await request(buildApp())
      .put("/api/teams/t1/roster")
      .send({
        players: [
          { role: "mid", gameName: "a", tagLine: "1", ordinal: 0 },
          { role: "mid", gameName: "b", tagLine: "2", ordinal: 1 },
        ],
      });
    expect(res.status).toBe(400);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("replaces the roster inside a transaction for an owned team", async () => {
    vi.spyOn(Team, "findByPk")
      .mockResolvedValueOnce({ id: "t1", owner_id: "u1" })
      .mockResolvedValueOnce({ id: "t1", owner_id: "u1", TeamPlayers: [] });
    const destroy = vi.spyOn(TeamPlayer, "destroy").mockResolvedValue(1);
    const bulkCreate = vi.spyOn(TeamPlayer, "bulkCreate").mockResolvedValue([]);
    vi.spyOn(sequelize, "transaction").mockImplementation(async (fn) =>
      fn({}),
    );

    const res = await request(buildApp())
      .put("/api/teams/t1/roster")
      .send({
        players: [{ role: "top", gameName: "Kiin", tagLine: "KR1" }],
      });

    expect(res.status).toBe(200);
    expect(destroy).toHaveBeenCalled();
    expect(bulkCreate).toHaveBeenCalled();
  });

  it("ignores a client-supplied ordinal and reassigns by array index", async () => {
    vi.spyOn(Team, "findByPk")
      .mockResolvedValueOnce({ id: "t1", owner_id: "u1" })
      .mockResolvedValueOnce({ id: "t1", owner_id: "u1", TeamPlayers: [] });
    vi.spyOn(TeamPlayer, "destroy").mockResolvedValue(1);
    const bulkCreate = vi.spyOn(TeamPlayer, "bulkCreate").mockResolvedValue([]);
    vi.spyOn(sequelize, "transaction").mockImplementation(async (fn) => fn({}));

    await request(buildApp())
      .put("/api/teams/t1/roster")
      .send({
        players: [
          { role: "top", gameName: "A", tagLine: "1", ordinal: 99 },
          { role: "mid", gameName: "B", tagLine: "2", ordinal: 99 },
        ],
      });

    const rows = bulkCreate.mock.calls[0][0];
    expect(rows.map((r) => r.ordinal)).toEqual([0, 1]);
  });

  it("saves region atomically with the roster when provided", async () => {
    const save = vi.fn();
    const team = { id: "t1", owner_id: "u1", region: "na1", save };
    vi.spyOn(Team, "findByPk")
      .mockResolvedValueOnce(team)
      .mockResolvedValueOnce({ ...team, region: "kr", TeamPlayers: [] });
    vi.spyOn(TeamPlayer, "destroy").mockResolvedValue(1);
    vi.spyOn(TeamPlayer, "bulkCreate").mockResolvedValue([]);
    vi.spyOn(sequelize, "transaction").mockImplementation(async (fn) => fn({}));

    const res = await request(buildApp())
      .put("/api/teams/t1/roster")
      .send({ region: "kr", players: [] });

    expect(res.status).toBe(200);
    expect(team.region).toBe("kr");
    expect(save).toHaveBeenCalled();
  });

  it("rejects an invalid region in the roster body with 400", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue({ id: "t1", owner_id: "u1" });
    const destroy = vi.spyOn(TeamPlayer, "destroy");
    const res = await request(buildApp())
      .put("/api/teams/t1/roster")
      .send({ region: "moon1", players: [] });
    expect(res.status).toBe(400);
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("PATCH /:id region", () => {
  it("rejects an invalid region with 400", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue({
      id: "t1",
      owner_id: "u1",
      save: vi.fn(),
    });
    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ region: "moon1" });
    expect(res.status).toBe(400);
  });

  it("updates the region for an owned team", async () => {
    const save = vi.fn();
    vi.spyOn(Team, "findByPk").mockResolvedValue({
      id: "t1",
      owner_id: "u1",
      name: "T1",
      region: "na1",
      save,
    });
    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ region: "kr" });
    expect(res.status).toBe(200);
    expect(res.body.region).toBe("kr");
    expect(save).toHaveBeenCalled();
  });
});
