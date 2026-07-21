import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");

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

describe("isValidTeamName", () => {
  const { isValidTeamName } = loadRouter();
  it("accepts a normal name", () => {
    expect(isValidTeamName("T1")).toBe(true);
  });
  it("rejects empty / whitespace", () => {
    expect(isValidTeamName("")).toBe(false);
    expect(isValidTeamName("   ")).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isValidTeamName(null)).toBe(false);
    expect(isValidTeamName(42)).toBe(false);
  });
  it("rejects > 120 chars", () => {
    expect(isValidTeamName("x".repeat(121))).toBe(false);
  });
});

describe("teams CRUD routes", () => {
  it("GET / lists only the requesting user's teams", async () => {
    const findAll = vi
      .spyOn(Team, "findAll")
      .mockResolvedValue([{ id: "t1", owner_id: "u1", name: "T1" }]);

    const res = await request(buildApp()).get("/api/teams");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "t1", owner_id: "u1", name: "T1" }]);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { owner_id: "u1" } }),
    );
  });

  it("POST / rejects an empty name with 400", async () => {
    const create = vi.spyOn(Team, "create");
    const res = await request(buildApp())
      .post("/api/teams")
      .send({ name: "  " });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST / creates a trimmed team owned by the user", async () => {
    vi.spyOn(Team, "create").mockImplementation(async (attrs) => ({
      id: "new",
      ...attrs,
    }));

    const res = await request(buildApp())
      .post("/api/teams")
      .send({ name: "  Gen.G  " });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "new", owner_id: "u1", name: "Gen.G" });
  });

  it("PATCH /:id returns 403 when the team belongs to another user", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue({
      id: "t1",
      owner_id: "someone-else",
      name: "T1",
      save: vi.fn(),
    });

    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ name: "New" });

    expect(res.status).toBe(403);
  });

  it("PATCH /:id renames an owned team", async () => {
    const save = vi.fn();
    vi.spyOn(Team, "findByPk").mockResolvedValue({
      id: "t1",
      owner_id: "u1",
      name: "Old",
      save,
    });

    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ name: "  New Name  " });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
    expect(save).toHaveBeenCalled();
  });

  it("DELETE /:id returns 404 for a missing team", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue(null);

    const res = await request(buildApp()).delete("/api/teams/nope");

    expect(res.status).toBe(404);
  });

  it("DELETE /:id destroys an owned team", async () => {
    const destroy = vi.fn();
    vi.spyOn(Team, "findByPk").mockResolvedValue({
      id: "t1",
      owner_id: "u1",
      destroy,
    });

    const res = await request(buildApp()).delete("/api/teams/t1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(destroy).toHaveBeenCalled();
  });
});
