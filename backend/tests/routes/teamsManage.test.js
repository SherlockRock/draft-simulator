import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const Team = require("../../models/Team");
const UserTournament = require("../../models/UserTournament");
const Tournament = require("../../models/Tournament");
const sequelize = require("../../config/database");
const setupAssociations = require("../../models/associations");
const teamUsage = require("../../services/teamUsage");
const leagueRecord = require("../../services/leagueRecord");
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

const ZERO = { official: 0, scrim: 0, scratch: 0, total: 0 };

const pickup = (over = {}) => ({
  id: "t1",
  owner_id: "u1",
  name: "T1",
  region: "na1",
  source: "manual",
  tournament_id: null,
  archived_at: null,
  Tournament: null,
  ...over,
});
const imported = (over = {}) => ({
  id: "e1",
  owner_id: null,
  name: "Esclub FC",
  region: "na1",
  source: "esclub",
  tournament_id: "tour-1",
  archived_at: null,
  Tournament: { id: "tour-1", name: "Spring", source: "esclub" },
  ...over,
});
const membership = (id, name, archivedAt = null) => ({
  tournament_id: id,
  archived_at: archivedAt,
  Tournament: { id, name, source: "esclub", region: "euw1" },
});

let counts;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(leagueRecord, "teamLeagueRecords").mockResolvedValue({});
  counts = vi.spyOn(teamUsage, "teamUseCounts").mockResolvedValue({});
});

describe("GET /manage scope (D2)", () => {
  it("ANDs visibleTeamsWhere with the owner branch only when there are no tournament rows", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    const findAll = vi.spyOn(Team, "findAll").mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.status).toBe(200);
    expect(findAll.mock.calls[0][0].where).toEqual({
      [Op.and]: [visibleTeamsWhere("u1"), { [Op.or]: [{ owner_id: "u1" }] }],
    });
  });

  it("adds tournament_id IN exactly the user's rows, archived ones included", async () => {
    const memberships = vi
      .spyOn(UserTournament, "findAll")
      .mockResolvedValue([
        membership("tour-1", "Spring"),
        membership("tour-2", "Fall", "2026-10-01T00:00:00.000Z"),
      ]);
    const findAll = vi.spyOn(Team, "findAll").mockResolvedValue([]);

    await request(buildApp()).get("/api/teams/manage");

    const where = memberships.mock.calls[0][0].where;
    expect(where).toEqual({ user_id: "u1" });
    expect(findAll.mock.calls[0][0].where).toEqual({
      [Op.and]: [
        visibleTeamsWhere("u1"),
        {
          [Op.or]: [
            { owner_id: "u1" },
            { tournament_id: { [Op.in]: ["tour-1", "tour-2"] } },
          ],
        },
      ],
    });
  });

  it("uses the same includes and name ordering as GET /", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    const findAll = vi.spyOn(Team, "findAll").mockResolvedValue([]);

    await request(buildApp()).get("/api/teams/manage");

    const options = findAll.mock.calls[0][0];
    expect(options.order[0]).toEqual(["name", "ASC"]);
    expect(options.include.map((i) => i.model.name)).toEqual([
      "TeamPlayer",
      "Tournament",
    ]);
    expect(options.include[1].attributes).toEqual(["id", "name", "source"]);
    expect(options.limit).toBeUndefined();
  });
});

