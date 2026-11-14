import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sequelize = require("../../../config/database");
const { injectReplacements } = require("sequelize/lib/utils/sql");
const { previewPurge, purgeTournament } = require("../../../services/esclub/purge");
const ID = "11111111-1111-4111-8111-111111111111";
const counts = { games: 4, series: 2, stages: 1, teamPlayers: 10, teams: 2, userTournaments: 3, tournaments: 1 };

afterEach(() => vi.restoreAllMocks());

function database({ missing = false, running = false, failAt = null } = {}) {
  const log = [];
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
    if (/^\s*DELETE/.test(sql)) return [[], { rowCount: 1 }];
    return missing ? [] : [{ id: ID, name: "Fixture league", ...counts }];
  });
  return { log, transaction, committed: () => committed, rolledBack: () => rolledBack };
}

describe("esclub purge SQL (no database)", () => {
  it("previews only counts scoped to one esclub tournament, without a transaction or delete", async () => {
    const db = database();
    expect(await previewPurge(ID)).toEqual({ tournament: { id: ID, name: "Fixture league" }, counts });
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(1);
    const sql = db.log[0].sql;
    expect(sql).toContain(`t.id = '${ID}'`);
    expect(sql).toContain("t.source = 'esclub'");
    for (const table of ["LeagueGames", "LeagueSeries", "LeagueStages", "TeamPlayers", "Teams", "UserTournaments"]) {
      expect(sql).toContain(`"${table}"`);
    }
    expect(sql).toMatch(/g.series_id IN \(SELECT id FROM "LeagueSeries" WHERE tournament_id =/);
    expect(sql).toMatch(/p.team_id IN \(SELECT id FROM "Teams" WHERE tournament_id =/);
    expect(sql).not.toMatch(/DELETE|UPDATE|participants|gameName|tagLine|playerKey/);
  });

  it("deletes games, series, stages, team players, teams and tournament in one transaction", async () => {
    const db = database();
    expect(await purgeTournament(ID)).toEqual({ tournament: { id: ID, name: "Fixture league" }, counts });
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(db.committed()).toBe(true);
    expect(db.log.every(({ options }) => options.transaction === db.transaction)).toBe(true);
    const deletes = db.log.filter(({ sql }) => sql.startsWith("DELETE"));
    expect(deletes.map(({ sql }) => /^DELETE FROM "([^"]+)"/.exec(sql)[1])).toEqual([
      "LeagueGames", "LeagueSeries", "LeagueStages", "TeamPlayers", "Teams", "Tournaments",
    ]);
    for (const { sql } of db.log.filter(({ sql }) => !sql.startsWith("LOCK"))) {
      expect(sql).toContain(`'${ID}'`);
    }
    expect(deletes[0].sql).toContain(`series_id IN (SELECT id FROM "LeagueSeries" WHERE tournament_id = '${ID}')`);
    expect(deletes[3].sql).toContain(`team_id IN (SELECT id FROM "Teams" WHERE tournament_id = '${ID}')`);
    for (const i of [1, 2, 4]) expect(deletes[i].sql).toContain(`WHERE tournament_id = '${ID}'`);
    expect(deletes[5].sql).toContain(`WHERE id = '${ID}' AND source = 'esclub'`);
    // UserTournaments cascade, canvas team links SET NULL, and sync-log FKs
    // SET NULL in the existing schema; none of those tables is deleted here.
    expect(deletes.some(({ sql }) => /EsclubSyncs|EsclubDailyUsage|Canvas|VersusDraft|UserTournaments/.test(sql))).toBe(false);
    expect(db.log.some(({ sql }) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(db.log[0].sql).toBe('LOCK TABLE "EsclubSyncs" IN SHARE ROW EXCLUSIVE MODE');
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
