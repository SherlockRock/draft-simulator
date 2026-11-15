import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire, Module } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { parseArgs, runCli, createServices } = require("../../scripts/esclub");
const sequelize = require("../../config/database");
const { injectReplacements } = require("sequelize/lib/utils/sql");
const { limitsFromEnv } = require("../../services/esclub/syncState");
const ID = "11111111-1111-4111-8111-111111111111";
const SERIES = "22222222-2222-4222-8222-222222222222";
const URL = `https://esclub.gg/multimedia/serie/${SERIES}/draft?match_number=1`;
const NOW = new Date("2026-11-14T12:00:00.000Z");
const ON = { ESCLUB_SYNC_ENABLED: "true", ESCLUB_DAILY_REQUEST_BUDGET: "30", ESCLUB_SYNC_MAX_REQUESTS: "5" };
afterEach(() => vi.restoreAllMocks());

function fixture(env = ON) {
  const output = { log: vi.fn(), error: vi.fn() };
  const sync = { id: "sync-id", kind: "league", status: "running" };
  const services = {
    limitsFromEnv,
    usageToday: vi.fn().mockResolvedValue({ day: "2026-11-14", used: 7, budget: 30 }),
    readRunning: vi.fn().mockResolvedValue(null),
    listTournaments: vi.fn().mockResolvedValue([{ id: ID, name: "Fixture league", last_synced_at: "2026-11-14T10:00:00Z", last_sync_status: "failed" }]),
    findTournament: vi.fn().mockResolvedValue({ id: ID }),
    findSerie: vi.fn().mockResolvedValue({ id: SERIES, tournament_id: ID, stage_id: "stage-id" }),
    beginSync: vi.fn().mockResolvedValue({ sync }),
    getSync: vi.fn().mockResolvedValue({ ...sync, status: "succeeded", request_count: 2 }),
    markStale: vi.fn().mockResolvedValue(1),
    addLeague: vi.fn().mockResolvedValue({ known: { tournamentId: ID } }),
    runSync: vi.fn().mockImplementation(async (_row, work) => {
      await work({ stubClient: true }, { gamesWritten: 2 });
      return { status: "succeeded", summary: { gamesWritten: 2 } };
    }),
    syncTournament: vi.fn(),
    syncSerie: vi.fn(),
    previewPurge: vi.fn().mockResolvedValue({ tournament: { id: ID, name: "Fixture league" }, counts: { games: 4, series: 2, stages: 1, teamPlayers: 10, teams: 2, userTournaments: 3, tournaments: 1 } }),
    purgeTournament: vi.fn().mockResolvedValue({ counts: { games: 4 } }),
  };
  return { services, output, run: (args) => runCli(args, { env, services, output, now: () => NOW }) };
}

describe("esclub CLI arguments", () => {
  it.each(["status", "list", "unlock"])("parses %s", (command) => {
    expect(parseArgs([command])).toEqual({ command });
  });
  it("parses add and its optional region", () => {
    expect(parseArgs(["add", URL])).toEqual({ command: "add", url: URL, region: "na1" });
    expect(parseArgs(["add", URL, "--region", "euw1"])).toEqual({ command: "add", url: URL, region: "euw1" });
  });
  it.each(["refresh", "refresh-serie", "purge"])("parses %s and a local UUID", (command) => {
    expect(parseArgs([command, ID])).toEqual({ command, id: ID, ...(command === "purge" ? { yes: false } : {}) });
  });
  it("parses explicit purge confirmation", () => {
    expect(parseArgs(["purge", ID, "--yes"])).toEqual({ command: "purge", id: ID, yes: true });
  });
  it.each([
    [], ["what"], ["status", "extra"], ["list", "--yes"], ["unlock", "extra"],
    ["add"], ["add", "https://elsewhere.invalid/serie/x"], ["add", URL, "--region"],
    ["add", URL, "--region", "invalid"], ["add", URL, "--yes"], ["add", URL, "extra"],
    ["refresh"], ["refresh", "not-a-uuid"], ["refresh", ID, "--yes"],
    ["refresh-serie", ID, "extra"], ["purge", ID, "--no"], ["purge", ID, "--yes", "--yes"],
  ])("rejects bad arguments %j before calling services", async (args) => {
    expect(() => parseArgs(args)).toThrow();
    const f = fixture();
    expect(await f.run(args)).toBe(2);
    expect(f.output.error).toHaveBeenCalled();
    for (const service of Object.values(f.services).filter(vi.isMockFunction)) expect(service).not.toHaveBeenCalled();
  });
});

