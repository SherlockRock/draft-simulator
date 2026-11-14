import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CanvasGroup } = require("../../models/Canvas");
const Tournament = require("../../models/Tournament");
const sequelize = require("../../config/database");
const setupAssociations = require("../../models/associations");
const { TEAM_INCLUDE } = require("../../routes/canvasProjections");

beforeAll(() => setupAssociations());
afterEach(() => vi.restoreAllMocks());

const TOURNAMENT_ATTRIBUTES = ["id", "name", "source"];

describe("TEAM_INCLUDE", () => {
  it.each(["Team1", "Team2"])(
    "loads Tournament with exactly id, name, source under %s",
    (alias) => {
      const teamInclude = TEAM_INCLUDE.find((i) => i.as === alias);
      expect(teamInclude).toBeDefined();
      const tournamentInclude = teamInclude.include.find(
        (i) => i.model === Tournament,
      );
      expect(tournamentInclude).toBeDefined();
      expect(tournamentInclude.attributes).toEqual(TOURNAMENT_ATTRIBUTES);
      // A pickup team has no tournament: the join must stay a LEFT join.
      expect(tournamentInclude.required).not.toBe(true);
    },
  );

  it("keeps the rosters", () => {
    for (const alias of ["Team1", "Team2"]) {
      const teamInclude = TEAM_INCLUDE.find((i) => i.as === alias);
      expect(teamInclude.include.some((i) => i.as === "TeamPlayers")).toBe(
        true,
      );
    }
  });

  // Renders the real SQL with sequelize.query stubbed: no connection opens.
  describe("generated SQL", () => {
    const tournamentColumns = (sql, alias) => {
      const re = new RegExp(`"${alias}->Tournament"\\."(\\w+)"`, "g");
      return [...new Set([...sql.matchAll(re)].map((m) => m[1]))].sort();
    };

    const assertTournamentJoin = (sql) => {
      expect(sql).toMatch(
        /LEFT OUTER JOIN "Tournaments" AS "Team1->Tournament" ON/,
      );
      expect(sql).toMatch(
        /LEFT OUTER JOIN "Tournaments" AS "Team2->Tournament" ON/,
      );
      expect(tournamentColumns(sql, "Team1")).toEqual(["id", "name", "source"]);
      expect(tournamentColumns(sql, "Team2")).toEqual(["id", "name", "source"]);
    };

    it("snapshot group query joins Tournament with only three columns", async () => {
      const query = vi.spyOn(sequelize, "query").mockResolvedValue([]);
      await CanvasGroup.findAll({
        where: { canvas_id: "canvas-1" },
        include: TEAM_INCLUDE,
      });
      expect(query).toHaveBeenCalledTimes(1);
      const sql = query.mock.calls[0][0];
      expect(typeof sql).toBe("string");
      assertTournamentJoin(sql);
    });

    it("single-group findOne reload has no LIMIT subquery missing a column", async () => {
      const query = vi.spyOn(sequelize, "query").mockResolvedValue(null);
      // Same options as routes/canvas.js:424-426 style reloads.
      await CanvasGroup.findOne({
        where: { id: "group-1" },
        include: TEAM_INCLUDE,
      });
      expect(query).toHaveBeenCalledTimes(1);
      const sql = query.mock.calls[0][0];
      assertTournamentJoin(sql);
      // One flat query: every include is belongsTo or hasMany-without-limit
      // here, so Sequelize must not wrap CanvasGroups in a LIMIT subquery
      // (the T1 lesson: such a subquery can omit columns the joins need).
      expect(sql).not.toMatch(/FROM \(SELECT/);
    });

    it("single-group findOne inside a transaction renders the same shape", async () => {
      const query = vi.spyOn(sequelize, "query").mockResolvedValue(null);
      await CanvasGroup.findOne({
        where: { id: "group-1" },
        include: TEAM_INCLUDE,
        transaction: { id: "tx" },
      });
      const sql = query.mock.calls[0][0];
      assertTournamentJoin(sql);
    });
  });
});
