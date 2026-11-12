import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");
const UserTournament = require("../../models/UserTournament");
const { CanvasGroup } = require("../../models/Canvas.js");
const { Op } = require("sequelize");
const { visibleTeamsWhere } = require("../../services/teamAccess");

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

const pickup = (over = {}) => ({
  id: "t1",
  owner_id: "u1",
  name: "T1",
  region: "na1",
  source: "manual",
  tournament_id: null,
  ...over,
});
const imported = (over = {}) => ({
  id: "e1",
  owner_id: null,
  name: "Esclub FC",
  region: "na1",
  source: "esclub",
  tournament_id: "tour-1",
  Tournament: { id: "tour-1", name: "Spring", source: "esclub" },
  ...over,
});

describe("GET /", () => {
  it("scopes to owned non-archived pickup + non-archived UserTournaments, ANDed with visibleTeamsWhere", async () => {
    const memberships = vi
      .spyOn(UserTournament, "findAll")
      .mockResolvedValue([{ tournament_id: "tour-1" }]);
    const findAll = vi.spyOn(Team, "findAll").mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/teams");

    expect(res.status).toBe(200);
    expect(memberships).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { user_id: "u1", archived_at: null },
      }),
    );
    const options = findAll.mock.calls[0][0];
    expect(options.where).toEqual({
      [Op.and]: [
        visibleTeamsWhere("u1"),
        {
          [Op.or]: [
            { tournament_id: null, owner_id: "u1", archived_at: null },
            { tournament_id: { [Op.in]: ["tour-1"] } },
          ],
        },
      ],
    });
    expect(options.order[0]).toEqual(["name", "ASC"]);
    const models = options.include.map((i) => i.model.name);
    expect(models).toEqual(["TeamPlayer", "Tournament"]);
    expect(options.include[1].attributes).toEqual(["id", "name", "source"]);
  });

  it("drops the tournament branch when the user has no active tournaments", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    const findAll = vi.spyOn(Team, "findAll").mockResolvedValue([]);

    await request(buildApp()).get("/api/teams");

    expect(findAll.mock.calls[0][0].where[Op.and][1]).toEqual({
      [Op.or]: [{ tournament_id: null, owner_id: "u1", archived_at: null }],
    });
  });

  it("rows carry canEditRoster and Tournament", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    vi.spyOn(Team, "findAll").mockResolvedValue([
      { ...pickup(), Tournament: null },
      imported(),
    ]);

    const res = await request(buildApp()).get("/api/teams");

    expect(res.body[0]).toMatchObject({
      id: "t1",
      canEditRoster: true,
      Tournament: null,
    });
    expect(res.body[1]).toMatchObject({
      id: "e1",
      canEditRoster: false,
      Tournament: { id: "tour-1", name: "Spring", source: "esclub" },
    });
  });
});