describe("esclub CLI commands", () => {
  it("previews purge without deleting, even while sync is off", async () => {
    const f = fixture({});
    expect(await f.run(["purge", ID])).toBe(0);
    expect(f.services.previewPurge).toHaveBeenCalledWith(ID);
    expect(f.services.purgeTournament).not.toHaveBeenCalled();
    expect(f.output.log.mock.calls.flat().join(" ")).toMatch(/games.*4/);
    expect(f.output.log.mock.calls.flat().join(" ")).toContain("--yes");
  });
  it("prints the plan before deleting only with --yes", async () => {
    const f = fixture();
    expect(await f.run(["purge", ID, "--yes"])).toBe(0);
    expect(f.services.purgeTournament).toHaveBeenCalledWith(ID);
    expect(f.output.log.mock.invocationCallOrder[0]).toBeLessThan(f.services.purgeTournament.mock.invocationCallOrder[0]);
  });
  it.each([undefined, "false", "TRUE", "1"])("refuses sync commands when switch is %j", async (value) => {
    for (const args of [["add", URL], ["refresh", ID], ["refresh-serie", SERIES]]) {
      const f = fixture({ ESCLUB_SYNC_ENABLED: value });
      expect(await f.run(args)).toBe(1);
      expect(f.output.error.mock.calls.flat().join(" ")).toMatch(/sync is off/);
      for (const service of Object.values(f.services).filter(vi.isMockFunction)) expect(service).not.toHaveBeenCalled();
    }
  });
  it("adds synchronously as the CLI without a user and passes the injected env", async () => {
    const f = fixture();
    expect(await f.run(["add", URL, "--region", "euw1"])).toBe(0);
    expect(f.services.addLeague).toHaveBeenCalledWith({ url: URL, region: "euw1", via: "cli", userId: null, background: false, env: ON, now: expect.any(Function) });
  });
  it.each(["refresh", "refresh-serie"])("runs %s through beginSync and the counted engine", async (command) => {
    const f = fixture();
    const serie = command === "refresh-serie";
    expect(await f.run([command, serie ? SERIES : ID])).toBe(0);
    expect(f.services.beginSync).toHaveBeenCalledWith({ kind: serie ? "serie" : "league", tournamentId: ID, ...(serie ? { seriesId: SERIES, stageId: "stage-id" } : {}), via: "cli", userId: null, now: NOW, env: ON });
    expect(f.services.runSync).toHaveBeenCalledWith(expect.objectContaining({ id: "sync-id" }), expect.any(Function), { env: ON, now: expect.any(Function) });
    expect(serie ? f.services.syncSerie : f.services.syncTournament).toHaveBeenCalledWith({ stubClient: true }, { ...(serie ? { seriesId: SERIES } : { tournamentId: ID }), summary: { gamesWritten: 2 } });
    expect(f.services.getSync).toHaveBeenCalledWith("sync-id");
  });
  it.each([{ off: "budget" }, { busy: { retryAfter: 60 } }, { limited: { retryAfter: 60 } }])("does not run after refusal %j", async (answer) => {
    const f = fixture();
    f.services.beginSync.mockResolvedValue(answer);
    expect(await f.run(["refresh", ID])).toBe(1);
    expect(f.services.runSync).not.toHaveBeenCalled();
  });
  it("joins an existing sync without starting another session", async () => {
    const f = fixture();
    f.services.beginSync.mockResolvedValue({ joined: { id: "existing" } });
    expect(await f.run(["refresh", ID])).toBe(0);
    expect(f.services.runSync).not.toHaveBeenCalled();
  });
  it.each(["EsclubBudgetExhausted", "EsclubRequestCapReached"])("reports %s with a failing exit code", async (name) => {
    const f = fixture();
    f.services.runSync.mockResolvedValue({ status: "failed", error: { name }, summary: {} });
    expect(await f.run(["refresh", ID])).toBe(1);
    expect(f.output.error.mock.calls.flat().join(" ")).toContain(name);
  });
  it("reports failed add and invalid-service responses", async () => {
    for (const result of [{ sync: { id: "s" }, result: { status: "failed", error: { name: "EsclubRequestCapReached" } } }, { invalid: "URL" }, { off: "budget" }]) {
      const f = fixture();
      f.services.addLeague.mockResolvedValue(result);
      expect(await f.run(["add", URL])).toBe(1);
    }
  });
  it.each(["refresh", "refresh-serie"])("refuses missing/manual target for %s", async (command) => {
    const f = fixture();
    f.services.findTournament.mockResolvedValue(null);
    f.services.findSerie.mockResolvedValue(null);
    expect(await f.run([command, ID])).toBe(1);
    expect(f.services.beginSync).not.toHaveBeenCalled();
  });
  it("shows switch, UTC budget used/left, cap, running sync and tournament last syncs", async () => {
    const f = fixture();
    f.services.readRunning.mockResolvedValue({ id: "running-id", request_count: 3 });
    expect(await f.run(["status"])).toBe(0);
    const status = JSON.parse(f.output.log.mock.calls[0][0]);
    expect(status).toMatchObject({ syncEnabled: true, day: "2026-11-14", used: 7, left: 23, budget: 30, cap: 5, running: { id: "running-id" }, tournaments: [{ id: ID, last_sync_status: "failed" }] });
    expect(f.services.usageToday).toHaveBeenCalledWith({ now: NOW, env: ON });
  });
  it("status is readable when disabled and clamps budget left at zero", async () => {
    const f = fixture({});
    f.services.usageToday.mockResolvedValue({ used: 2001, budget: 2000 });
    expect(await f.run(["status"])).toBe(0);
    expect(JSON.parse(f.output.log.mock.calls[0][0])).toMatchObject({ syncEnabled: false, left: 0 });
  });
  it("lists tournament counts without a session", async () => {
    const f = fixture({});
    expect(await f.run(["list"])).toBe(0);
    expect(f.services.listTournaments).toHaveBeenCalledTimes(1);
    expect(f.services.beginSync).not.toHaveBeenCalled();
  });
  it("unlock marks only stale rows through the existing service", async () => {
    const f = fixture({});
    expect(await f.run(["unlock"])).toBe(0);
    expect(f.services.markStale).toHaveBeenCalledWith(NOW);
    expect(f.services.beginSync).not.toHaveBeenCalled();
  });
  it("catches service failures without printing raw error messages", async () => {
    const f = fixture();
    f.services.previewPurge.mockRejectedValue(new Error("private payload"));
    expect(await f.run(["purge", ID])).toBe(1);
    expect(f.output.error.mock.calls.flat().join(" ")).not.toContain("private payload");
  });
  it.each([{ flags: [] }, { flags: ["--yes"] }])("reports a stage conflict clearly without deleting ($flags)", async ({ flags }) => {
    const f = fixture();
    f.services.previewPurge.mockRejectedValue(Object.assign(new Error("private payload"), { name: "EsclubPurgeStageConflict" }));
    expect(await f.run(["purge", ID, ...flags])).toBe(1);
    expect(f.output.error.mock.calls.flat().join(" ")).toMatch(/another tournament.*series.*stages/i);
    expect(f.output.error.mock.calls.flat().join(" ")).not.toContain("private payload");
    expect(f.services.purgeTournament).not.toHaveBeenCalled();
  });
  it.each(["draft_simulator", undefined])("uses backend-configured services with DB_NAME=%j and closes its pool", async (databaseName) => {
    const output = { log: vi.fn(), error: vi.fn() };
    const query = vi.spyOn(sequelize, "query").mockResolvedValue([]);
    const close = vi.spyOn(sequelize, "close").mockResolvedValue();
    const load = vi.spyOn(Module.prototype, "require");
    expect(await runCli(["status"], { env: { DB_NAME: databaseName }, output, now: () => NOW })).toBe(0);
    expect(load).toHaveBeenCalledWith("../config/database");
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.contexts.every((context) => context === sequelize)).toBe(true);
    expect(JSON.parse(output.log.mock.calls[0][0])).toMatchObject({ day: "2026-11-14", used: 0, running: null, tournaments: [] });
    expect(close).toHaveBeenCalledTimes(1);
    expect(output.error).not.toHaveBeenCalled();
  });
  it("does not load default services for invalid arguments", async () => {
    const load = vi.spyOn(Module.prototype, "require");
    const query = vi.spyOn(sequelize, "query").mockResolvedValue([]);
    const close = vi.spyOn(sequelize, "close").mockResolvedValue();
    expect(await runCli(["purge", "not-a-uuid"], { output: { log: vi.fn(), error: vi.fn() } })).toBe(2);
    expect(load).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("CLI model bootstrap", () => {
  it("initializes real refresh associations once in a fresh process without connecting or querying", () => {
    const result = spawnSync(process.execPath, ["-e", `
      const assert = require("node:assert/strict");
      const sequelize = require(${JSON.stringify(require.resolve("../../config/database"))});
      sequelize.connectionManager.getConnection = async () => {
        throw new Error("Database connections forbidden in CLI bootstrap test");
      };
      const statements = [];
      sequelize.query = async (sql) => { statements.push(sql); return null; };
      const { createServices } = require(${JSON.stringify(require.resolve("../../scripts/esclub"))});
      const LeagueSeries = require(${JSON.stringify(require.resolve("../../models/LeagueSeries"))});
      assert.deepEqual(Object.keys(LeagueSeries.associations), []);
      createServices();
      const associations = { ...LeagueSeries.associations };
      for (const [alias, model, foreignKey] of [
        ["Stage", "LeagueStage", "stage_id"],
        ["Tournament", "Tournament", "tournament_id"],
        ["Team1", "Team", "team1_id"],
        ["Team2", "Team", "team2_id"],
        ["Games", "LeagueGame", "series_id"],
      ]) {
        assert.ok(associations[alias], "Missing LeagueSeries association: " + alias);
        assert.equal(associations[alias].target, sequelize.models[model]);
        assert.equal(associations[alias].foreignKey, foreignKey);
      }
      createServices();
      for (const [alias, association] of Object.entries(associations)) {
        assert.equal(LeagueSeries.associations[alias], association);
      }
      assert.deepEqual(statements, []);
      const { loadSeriesForRefresh } = require(${JSON.stringify(require.resolve("../../services/esclub/mirrorStore"))});
      loadSeriesForRefresh(${JSON.stringify(SERIES)}).then((row) => {
        assert.equal(row, null);
        assert.equal(statements.length, 1);
        for (const alias of ["Stage", "Tournament", "Team1", "Team2"]) {
          assert.ok(statements[0].includes('AS "' + alias + '"'), "Missing refresh join: " + alias);
        }
      }).catch((error) => { console.error(error); process.exitCode = 1; });
    `], { encoding: "utf8", timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("CLI default read queries (SQL capture, no database)", () => {
  it("scopes tournament reads and projects counts and last syncs without private fields", async () => {
    const log = [];
    vi.spyOn(sequelize, "query").mockImplementation(async (sql, options) => {
      log.push(injectReplacements(sql, sequelize.dialect, options.replacements ?? {}).replace(/\s+/g, " "));
      return [];
    });
    const services = createServices();
    expect(await services.findTournament(ID)).toBeNull();
    expect(await services.findSerie(SERIES)).toBeNull();
    expect(await services.readRunning()).toBeNull();
    expect(await services.listTournaments()).toEqual([]);
    expect(log).toHaveLength(4);
    expect(log[0]).toContain(`id = '${ID}'`);
    expect(log[0]).toContain("source = 'esclub'");
    expect(log[1]).toContain(`s.id = '${SERIES}'`);
    expect(log[1]).toContain('JOIN "Tournaments"');
    expect(log[1]).toContain("t.source = 'esclub'");
    expect(log[2]).toContain("status = 'running'");
    expect(log[3]).toContain("t.source = 'esclub'");
    for (const table of ["LeagueStages", "LeagueSeries", "LeagueGames", "EsclubSyncs"]) expect(log[3]).toContain(`"${table}"`);
    expect(log[3]).toContain("last_sync_status");
    expect(log[3]).toMatch(/ORDER BY .*started_at DESC/);
    for (const sql of log) expect(sql).not.toMatch(/SELECT \*|participants|playerKey|gameName|tagLine|error_message|requested_by/);
  });
});
