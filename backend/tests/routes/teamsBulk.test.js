import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");
const sequelize = require("../../config/database");
const { CanvasGroup } = require("../../models/Canvas.js");

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

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

const team = (id, over = {}) => ({
  id,
  owner_id: "u1",
  source: "manual",
  tournament_id: null,
  archived_at: null,
  ...over,
});
const strangers = (id) => team(id, { owner_id: "u2" });
const importedTeam = (id) =>
  team(id, { owner_id: null, source: "esclub", tournament_id: "tour-1" });

const TX = { tx: true };
let update;
let destroy;
let findAll;
let transaction;
let canvasLookup;

function loaded(rows) {
  findAll.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  findAll = vi.spyOn(Team, "findAll").mockResolvedValue([]);
  update = vi.spyOn(Team, "update").mockResolvedValue([1]);
  destroy = vi.spyOn(Team, "destroy").mockResolvedValue(1);
  transaction = vi
    .spyOn(sequelize, "transaction")
    .mockImplementation(async (fn) => fn(TX));
  // canSeeTeam's canvas path: by default no canvas links the team for me.
  canvasLookup = vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(null);
});

const post = (body) => request(buildApp()).post("/api/teams/bulk").send(body);

function expectNothingWritten() {
  expect(transaction).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
}

describe("POST /bulk validation", () => {
  it.each([
    ["missing action", { ids: [A] }],
    ["unknown action", { action: "nuke", ids: [A] }],
    ["non-string action", { action: 1, ids: [A] }],
    ["ids missing", { action: "archive" }],
    ["ids not an array", { action: "archive", ids: A }],
    ["ids empty", { action: "archive", ids: [] }],
    ["non-string id", { action: "archive", ids: [A, 5] }],
    ["malformed id", { action: "archive", ids: ["not-a-uuid"] }],
    [
      "201 ids",
      { action: "archive", ids: Array.from({ length: 201 }, (_, i) => uuid(i)) },
    ],
    ["201 copies of one id", { action: "archive", ids: Array(201).fill(A) }],
  ])("400 for %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(findAll).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it("accepts exactly 200 distinct ids", async () => {
    const ids = Array.from({ length: 200 }, (_, i) => uuid(i));
    loaded(ids.map((id) => team(id)));
    const res = await post({ action: "archive", ids });
    expect(res.status).toBe(200);
  });
});

describe("POST /bulk authorization", () => {
  it("404 for the whole batch when one id is missing, nothing written", async () => {
    loaded([team(A)]);
    const res = await post({ action: "archive", ids: [A, B] });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Team not found" });
    expectNothingWritten();
  });

  it("404 when my pickup is batched with a stranger's pickup", async () => {
    loaded([team(A), strangers(B)]);
    const res = await post({ action: "delete", ids: [A, B] });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Team not found" });
    expectNothingWritten();
  });

  it("checks every team, not only the first", async () => {
    loaded([team(A), team(B), strangers(C)]);
    const res = await post({ action: "archive", ids: [A, B, C] });
    expect(res.status).toBe(404);
    expectNothingWritten();
  });

  it("404 beats 403: a stranger's id hides a refused one", async () => {
    loaded([team(A, { tournament_id: "tour-1" }), strangers(B)]);
    const res = await post({ action: "archive", ids: [A, B] });
    expect(res.status).toBe(404);
    expectNothingWritten();
  });

  it("403 for an imported team, nothing written", async () => {
    loaded([importedTeam(A)]);
    // Visible through a canvas link here (a UserTournaments row in real life).
    canvasLookup.mockResolvedValue({ id: "g1" });
    const res = await post({ action: "archive", ids: [A] });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Not authorized" });
    expectNothingWritten();
  });

  it("403 for a mix of my pickup and an imported team, every action", async () => {
    loaded([team(A), importedTeam(B)]);
    canvasLookup.mockResolvedValue({ id: "g1" });
    for (const action of ["archive", "restore", "delete"]) {
      const res = await post({ action, ids: [A, B] });
      expect(res.status).toBe(403);
    }
    expectNothingWritten();
  });

  it("403 for a canvas member with someone's linked pickup (visible, not archivable)", async () => {
    loaded([strangers(A)]);
    canvasLookup.mockResolvedValue({ id: "g1" });
    for (const action of ["archive", "restore", "delete"]) {
      const res = await post({ action, ids: [A] });
      expect(res.status).toBe(403);
    }
    expect(canvasLookup).toHaveBeenCalled();
    expectNothingWritten();
  });

  it("403 for my manual-tournament team, every action", async () => {
    loaded([team(A, { tournament_id: "tour-1" })]);
    for (const action of ["archive", "restore", "delete"]) {
      const res = await post({ action, ids: [A] });
      expect(res.status).toBe(403);
    }
    expectNothingWritten();
  });
});

describe("POST /bulk writes", () => {
  it("looks teams up in one query on the de-duplicated ids", async () => {
    loaded([team(A), team(B)]);
    await post({ action: "archive", ids: [A, B, A] });
    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findAll.mock.calls[0][0].where).toEqual({ id: [A, B] });
  });

  it("archive stamps only teams not already archived, inside the transaction", async () => {
    loaded([team(A), team(B)]);
    const res = await post({ action: "archive", ids: [A, B, A] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: "archive", ids: [A, B] });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    const [values, options] = update.mock.calls[0];
    expect(values.archived_at).toBeInstanceOf(Date);
    expect(options).toEqual({
      where: { id: [A, B], archived_at: null },
      transaction: TX,
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("restore clears archived_at for all ids", async () => {
    loaded([team(A, { archived_at: "2026-01-01" }), team(B)]);
    const res = await post({ action: "restore", ids: [A, B] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: "restore", ids: [A, B] });
    expect(update).toHaveBeenCalledWith(
      { archived_at: null },
      { where: { id: [A, B] }, transaction: TX },
    );
    expect(destroy).not.toHaveBeenCalled();
  });

  it("delete destroys exactly those ids inside the transaction", async () => {
    loaded([team(A), team(B)]);
    const res = await post({ action: "delete", ids: [B, A, B] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ action: "delete", ids: [B, A] });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledWith({
      where: { id: [B, A] },
      transaction: TX,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("500 through sendError when the write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    loaded([team(A)]);
    update.mockRejectedValue(new Error("boom"));
    const res = await post({ action: "archive", ids: [A] });
    expect(res.status).toBe(500);
  });
});
