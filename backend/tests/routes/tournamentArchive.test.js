import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const UserTournament = require("../../models/UserTournament");
const Tournament = require("../../models/Tournament");

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

const TID = "44444444-4444-4444-8444-444444444444";
let update;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  update = vi.spyOn(UserTournament, "update").mockResolvedValue([1]);
});

const put = (id, body) =>
  request(buildApp()).put(`/api/teams/tournaments/${id}/archive`).send(body);

describe("PUT /tournaments/:id/archive", () => {
  it.each([
    ["missing", {}],
    ["a string", { archived: "true" }],
    ["a number", { archived: 1 }],
    ["null", { archived: null }],
  ])("400 when archived is %s", async (_l, body) => {
    const res = await put(TID, body);
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("404 (not 500) for a malformed id, without touching the database", async () => {
    const res = await put("nope", { archived: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Tournament not found" });
    expect(update).not.toHaveBeenCalled();
  });

  it("archives the caller's own row only", async () => {
    const res = await put(TID, { archived: true });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    const [values, options] = update.mock.calls[0];
    expect(values.archived_at).toBeInstanceOf(Date);
    expect(options.where).toEqual({ user_id: "u1", tournament_id: TID });
    expect(res.body.tournament_id).toBe(TID);
    expect(res.body.archived_at).toBe(values.archived_at.toISOString());
  });

  it("restores by clearing archived_at", async () => {
    const res = await put(TID, { archived: false });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      { archived_at: null },
      { where: { user_id: "u1", tournament_id: TID } },
    );
    expect(res.body).toEqual({ tournament_id: TID, archived_at: null });
  });

  it("404 when the caller has no row", async () => {
    update.mockResolvedValue([0]);
    const res = await put(TID, { archived: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Tournament not found" });
  });

  it("never creates a row or touches Tournaments", async () => {
    const create = vi.spyOn(UserTournament, "create");
    const upsert = vi.spyOn(UserTournament, "upsert");
    const findOrCreate = vi.spyOn(UserTournament, "findOrCreate");
    const tUpdate = vi.spyOn(Tournament, "update");
    await put(TID, { archived: true });
    update.mockResolvedValue([0]);
    await put(TID, { archived: true });
    expect(create).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(findOrCreate).not.toHaveBeenCalled();
    expect(tUpdate).not.toHaveBeenCalled();
  });
});