describe("teams CRUD routes", () => {
  it("POST / rejects an empty name with 400", async () => {
    const create = vi.spyOn(Team, "create");
    const res = await request(buildApp())
      .post("/api/teams")
      .send({ name: "  " });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST / creates a trimmed manual pickup team owned by the user", async () => {
    const create = vi
      .spyOn(Team, "create")
      .mockImplementation(async (attrs) => ({ id: "new", ...attrs }));

    const res = await request(buildApp())
      .post("/api/teams")
      .send({ name: "  Gen.G  " });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      owner_id: "u1",
      name: "Gen.G",
      source: "manual",
      tournament_id: null,
    });
    expect(res.body).toMatchObject({
      id: "new",
      owner_id: "u1",
      name: "Gen.G",
      Tournament: null,
      canEditRoster: true,
    });
  });

  it("PATCH /:id renames an owned team and returns a list row", async () => {
    const save = vi.fn();
    vi.spyOn(Team, "findByPk").mockResolvedValue(pickup({ name: "Old", save }));

    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ name: "  New Name  " });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
    expect(res.body.canEditRoster).toBe(true);
    expect(res.body.Tournament).toBe(null);
    expect(save).toHaveBeenCalled();
  });

  it("PATCH /:id loads the team with its Tournament", async () => {
    const findByPk = vi
      .spyOn(Team, "findByPk")
      .mockResolvedValue(pickup({ save: vi.fn() }));

    await request(buildApp()).patch("/api/teams/t1").send({ name: "N" });

    const include = findByPk.mock.calls[0][1].include;
    expect(include.map((i) => i.model.name)).toEqual(["Tournament"]);
  });

  it("PATCH /:id returns 404 for someone else's pickup with no canvas link", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue(
      pickup({ owner_id: "someone-else", save: vi.fn() }),
    );
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(null);

    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ name: "New" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Team not found");
  });

  it("PATCH /:id returns 403 for someone else's pickup visible through a canvas", async () => {
    const save = vi.fn();
    vi.spyOn(Team, "findByPk").mockResolvedValue(
      pickup({ owner_id: "someone-else", save }),
    );
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue({ id: "g-1" });

    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ name: "New" });

    expect(res.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });

  it("PATCH /:id returns 403 for an imported team", async () => {
    const save = vi.fn();
    vi.spyOn(Team, "findByPk").mockResolvedValue(imported({ save }));

    const res = await request(buildApp())
      .patch("/api/teams/e1")
      .send({ name: "New" });

    expect(res.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });

  it("PATCH /:id maps an invariant failure to 400 without saving", async () => {
    const save = vi.fn();
    // a pickup team row that points at a tournament it was not loaded with
    vi.spyOn(Team, "findByPk").mockResolvedValue(
      pickup({ tournament_id: "tour-1", save }),
    );

    const res = await request(buildApp())
      .patch("/api/teams/t1")
      .send({ name: "New" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tournament/i);
    expect(save).not.toHaveBeenCalled();
  });

  it("DELETE /:id returns 404 for a missing team", async () => {
    vi.spyOn(Team, "findByPk").mockResolvedValue(null);

    const res = await request(buildApp()).delete("/api/teams/nope");

    expect(res.status).toBe(404);
  });

  it("DELETE /:id destroys an owned team", async () => {
    const destroy = vi.fn();
    vi.spyOn(Team, "findByPk").mockResolvedValue(pickup({ destroy }));

    const res = await request(buildApp()).delete("/api/teams/t1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(destroy).toHaveBeenCalled();
  });

  it("DELETE /:id is 404 for another user's unlinked pickup, 403 when seen through a canvas, 403 for imported", async () => {
    const destroy = vi.fn();
    const findByPk = vi.spyOn(Team, "findByPk");
    const group = vi.spyOn(CanvasGroup, "findOne");

    findByPk.mockResolvedValue(pickup({ owner_id: "x", destroy }));
    group.mockResolvedValue(null);
    expect((await request(buildApp()).delete("/api/teams/t1")).status).toBe(404);

    group.mockResolvedValue({ id: "g" });
    expect((await request(buildApp()).delete("/api/teams/t1")).status).toBe(403);

    findByPk.mockResolvedValue(imported({ destroy }));
    expect((await request(buildApp()).delete("/api/teams/e1")).status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe("anonymous callers", () => {
  it("are stopped by protect before any team code runs", async () => {
    vi.spyOn(auth, "protect").mockImplementation((_req, res) =>
      res.status(401).json({ error: "Not authorized" }),
    );
    const findByPk = vi.spyOn(Team, "findByPk");
    const findAll = vi.spyOn(Team, "findAll");

    const app = buildApp();
    expect((await request(app).get("/api/teams")).status).toBe(401);
    expect(
      (await request(app).patch("/api/teams/t1").send({ name: "x" })).status,
    ).toBe(401);
    expect((await request(app).delete("/api/teams/t1")).status).toBe(401);
    expect(findByPk).not.toHaveBeenCalled();
    expect(findAll).not.toHaveBeenCalled();
  });
});
