import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sequelize = require("../../../config/database");
const { injectReplacements } = require("sequelize/lib/utils/sql");
const { previewPurge, purgeTournament } = require("../../../services/esclub/purge");
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const counts = { games: 4, series: 2, stages: 1, teamPlayers: 10, leaguePlayerNames: 3, teams: 2, userTournaments: 3, tournaments: 1 };

afterEach(() => vi.restoreAllMocks());

function database({ missing = false, running = false, failAt = null, crossStage = false } = {}) {
  const log = [];
  // FK-valid SA/SB/GB: B is manual, but its series references A's stage.
  const mirror = {
    tournaments: [{ id: ID, source: "esclub" }, { id: OTHER, source: "manual" }],
    stages: [{ id: "SA", tournament_id: ID }, { id: "SB-stage", tournament_id: OTHER }],
    series: [{ id: "SB", tournament_id: OTHER, stage_id: crossStage ? "SA" : "SB-stage" }],
    games: [{ id: "GB", series_id: "SB" }],
  };
  const transaction = { id: "purge-transaction" };
  let committed = false;
  let rolledBack = false;
  vi.spyOn(sequelize, "transaction").mockImplementation(async (work) => {
    try {
      const result = await work(transaction);
      committed = true;
      return result;
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  });
  vi.spyOn(sequelize, "query").mockImplementation(async (sql, options = {}) => {
    const rendered = injectReplacements(sql, sequelize.dialect, options.replacements ?? {});
    log.push({ sql: rendered.replace(/\s+/g, " ").trim(), options });
    if (failAt && sql.includes(`DELETE FROM "${failAt}"`)) throw new Error("delete failed");
    if (/^\s*LOCK/.test(sql)) return [];
    if (/FROM "EsclubSyncs"/.test(sql)) return running ? [{ id: "running-sync" }] : [];
    if (/FROM "LeagueSeries" s\s+JOIN "LeagueStages" st/.test(sql)) {
      return mirror.series.filter((series) => series.tournament_id !== options.replacements.tournamentId &&
        mirror.stages.some((stage) => stage.id === series.stage_id && stage.tournament_id === options.replacements.tournamentId));
    }
    if (/^\s*DELETE/.test(sql)) {
      if (sql.includes('DELETE FROM "LeagueStages"')) {
        // Model the stage -> series -> games cascade that the old mocks missed.
        const stages = mirror.stages.filter((stage) => stage.tournament_id === ID);
        mirror.stages = mirror.stages.filter((stage) => !stages.includes(stage));
        mirror.series = mirror.series.filter((series) => !stages.some((stage) => stage.id === series.stage_id));
        mirror.games = mirror.games.filter((game) => mirror.series.some((series) => series.id === game.series_id));
      }
      return [[], { rowCount: 1 }];
    }
    return missing ? [] : [{ id: ID, name: "Fixture league", ...counts }];
  });
  return { log, mirror, transaction, committed: () => committed, rolledBack: () => rolledBack };
}

describe("esclub purge SQL (no database)", () => {
  it("previews only counts scoped to one esclub tournament, without a transaction or delete", async () => {
    const db = database();
    expect(await previewPurge(ID)).toEqual({ tournament: { id: ID, name: "Fixture league" }, counts });
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(2);
    const sql = db.log[0].sql;
    expect(sql).toContain(`t.id = '${ID}'`);
    expect(sql).toContain("t.source = 'esclub'");
    for (const table of ["LeagueGames", "LeagueSeries", "LeagueStages", "TeamPlayers", "LeaguePlayerNames", "Teams", "UserTournaments"]) {
      expect(sql).toContain(`"${table}"`);
    }
    expect(sql).toMatch(/g.series_id IN \(SELECT id FROM "LeagueSeries" WHERE tournament_id =/);
    expect(sql).toMatch(/p.team_id IN \(SELECT id FROM "Teams" WHERE tournament_id =/);
    expect(sql).not.toMatch(/DELETE|UPDATE|participants|gameName|tagLine|playerKey/);
  });

  it.each([previewPurge, purgeTournament])("rejects the SA/SB/GB cross-tournament stage cascade in preview and purge (%#)", async (work) => {
    const db = database({ crossStage: true });
    const before = structuredClone(db.mirror);
    await expect(work(ID)).rejects.toMatchObject({
      name: "EsclubPurgeStageConflict",
      message: expect.stringMatching(/another tournament.*series.*stages/i),
    });
    expect(db.log.some(({ sql }) => sql.startsWith("DELETE"))).toBe(false);
    expect(db.mirror).toEqual(before);
    const check = db.log.find(({ sql }) => sql.includes('JOIN "LeagueStages" st'));
    expect(check.sql).toBe(`SELECT s.id FROM "LeagueSeries" s JOIN "LeagueStages" st ON st.id = s.stage_id WHERE st.tournament_id = '${ID}' AND s.tournament_id <> '${ID}' LIMIT 1`);
    expect(check.sql).not.toMatch(/source|participants|playerKey/);
    if (work === purgeTournament) {
      expect(check.options.transaction).toBe(db.transaction);
      expect(db.committed()).toBe(false);
      expect(db.rolledBack()).toBe(true);
    } else {
      expect(sequelize.transaction).not.toHaveBeenCalled();
    }
  });

  it("deletes games, series, stages, team players, teams and tournament in one transaction", async () => {
    const db = database();
    expect(await purgeTournament(ID)).toEqual({ tournament: { id: ID, name: "Fixture league" }, counts });
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(db.committed()).toBe(true);
    expect(db.log.every(({ options }) => options.transaction === db.transaction)).toBe(true);
    const deletes = db.log.filter(({ sql }) => sql.startsWith("DELETE"));
    expect(deletes.map(({ sql }) => /^DELETE FROM "([^"]+)"/.exec(sql)[1])).toEqual([
      "LeagueGames", "LeagueSeries", "LeagueStages", "TeamPlayers", "LeaguePlayerNames", "Teams", "Tournaments",
    ]);
    for (const { sql } of db.log.filter(({ sql }) => !sql.startsWith("LOCK"))) {
      expect(sql).toContain(`'${ID}'`);
    }
    expect(deletes[0].sql).toContain(`series_id IN (SELECT id FROM "LeagueSeries" WHERE tournament_id = '${ID}')`);
    expect(deletes[3].sql).toContain(`team_id IN (SELECT id FROM "Teams" WHERE tournament_id = '${ID}')`);
    for (const i of [1, 2, 4, 5]) expect(deletes[i].sql).toContain(`WHERE tournament_id = '${ID}'`);
    expect(deletes[6].sql).toContain(`WHERE id = '${ID}' AND source = 'esclub'`);
    // UserTournaments cascade, canvas team links SET NULL, and sync-log FKs
    // SET NULL in the existing schema; none of those tables is deleted here.
    expect(deletes.some(({ sql }) => /EsclubSyncs|EsclubDailyUsage|Canvas|VersusDraft|UserTournaments/.test(sql))).toBe(false);
    expect(db.log.some(({ sql }) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(db.log[0].sql).toBe('LOCK TABLE "EsclubSyncs" IN SHARE ROW EXCLUSIVE MODE');
    const stageLock = db.log.findIndex(({ sql }) => sql === `SELECT id FROM "LeagueStages" WHERE tournament_id = '${ID}' FOR UPDATE`);
    const conflictCheck = db.log.findIndex(({ sql }) => sql.includes('JOIN "LeagueStages" st'));
    const firstDelete = db.log.findIndex(({ sql }) => sql.startsWith("DELETE"));
    expect(stageLock).toBeGreaterThan(0);
    expect(conflictCheck).toBeGreaterThan(stageLock);
    expect(firstDelete).toBeGreaterThan(conflictCheck);
    expect(db.mirror.series).toContainEqual({ id: "SB", tournament_id: OTHER, stage_id: "SB-stage" });
    expect(db.mirror.games).toContainEqual({ id: "GB", series_id: "SB" });
  });

  it("rolls back the entire purge when a delete fails", async () => {
    const db = database({ failAt: "Teams" });
    await expect(purgeTournament(ID)).rejects.toThrow("delete failed");
    expect(db.committed()).toBe(false);
    expect(db.rolledBack()).toBe(true);
    expect(db.log.some(({ sql }) => sql.startsWith('DELETE FROM "Tournaments"'))).toBe(false);
  });

  it("refuses to purge while this tournament or an unlocated add is syncing", async () => {
    const db = database({ running: true });
    await expect(purgeTournament(ID)).rejects.toThrow(/sync.*running/i);
    expect(db.log.some(({ sql }) => sql.startsWith("DELETE"))).toBe(false);
    const check = db.log.find(({ sql }) => sql.includes('FROM "EsclubSyncs"')).sql;
    expect(check).toContain("status = 'running'");
    expect(check).toContain(`tournament_id = '${ID}'`);
    expect(check).toContain("tournament_id IS NULL");
  });

  it.each([previewPurge, purgeTournament])("rejects a missing or manual tournament without deletes", async (work) => {
    const db = database({ missing: true });
    await expect(work(ID)).rejects.toThrow(/esclub tournament.*not found/i);
    expect(db.log.some(({ sql }) => sql.startsWith("DELETE"))).toBe(false);
    expect(db.log.find(({ sql }) => sql.includes('FROM "Tournaments"')).sql).toContain("source = 'esclub'");
  });

  it.each([null, "", "not-an-id", "x'; DELETE FROM Teams; --"])("rejects invalid id %j before querying", async (id) => {
    const db = database();
    await expect(previewPurge(id)).rejects.toThrow(/UUID/);
    await expect(purgeTournament(id)).rejects.toThrow(/UUID/);
    expect(db.log).toHaveLength(0);
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });
});
