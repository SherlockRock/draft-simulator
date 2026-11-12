import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const migration = require("../../migrations/20261112120200-clear-placeholder-team-names");
const sqlKit = require("../../utils/placeholderTeamNameMigration");
const { createRecordingQueryInterface, callsTo, rawSql } = require("./recordingQueryInterface");

async function runUp(onQuery) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const fake = createRecordingQueryInterface({ onQuery });
    await migration.up(fake.queryInterface, fake.Sequelize);
    return { ...fake, logs: log.mock.calls.map((c) => c.join(" ")) };
  } finally {
    log.mockRestore();
  }
}

const flat = (s) => s.replace(/\s+/g, " ").trim();

describe("clear-placeholder-team-names: up", () => {
  it("runs in one transaction and passes it to every query", async () => {
    const { calls, transaction } = await runUp();
    expect(calls[0].method).toBe("transaction:begin");
    expect(calls[calls.length - 1].method).toBe("transaction:commit");
    expect(callsTo(calls, "transaction:begin")).toHaveLength(1);
    for (const call of calls) {
      if (call.method.startsWith("transaction:")) continue;
      expect(call.args[call.args.length - 1].transaction, call.method).toBe(transaction);
    }
  });

  it("runs exactly: count+copy blue, count+copy red, count+strip, in that order", async () => {
    const { calls } = await runUp();
    expect(rawSql(calls)).toEqual([
      flat(sqlKit.copyCountSql("blueTeamName")),
      flat(sqlKit.copyUpdateSql("blueTeamName")),
      flat(sqlKit.copyCountSql("redTeamName")),
      flat(sqlKit.copyUpdateSql("redTeamName")),
      flat(sqlKit.stripCountSql()),
      flat(sqlKit.stripUpdateSql()),
    ]);
  });

  it("selects the count before every write", async () => {
    const { calls } = await runUp();
    const sql = rawSql(calls);
    sql.forEach((statement, i) => {
      if (/^UPDATE/.test(statement)) expect(sql[i - 1]).toMatch(/^SELECT count\(\*\)/);
    });
    expect(sql.filter((s) => /^UPDATE/.test(s))).toHaveLength(3);
  });

  it("copies before it strips", async () => {
    const { calls } = await runUp();
    const updates = rawSql(calls).filter((s) => /^UPDATE/.test(s));
    expect(updates[0]).toMatch(/^UPDATE "VersusDrafts"/);
    expect(updates[1]).toMatch(/^UPDATE "VersusDrafts"/);
    expect(updates[2]).toMatch(/^UPDATE "CanvasGroups"/);
  });

  it("never nulls or blanks a VersusDrafts column, and uses no other API", async () => {
    const { calls } = await runUp();
    for (const method of ["bulkUpdate", "bulkInsert", "addColumn", "removeColumn", "changeColumn"]) {
      expect(callsTo(calls, method), method).toHaveLength(0);
    }
    for (const sql of rawSql(calls).filter((s) => /^UPDATE "VersusDrafts"/.test(s))) {
      expect(sql).not.toMatch(/= (NULL|'')\b/i);
      expect(sql).toMatch(/SET "(blue|red)TeamName" = c\.name/);
    }
  });

  it("logs the count before and the rows changed after each write", async () => {
    const { logs } = await runUp((sql) =>
      /^\s*SELECT/i.test(String(sql)) ? [{ count: "7" }] : [[], { rowCount: 7 }],
    );
    expect(logs).toHaveLength(6);
    expect(logs[0]).toMatch(/copy blueTeamName.*7 row\(s\) to change/);
    expect(logs[1]).toMatch(/copy blueTeamName.*7 row\(s\) changed/);
    expect(logs[4]).toMatch(/strip.*7 row\(s\) to change/);
    expect(logs[5]).toMatch(/strip.*7 row\(s\) changed/);
  });

  it("tolerates an unanswered count (fake returns undefined)", async () => {
    const { logs } = await runUp();
    expect(logs[0]).toMatch(/0 row\(s\) to change/);
  });
});

describe("clear-placeholder-team-names: down", () => {
  it("is a no-op: no calls at all", async () => {
    const fake = createRecordingQueryInterface();
    await migration.down(fake.queryInterface, fake.Sequelize);
    expect(fake.calls).toEqual([]);
  });
});
