import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { createRequire } from "node:module";

/**
 * S3 Task 3 (D8): `CanvasGroup.LeagueImport` on the canvas payload.
 *
 * The group query reaches the mirror through VersusDraft → LeagueSeries →
 * LeagueStage, LEFT joins only and public columns only; `projectGroup` turns
 * the raw rows into the `LeagueImport` view so they never reach a client.
 */

const require = createRequire(import.meta.url);
const sequelize = require("../../config/database");
const setupAssociations = require("../../models/associations");
const {
  Canvas,
  CanvasDraft,
  CanvasGroup,
  CanvasConnection,
  CanvasAnnotation,
  CanvasPoolPlacement,
} = require("../../models/Canvas");
const {
  GROUP_INCLUDE,
  TEAM_INCLUDE,
  buildCanvasSnapshot,
  projectGroup,
} = require("../../routes/canvasProjections");

beforeAll(() => setupAssociations());
afterEach(() => vi.restoreAllMocks());

const SERIES_ID = "11111111-1111-4111-8111-111111111111";
const TOURNAMENT_ID = "22222222-2222-4222-8222-222222222222";

// The columns a SELECT reads from one include alias, e.g. "VersusDraft".
const columnsOf = (sql, alias) => {
  const escaped = alias.replace(/[-[\]{}()*+?.,\\^$|#\s>]/g, "\\$&");
  const re = new RegExp(`"${escaped}"\\."(\\w+)" AS `, "g");
  return [...new Set([...sql.matchAll(re)].map((m) => m[1]))].sort();
};

const assertLeagueJoins = (sql) => {
  expect(sql).toMatch(/LEFT OUTER JOIN "VersusDrafts" AS "VersusDraft" ON/);
  expect(sql).toMatch(
    /LEFT OUTER JOIN "LeagueSeries" AS "VersusDraft->LeagueSeries" ON/,
  );
  expect(sql).toMatch(
    /LEFT OUTER JOIN "LeagueStages" AS "VersusDraft->LeagueSeries->Stage" ON/,
  );
  expect(sql).not.toMatch(/INNER JOIN/);
  expect(columnsOf(sql, "VersusDraft")).toEqual(["id", "league_series_id"]);
  expect(columnsOf(sql, "VersusDraft->LeagueSeries")).toEqual(
    [
      "complete",
      "external_id",
      "id",
      "starts_at",
      "status",
      "tournament_id",
    ].sort(),
  );
  // Sequelize adds the primary key of an include; the stage is public.
  for (const column of columnsOf(sql, "VersusDraft->LeagueSeries->Stage")) {
    expect(["id", "name"]).toContain(column);
  }
  expect(columnsOf(sql, "VersusDraft->LeagueSeries->Stage")).toContain("name");
  // No game rows, no participant data, no roster ids of the series.
  expect(sql).not.toMatch(/LeagueGames/);
  expect(sql).not.toMatch(/participants/i);
  expect(sql).not.toMatch(/playerKey|id_oauth_riot/);
  expect(sql).not.toMatch(/"VersusDraft->LeagueSeries"\."team[12]_id"/);
  // The team joins are still there.
  expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team1" ON/);
  expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team2" ON/);
};

describe("GROUP_INCLUDE", () => {
  it("is TEAM_INCLUDE plus one LEFT VersusDraft include", () => {
    expect(GROUP_INCLUDE.slice(0, TEAM_INCLUDE.length)).toEqual(TEAM_INCLUDE);
    expect(GROUP_INCLUDE).toHaveLength(TEAM_INCLUDE.length + 1);
    const versus = GROUP_INCLUDE[TEAM_INCLUDE.length];
    expect(versus.required).toBe(false);
    expect(versus.include[0].required).toBe(false);
    expect(versus.include[0].include[0].required).toBe(false);
  });

  // Renders the real SQL with sequelize.query stubbed: no connection opens.
  it("the snapshot's group query joins the mirror with only D8's columns", async () => {
    vi.spyOn(Canvas, "findByPk").mockResolvedValue(null);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
    const query = vi.spyOn(sequelize, "query").mockResolvedValue([]);

    await buildCanvasSnapshot("canvas-1");

    const groupSql = query.mock.calls
      .map((call) => call[0])
      .filter((sql) => typeof sql === "string" && /FROM "CanvasGroups"/.test(sql));
    expect(groupSql).toHaveLength(1);
    assertLeagueJoins(groupSql[0]);
  });

  it("a single-group reload renders one flat query with the same joins", async () => {
    const query = vi.spyOn(sequelize, "query").mockResolvedValue(null);
    await CanvasGroup.findOne({
      where: { id: "group-1" },
      include: GROUP_INCLUDE,
      transaction: { id: "tx" },
    });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    assertLeagueJoins(sql);
    expect(sql).not.toMatch(/FROM \(SELECT/);
  });
});

const baseGroup = () => ({
  id: "g-1",
  canvas_id: "c-1",
  name: "Series",
  type: "series",
  positionX: 0,
  positionY: 0,
  versus_draft_id: "vd-1",
  metadata: {},
  Team1: null,
  Team2: null,
});

const importedSeries = () => ({
  id: SERIES_ID,
  external_id: "9876",
  tournament_id: TOURNAMENT_ID,
  starts_at: new Date("2026-11-11T18:00:00.000Z"),
  status: "in_progress",
  complete: false,
  Stage: { id: "stage-1", name: "Regular Season" },
});

describe("projectGroup", () => {
  it("gives a manual group (no VersusDraft) LeagueImport: null", () => {
    const out = projectGroup({ ...baseGroup(), versus_draft_id: null });
    expect(out.LeagueImport).toBeNull();
    expect(out).not.toHaveProperty("VersusDraft");
    expect(out.name).toBe("Series");
  });

  it("gives a manual series (VersusDraft without league_series_id) null", () => {
    const out = projectGroup({
      ...baseGroup(),
      VersusDraft: { id: "vd-1", league_series_id: null, LeagueSeries: null },
    });
    expect(out.LeagueImport).toBeNull();
    expect(out).not.toHaveProperty("VersusDraft");
  });

  it("gives an imported group the LeagueImport view", () => {
    const out = projectGroup({
      ...baseGroup(),
      VersusDraft: {
        id: "vd-1",
        league_series_id: SERIES_ID,
        LeagueSeries: importedSeries(),
      },
    });
    expect(out.LeagueImport).toEqual({
      leagueSeriesId: SERIES_ID,
      tournamentId: TOURNAMENT_ID,
      stageName: "Regular Season",
      startsAt: "2026-11-11T18:00:00.000Z",
      status: "in_progress",
      complete: false,
      esclubUrl: "https://esclub.gg/serie/9876",
    });
    expect(out).not.toHaveProperty("VersusDraft");
    expect(out.id).toBe("g-1");
  });

  it("keeps startsAt and stageName null when the mirror has none", () => {
    const out = projectGroup({
      ...baseGroup(),
      VersusDraft: {
        id: "vd-1",
        league_series_id: SERIES_ID,
        LeagueSeries: { ...importedSeries(), starts_at: null, Stage: null },
      },
    });
    expect(out.LeagueImport.startsAt).toBeNull();
    expect(out.LeagueImport.stageName).toBeNull();
  });

  it("gives a purged group (league_series_id set to NULL) null", () => {
    const out = projectGroup({
      ...baseGroup(),
      VersusDraft: { id: "vd-1", league_series_id: null, LeagueSeries: null },
    });
    expect(out.LeagueImport).toBeNull();
  });

  it("gives null when the series row is missing despite the id", () => {
    const out = projectGroup({
      ...baseGroup(),
      VersusDraft: { id: "vd-1", league_series_id: SERIES_ID, LeagueSeries: null },
    });
    expect(out.LeagueImport).toBeNull();
  });

  it("reads a model instance through toJSON", () => {
    const json = {
      ...baseGroup(),
      VersusDraft: {
        id: "vd-1",
        league_series_id: SERIES_ID,
        LeagueSeries: importedSeries(),
      },
    };
    const out = projectGroup({ toJSON: () => json });
    expect(out.LeagueImport.leagueSeriesId).toBe(SERIES_ID);
    expect(out).not.toHaveProperty("VersusDraft");
    expect(out).not.toHaveProperty("toJSON");
  });

  it("the snapshot projects every group", async () => {
    vi.spyOn(Canvas, "findByPk").mockResolvedValue(null);
    vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
    vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
    const findAll = vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([
      {
        toJSON: () => ({
          ...baseGroup(),
          VersusDraft: {
            id: "vd-1",
            league_series_id: SERIES_ID,
            LeagueSeries: importedSeries(),
          },
        }),
      },
      { toJSON: () => ({ ...baseGroup(), id: "g-2", versus_draft_id: null, VersusDraft: null }) },
    ]);

    const payload = await buildCanvasSnapshot("c-1");

    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ include: GROUP_INCLUDE }),
    );
    expect(payload.groups[0].LeagueImport.leagueSeriesId).toBe(SERIES_ID);
    expect(payload.groups[1].LeagueImport).toBeNull();
    for (const group of payload.groups) {
      expect(group).not.toHaveProperty("VersusDraft");
    }
  });
});
