import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sequelize = require("../../config/database");
const { QueryTypes } = require("sequelize");
const { teamLeagueRecords } = require("../../services/leagueRecord");
afterEach(() => vi.restoreAllMocks());
const zero = { series: { won: 0, lost: 0 }, games: { won: 0, lost: 0 } };
const game = (series_id, best_of, team_number, blue_side_team, winner) => ({
  team_id: "a", source: "esclub", series_id, best_of, team_number, blue_side_team, winner,
});
const stub = (rows) => vi.spyOn(sequelize, "query").mockResolvedValue(rows);

describe("teamLeagueRecords", () => {
  it("uses one parameterised query for all unique visible ids and passes the transaction", async () => {
    const spy = stub([]);
    const transaction = { id: "tx" };
    await teamLeagueRecords(["a", "b", "a"], { transaction });
    expect(spy).toHaveBeenCalledTimes(1);
    const [sql, options] = spy.mock.calls[0];
    expect(options).toEqual({ replacements: { teamIds: ["a", "b"] }, type: QueryTypes.SELECT, transaction });
    expect(sql).toContain("WHERE t.id IN (:teamIds)");
    expect(sql).toContain("s.team1_id = t.id OR s.team2_id = t.id");
    expect(sql).toContain("s.tournament_id = tournament.id");
    expect(sql).toContain("LEFT JOIN \"LeagueGames\"");
    expect(sql).not.toMatch(/status|complete/);
  });
  it("skips the query for empty input", async () => {
    const spy = stub([]);
    expect(await teamLeagueRecords([])).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
  it("returns null for non-league teams and zeros for an empty esclub tournament", async () => {
    stub([{ team_id: "a", source: "manual" }, { team_id: "b", source: "esclub", series_id: null }, { team_id: "c", source: null }]);
    expect(await teamLeagueRecords(["a", "b", "c"])).toEqual({ a: null, b: zero, c: null });
  });
  it("maps blue/red wins and losses in both slots across series; Bo1/3/5 require a majority", async () => {
    stub([
      game("bo1", 1, 1, 1, "blue"),
      game("bo3", 3, 2, 1, "red"), game("bo3", 3, 2, 2, "blue"), game("bo3", 3, 2, 1, "blue"),
      game("bo5", 5, 1, 1, "red"), game("bo5", 5, 1, 2, "blue"), game("bo5", 5, 1, 1, "red"),
    ]);
    expect((await teamLeagueRecords(["a"])).a).toEqual({ series: { won: 2, lost: 1 }, games: { won: 3, lost: 4 } });
  });
  it("does not decide tied or incomplete series and ignores null winners", async () => {
    stub([
      game("tie", 3, 1, 1, "blue"), game("tie", 3, 1, 2, "blue"), game("tie", 3, 1, 1, null),
      game("missing", 5, 2, 2, "blue"), game("missing", 5, 2, 1, "red"),
    ]);
    expect((await teamLeagueRecords(["a"])).a).toEqual({ series: { won: 0, lost: 0 }, games: { won: 3, lost: 1 } });
  });
  it("counts Bo5 wins and Bo1/Bo3 losses", async () => {
    stub([game("one", 1, 2, 2, "red"), game("three", 3, 1, 1, "red"), game("three", 3, 1, 2, "blue"),
      game("five", 5, 2, 1, "red"), game("five", 5, 2, 2, "blue"), game("five", 5, 2, 1, "red")]);
    expect((await teamLeagueRecords(["a"])).a).toEqual({ series: { won: 1, lost: 2 }, games: { won: 3, lost: 3 } });
  });
});
