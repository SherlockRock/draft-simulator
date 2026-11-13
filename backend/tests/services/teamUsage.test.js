import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sequelize = require("../../config/database");
const { QueryTypes } = require("sequelize");
const { teamUseCounts } = require("../../services/teamUsage");

afterEach(() => vi.restoreAllMocks());

const stubQuery = (rows = []) =>
  vi.spyOn(sequelize, "query").mockResolvedValue(rows);

const captured = async (...args) => {
  const spy = stubQuery();
  await teamUseCounts(...args);
  expect(spy).toHaveBeenCalledTimes(1);
  const [sql, options] = spy.mock.calls[0];
  return { sql: sql.replace(/\s+/g, " "), options };
};

describe("teamUseCounts SQL", () => {
  it("is one parameterised SELECT: replacements, never string-built ids", async () => {
    const { sql, options } = await captured(["team-a", "team-b"], "user-1");
    expect(options.type).toBe(QueryTypes.SELECT);
    expect(options.replacements).toEqual({
      userId: "user-1",
      teamIds: ["team-a", "team-b"],
    });
    expect(sql).toContain(":userId");
    expect(sql).toContain("IN (:teamIds)");
    expect(sql).not.toContain("team-a");
    expect(sql).not.toContain("user-1");
  });

  it("passes the transaction through", async () => {
    const transaction = { id: "tx" };
    const { options } = await captured(["team-a"], "user-1", { transaction });
    expect(options.transaction).toBe(transaction);
  });

  it("restricts to canvases the user is a member of", async () => {
    const { sql } = await captured(["team-a"], "user-1");
    expect(sql).toContain('FROM "CanvasGroups"');
    expect(sql).toMatch(
      /JOIN "UserCanvases" \w+ ON \w+\.canvas_id = \w+\.canvas_id AND \w+\.user_id = :userId/
    );
  });

  it("reads both team slots and keeps one row per group per team", async () => {
    const { sql } = await captured(["team-a"], "user-1");
    expect(sql).toContain("team1_id AS team_id");
    expect(sql).toContain("team2_id AS team_id");
    // UNION (not UNION ALL) so a group linking one team twice is one row.
    expect(sql).toMatch(/\bUNION\b(?! ALL)/);
    expect(sql).toContain("team1_id IN (:teamIds)");
    expect(sql).toContain("team2_id IN (:teamIds)");
  });

  it("counts DISTINCT group ids per team, per type and in total", async () => {
    const { sql } = await captured(["team-a"], "user-1");
    expect(sql).toContain("GROUP BY team_id");
    expect(sql).toMatch(/COUNT\(DISTINCT group_id\) AS total/);
    for (const type of ["official", "scrim", "scratch"]) {
      expect(sql).toContain(
        `COUNT(DISTINCT group_id) FILTER (WHERE game_type = '${type}') AS ${type}`
      );
    }
  });

  it("buckets the game type: stored tag, else an untagged series is a scrim", async () => {
    const { sql } = await captured(["team-a"], "user-1");
    expect(sql).toContain("metadata->>'gameType' IN ('official', 'scrim', 'scratch')");
    expect(sql).toContain("THEN g.metadata->>'gameType'");
    expect(sql).toContain("WHEN g.type = 'series' THEN 'scrim'");
  });

  it("runs no query without teams or without a user", async () => {
    const spy = stubQuery();
    expect(await teamUseCounts([], "user-1")).toEqual({});
    expect(await teamUseCounts(["team-a"], null)).toEqual({});
    expect(await teamUseCounts(["team-a"], undefined)).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it("de-duplicates input ids", async () => {
    const { options } = await captured(["team-a", "team-b", "team-a"], "user-1");
    expect(options.replacements.teamIds).toEqual(["team-a", "team-b"]);
  });
});

describe("teamUseCounts row mapping", () => {
  it("converts string counts to numbers", async () => {
    stubQuery([
      { team_id: "team-a", official: "2", scrim: "3", scratch: "1", total: "7" },
    ]);
    expect(await teamUseCounts(["team-a"], "user-1")).toEqual({
      "team-a": { official: 2, scrim: 3, scratch: 1, total: 7 },
    });
  });

  it("gives ids absent from the result all zeros", async () => {
    stubQuery([
      { team_id: "team-a", official: "1", scrim: "0", scratch: "0", total: "1" },
    ]);
    expect(await teamUseCounts(["team-a", "team-b"], "user-1")).toEqual({
      "team-a": { official: 1, scrim: 0, scratch: 0, total: 1 },
      "team-b": { official: 0, scrim: 0, scratch: 0, total: 0 },
    });
  });

  it("keeps untagged custom groups in total only", async () => {
    stubQuery([
      { team_id: "team-a", official: "0", scrim: "0", scratch: "0", total: "2" },
    ]);
    expect((await teamUseCounts(["team-a"], "user-1"))["team-a"]).toEqual({
      official: 0,
      scrim: 0,
      scratch: 0,
      total: 2,
    });
  });

  it("ignores rows for ids that were not asked for", async () => {
    stubQuery([
      { team_id: "other", official: "9", scrim: "9", scratch: "9", total: "9" },
    ]);
    expect(await teamUseCounts(["team-a"], "user-1")).toEqual({
      "team-a": { official: 0, scrim: 0, scratch: 0, total: 0 },
    });
  });
});
// "A group with the same team in both slots counts once" is a property of the
// SQL (UNION + COUNT(DISTINCT group_id)), not of the JS mapping, so it is
// pinned in the SQL tests above rather than in a row-mapping test.
