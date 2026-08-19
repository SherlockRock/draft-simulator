import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const SavedPool = require("../../models/SavedPool");
const Pool = require("../../models/Pool");
const sequelize = require("../../config/database");

const EMPTY_MAP = { top: [], jungle: [], mid: [], adc: [], support: [] };

function buildApp() {
  const routePath = require.resolve("../../routes/savedPools");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/saved-pools", require("../../routes/savedPools"));
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
});

describe("GET /api/saved-pools", () => {
  it("returns flat rows with name/champions/updatedAt read from the joined Pool", async () => {
    vi.spyOn(SavedPool, "findAll").mockResolvedValue([
      {
        id: "e1",
        owner_id: "u1",
        createdAt: "c",
        Pool: { id: "p1", name: "Scrims", champions: EMPTY_MAP, updatedAt: "pu" },
      },
    ]);

    const res = await request(buildApp()).get("/api/saved-pools");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "e1",
        owner_id: "u1",
        name: "Scrims",
        champions: EMPTY_MAP,
        createdAt: "c",
        updatedAt: "pu",
      },
    ]);
  });

  it("orders by the joined Pool's updatedAt DESC (recently-edited first)", async () => {
    const findAll = vi.spyOn(SavedPool, "findAll").mockResolvedValue([]);

    await request(buildApp()).get("/api/saved-pools");

    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        order: [[Pool, "updatedAt", "DESC"]],
      }),
    );
  });
});

describe("POST /api/saved-pools", () => {
  it("creates a Pool then an entry in one transaction and responds 201 with the flat shape", async () => {
    const createdPool = { id: "p1", name: "Scrims", champions: EMPTY_MAP, updatedAt: "pu" };
    const createdEntry = { id: "e1", owner_id: "u1", createdAt: "c" };
    vi.spyOn(sequelize, "transaction").mockImplementation(async (cb) => cb({}));
    const poolCreate = vi.spyOn(Pool, "create").mockResolvedValue(createdPool);
    const entryCreate = vi.spyOn(SavedPool, "create").mockResolvedValue(createdEntry);

    const res = await request(buildApp())
      .post("/api/saved-pools")
      .send({ name: "Scrims", champions: EMPTY_MAP });

    expect(res.status).toBe(201);
    expect(sequelize.transaction).toHaveBeenCalled();
    expect(poolCreate).toHaveBeenCalled();
    expect(entryCreate).toHaveBeenCalled();
    expect(res.body).toEqual({
      id: "e1",
      owner_id: "u1",
      name: "Scrims",
      champions: EMPTY_MAP,
      createdAt: "c",
      updatedAt: "pu",
    });
  });

  it("400s when champions is missing a role key", async () => {
    vi.spyOn(sequelize, "transaction");
    const poolCreate = vi.spyOn(Pool, "create");

    const res = await request(buildApp())
      .post("/api/saved-pools")
      .send({ name: "Scrims", champions: { top: [], jungle: [], mid: [], adc: [] } });

    expect(res.status).toBe(400);
    expect(poolCreate).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/saved-pools/:id", () => {
  it("writes name/champions onto the Pool row, entry untouched", async () => {
    const pool = {
      id: "p1",
      name: "Old",
      champions: EMPTY_MAP,
      updatedAt: "pu",
      changed: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const entry = { id: "e1", owner_id: "u1", createdAt: "c", Pool: pool };
    vi.spyOn(SavedPool, "findByPk").mockResolvedValue(entry);

    const res = await request(buildApp())
      .patch("/api/saved-pools/e1")
      .send({ name: "New Name", champions: { ...EMPTY_MAP, top: ["Ahri"] } });

    expect(res.status).toBe(200);
    expect(pool.save).toHaveBeenCalled();
    expect(pool.name).toBe("New Name");
    expect(pool.champions).toEqual({ ...EMPTY_MAP, top: ["Ahri"] });
    expect(res.body).toEqual({
      id: "e1",
      owner_id: "u1",
      name: "New Name",
      champions: { ...EMPTY_MAP, top: ["Ahri"] },
      createdAt: "c",
      updatedAt: "pu",
    });
  });

  it("403s a non-owner", async () => {
    const pool = { id: "p1", name: "Old", champions: EMPTY_MAP, updatedAt: "pu", save: vi.fn() };
    const entry = { id: "e1", owner_id: "someoneElse", createdAt: "c", Pool: pool };
    vi.spyOn(SavedPool, "findByPk").mockResolvedValue(entry);

    const res = await request(buildApp())
      .patch("/api/saved-pools/e1")
      .send({ name: "New Name" });

    expect(res.status).toBe(403);
    expect(pool.save).not.toHaveBeenCalled();
  });

  it("404s a missing saved pool", async () => {
    vi.spyOn(SavedPool, "findByPk").mockResolvedValue(null);

    const res = await request(buildApp())
      .patch("/api/saved-pools/eMissing")
      .send({ name: "New Name" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/saved-pools/:id", () => {
  it("destroys the Pool row, not the entry", async () => {
    const pool = { id: "p1", destroy: vi.fn().mockResolvedValue(undefined) };
    const entry = { id: "e1", owner_id: "u1", destroy: vi.fn(), Pool: pool };
    vi.spyOn(SavedPool, "findByPk").mockResolvedValue(entry);

    const res = await request(buildApp()).delete("/api/saved-pools/e1");

    expect(res.status).toBe(200);
    expect(pool.destroy).toHaveBeenCalled();
    expect(entry.destroy).not.toHaveBeenCalled();
  });

  it("enforces the owner check", async () => {
    const pool = { id: "p1", destroy: vi.fn() };
    const entry = { id: "e1", owner_id: "someoneElse", Pool: pool };
    vi.spyOn(SavedPool, "findByPk").mockResolvedValue(entry);

    const res = await request(buildApp()).delete("/api/saved-pools/e1");

    expect(res.status).toBe(403);
    expect(pool.destroy).not.toHaveBeenCalled();
  });
});