describe("GET /manage response", () => {
  it("returns the caller's tournaments with their own archived_at, name-sorted by the query", async () => {
    const memberships = vi
      .spyOn(UserTournament, "findAll")
      .mockResolvedValue([
        membership("tour-1", "Spring"),
        membership("tour-2", "Fall", "2026-10-01T00:00:00.000Z"),
      ]);
    vi.spyOn(Team, "findAll").mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.body.tournaments).toEqual([
      {
        id: "tour-1",
        name: "Spring",
        source: "esclub",
        region: "euw1",
        archived_at: null,
      },
      {
        id: "tour-2",
        name: "Fall",
        source: "esclub",
        region: "euw1",
        archived_at: "2026-10-01T00:00:00.000Z",
      },
    ]);
    const options = memberships.mock.calls[0][0];
    expect(options.include).toHaveLength(1);
    expect(options.include[0].model).toBe(Tournament);
    expect(options.include[0].required).toBe(true);
    expect(options.order).toEqual([[Tournament, "name", "ASC"]]);
  });

  it("a league with no teams still appears", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([
      membership("tour-9", "Empty League"),
    ]);
    vi.spyOn(Team, "findAll").mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.body.teams).toEqual([]);
    expect(res.body.tournaments.map((t) => t.id)).toEqual(["tour-9"]);
  });

  it("calls teamUseCounts with exactly the returned team ids and the caller", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    vi.spyOn(Team, "findAll").mockResolvedValue([
      pickup({ id: "a" }),
      pickup({ id: "b" }),
      imported({ id: "c" }),
    ]);

    await request(buildApp()).get("/api/teams/manage?ids=zzz&teamIds[]=evil");

    expect(leagueRecord.teamLeagueRecords).toHaveBeenCalledExactlyOnceWith(["a", "b", "c"]);
    expect(counts).toHaveBeenCalledTimes(1);
    expect(counts.mock.calls[0][0]).toEqual(["a", "b", "c"]);
    expect(counts.mock.calls[0][1]).toBe("u1");
  });

  it("rows carry useCounts, canArchive, canDelete and canEditRoster", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    vi.spyOn(Team, "findAll").mockResolvedValue([
      pickup({ id: "p1" }),
      pickup({ id: "p2", archived_at: "2026-10-02T00:00:00.000Z" }),
      imported({ id: "i1" }),
    ]);
    vi.mocked(leagueRecord.teamLeagueRecords).mockResolvedValue({ i1: { series: { won: 5, lost: 1 }, games: { won: 11, lost: 4 } } });
    counts.mockResolvedValue({
      p1: { official: 4, scrim: 12, scratch: 1, total: 17 },
      i1: { official: 2, scrim: 0, scratch: 0, total: 2 },
    });

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.status).toBe(200);
    const [p1, p2, i1] = res.body.teams;
    expect(p1).toMatchObject({
      id: "p1",
      leagueRecord: null,
      useCounts: { official: 4, scrim: 12, scratch: 1, total: 17 },
      canArchive: true,
      canDelete: true,
      canEditRoster: true,
      Tournament: null,
    });
    expect(p2).toMatchObject({
      id: "p2",
      archived_at: "2026-10-02T00:00:00.000Z",
      useCounts: ZERO,
      canArchive: true,
      canDelete: true,
      canEditRoster: true,
    });
    expect(i1).toMatchObject({
      id: "i1",
      leagueRecord: { series: { won: 5, lost: 1 }, games: { won: 11, lost: 4 } },
      useCounts: { official: 2, scrim: 0, scratch: 0, total: 2 },
      canArchive: false,
      canDelete: false,
      canEditRoster: false,
      Tournament: { id: "tour-1", name: "Spring", source: "esclub" },
    });
  });

  it("an owned manual-tournament team can be edited but neither archived nor deleted", async () => {
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    vi.spyOn(Team, "findAll").mockResolvedValue([
      pickup({ id: "m1", tournament_id: "tour-m" }),
    ]);

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.body.teams[0]).toMatchObject({
      canArchive: false,
      canDelete: false,
      canEditRoster: true,
    });
  });

  it("is a 500 when the team query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    vi.spyOn(Team, "findAll").mockRejectedValue(new Error("db down"));

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to fetch teams" });
  });

  it("is a 500 when the use-count query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(UserTournament, "findAll").mockResolvedValue([]);
    vi.spyOn(Team, "findAll").mockResolvedValue([pickup()]);
    counts.mockRejectedValue(new Error("db down"));

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.status).toBe(500);
  });
});

// Renders the real SQL with sequelize.query stubbed (no connection), as in
// tests/services/teamAccess.test.js.
describe("GET /manage generated SQL", () => {
  it("is one flat query for teams (two includes, no LIMIT subquery) and one join for tournaments", async () => {
    expect(sequelize.getDialect()).toBe("postgres");
    setupAssociations();
    const authenticate = vi.spyOn(sequelize, "authenticate");
    // The stub bypasses Sequelize's row building, so give the rows the one
    // accessor the include walk calls.
    const row = (id, name, archivedAt) => {
      const plain = membership(id, name, archivedAt);
      return { ...plain, get: (key) => plain[key] };
    };
    const query = vi.spyOn(sequelize, "query").mockImplementation(async (sql) =>
      /FROM "UserTournaments"/.test(sql)
        ? [row("tour-1", "Spring", null), row("tour-2", "Fall", "2026-10-01")]
        : [],
    );

    const res = await request(buildApp()).get("/api/teams/manage");

    expect(res.status).toBe(200);
    expect(authenticate).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);

    const memberSql = query.mock.calls[0][0];
    expect(memberSql).toMatch(/FROM "UserTournaments" AS "UserTournament"/);
    expect(memberSql).toMatch(
      /INNER JOIN "Tournaments" AS "Tournament" ON "UserTournament"\."tournament_id" = "Tournament"\."id"/,
    );
    expect(memberSql).toMatch(/"UserTournament"\."user_id" = 'u1'/);
    expect(memberSql).not.toMatch(/archived_at" IS NULL/);
    expect(memberSql).toMatch(/ORDER BY "Tournament"\."name" ASC/);

    const sql = query.mock.calls[1][0];
    expect(sql).toMatch(/^SELECT .* FROM "Teams" AS "Team"/s);
    expect(sql).not.toMatch(/FROM \(SELECT/);
    expect(sql).not.toMatch(/LIMIT/);
    expect(sql).toMatch(/LEFT OUTER JOIN "TeamPlayers" AS "TeamPlayers"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "Tournaments" AS "Tournament"/);
    expect(sql).toMatch(/"Team"\."source" = 'esclub'/);
    expect(sql).toMatch(/"Team"\."owner_id" = 'u1'/);
    expect(sql).toMatch(/"Team"\."tournament_id" IN \('tour-1', 'tour-2'\)/);
    expect(sql).toMatch(/ORDER BY "Team"\."name" ASC, "TeamPlayers"\."ordinal" ASC/);
  });
});
