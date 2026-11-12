import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const migration = require("../../migrations/20261112120100-add-team-tournament-columns");
const {
  createRecordingQueryInterface,
  callsTo,
  rawSql,
} = require("./recordingQueryInterface");

async function runUp() {
  const fake = createRecordingQueryInterface();
  await migration.up(fake.queryInterface, fake.Sequelize);
  return fake;
}

function addedColumns(calls) {
  const added = {};
  for (const call of callsTo(calls, "addColumn")) {
    expect(call.args[0]).toBe("Teams");
    added[call.args[1]] = call.args[2];
  }
  return added;
}

const sqlMatching = (calls, pattern) =>
  rawSql(calls).filter((sql) => pattern.test(sql));

describe("add-team-tournament-columns migration: up", () => {
  it("runs inside one transaction and passes it to every call", async () => {
    const { calls, transaction } = await runUp();
    expect(calls[0].method).toBe("transaction:begin");
    expect(calls[calls.length - 1].method).toBe("transaction:commit");
    for (const call of calls) {
      if (call.method.startsWith("transaction:")) continue;
      const options = call.args[call.args.length - 1];
      expect(options.transaction, call.method).toBe(transaction);
    }
  });

  it("adds exactly the seven new columns", async () => {
    const { calls } = await runUp();
    expect(Object.keys(addedColumns(calls)).sort()).toEqual(
      [
        "tournament_id", "source", "external_id", "external_org_id",
        "acronym", "colors", "archived_at",
      ].sort(),
    );
  });

  it("adds tournament_id as a nullable FK to Tournaments, ON DELETE RESTRICT", async () => {
    const { calls, Sequelize } = await runUp();
    const column = addedColumns(calls).tournament_id;
    expect(column.type).toBe(Sequelize.UUID);
    expect(column.allowNull).toBe(true);
    expect(column.references).toEqual({ model: "Tournaments", key: "id" });
    expect(column.onDelete).toBe("RESTRICT");
  });

  it("adds source as STRING(16) NOT NULL DEFAULT 'manual'", async () => {
    const { calls, Sequelize } = await runUp();
    const column = addedColumns(calls).source;
    expect(column.type.toString()).toBe(Sequelize.STRING(16).toString());
    expect(column.type.key).toBe("STRING");
    expect(column.allowNull).toBe(false);
    expect(column.defaultValue).toBe("manual");
  });

  it("adds the optional columns, all nullable with no default", async () => {
    const { calls, Sequelize } = await runUp();
    const columns = addedColumns(calls);
    expect(columns.external_id.type.toString()).toBe(Sequelize.STRING(64).toString());
    expect(columns.external_org_id.type.toString()).toBe(Sequelize.STRING(64).toString());
    expect(columns.acronym.type.toString()).toBe(Sequelize.STRING(16).toString());
    expect(columns.colors.type).toBe(Sequelize.JSONB);
    expect(columns.archived_at.type).toBe(Sequelize.DATE);
    for (const name of [
      "external_id", "external_org_id", "acronym", "colors", "archived_at",
    ]) {
      expect(columns[name].allowNull, name).toBe(true);
      expect(columns[name].defaultValue, name).toBeUndefined();
      expect(columns[name].references, name).toBeUndefined();
    }
  });

  it("makes owner_id nullable with raw SQL, leaving its FK alone", async () => {
    const { calls } = await runUp();
    const drops = sqlMatching(calls, /ALTER COLUMN "?owner_id"? DROP NOT NULL/i);
    expect(drops).toEqual([
      'ALTER TABLE "Teams" ALTER COLUMN "owner_id" DROP NOT NULL',
    ]);
    expect(callsTo(calls, "changeColumn")).toHaveLength(0);
    expect(callsTo(calls, "removeConstraint")).toHaveLength(0);
    expect(rawSql(calls).some((sql) => /DROP CONSTRAINT/i.test(sql))).toBe(false);
    expect(rawSql(calls).some((sql) => /FOREIGN KEY|REFERENCES/i.test(sql))).toBe(false);
  });

  it("adds the two CHECK constraints by name", async () => {
    const { calls } = await runUp();
    const checks = sqlMatching(calls, /ADD CONSTRAINT/i);
    expect(checks).toEqual([
      `ALTER TABLE "Teams" ADD CONSTRAINT teams_source_check CHECK (source IN ('manual', 'esclub'))`,
      `ALTER TABLE "Teams" ADD CONSTRAINT teams_esclub_no_owner_check CHECK (source <> 'esclub' OR owner_id IS NULL)`,
    ]);
  });

  it("creates the partial unique index on (tournament_id, external_id)", async () => {
    const { calls } = await runUp();
    expect(
      sqlMatching(calls, /CREATE UNIQUE INDEX teams_tournament_external_id_uniq/),
    ).toEqual([
      `CREATE UNIQUE INDEX teams_tournament_external_id_uniq ON "Teams" (tournament_id, external_id) WHERE external_id IS NOT NULL`,
    ]);
  });

  it("creates the partial unique index on (tournament_id, lower(name)) for manual teams", async () => {
    const { calls } = await runUp();
    expect(
      sqlMatching(calls, /CREATE UNIQUE INDEX teams_tournament_name_manual_uniq/),
    ).toEqual([
      `CREATE UNIQUE INDEX teams_tournament_name_manual_uniq ON "Teams" (tournament_id, lower(name)) WHERE tournament_id IS NOT NULL AND source = 'manual'`,
    ]);
  });

  it("creates the plain index on tournament_id", async () => {
    const { calls } = await runUp();
    const indexes = [
      ...callsTo(calls, "addIndex").map((c) => c.args),
      ...sqlMatching(calls, /CREATE INDEX/i),
    ];
    expect(indexes).toHaveLength(1);
    if (typeof indexes[0] === "string") {
      expect(indexes[0]).toBe(
        `CREATE INDEX teams_tournament_id_idx ON "Teams" (tournament_id)`,
      );
    } else {
      expect(indexes[0][0]).toBe("Teams");
      expect(indexes[0][1]).toEqual(["tournament_id"]);
      expect(indexes[0][2].name).toBe("teams_tournament_id_idx");
    }
  });

  it("adds columns before the constraints and indexes that use them", async () => {
    const { calls } = await runUp();
    const lastAdd = calls.map((c) => c.method).lastIndexOf("addColumn");
    const firstSql = calls.findIndex(
      (c) => c.method === "query" && /ADD CONSTRAINT|CREATE/i.test(String(c.args[0])),
    );
    expect(lastAdd).toBeLessThan(firstSql);
  });

  it("writes no data (existing rows take the defaults)", async () => {
    const { calls } = await runUp();
    expect(rawSql(calls).some((sql) => /^(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
    expect(callsTo(calls, "bulkUpdate")).toHaveLength(0);
    expect(callsTo(calls, "bulkInsert")).toHaveLength(0);
  });
});

describe("add-team-tournament-columns migration: down", () => {
  const blockingRow = { id: "t1" };

  async function runDown(rows) {
    const fake = createRecordingQueryInterface({
      onQuery: (sql) => (/^\s*SELECT/i.test(String(sql)) ? rows : undefined),
    });
    const outcome = await migration.down(fake.queryInterface, fake.Sequelize).then(
      () => null,
      (error) => error,
    );
    return { ...fake, outcome };
  }

  it("throws and changes nothing when an esclub or ownerless team exists", async () => {
    const { calls, outcome } = await runDown([blockingRow]);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome.message).toMatch(/esclub|owner/i);
    const selects = rawSql(calls).filter((sql) => /^SELECT/i.test(sql));
    expect(selects).toHaveLength(1);
    // Either kind of row blocks: OR, not AND (review M1).
    expect(selects[0]).toMatch(/source = 'esclub' OR "?owner_id"? IS NULL/);
    expect(rawSql(calls).filter((sql) => !/^SELECT/i.test(sql))).toEqual([]);
    for (const method of [
      "removeColumn", "removeIndex", "removeConstraint", "changeColumn",
      "addColumn", "addIndex", "addConstraint",
    ]) {
      expect(callsTo(calls, method), method).toHaveLength(0);
    }
    expect(calls[calls.length - 1].method).toBe("transaction:rollback");
  });

  it("reverses up when nothing blocks", async () => {
    const { calls, outcome, transaction } = await runDown([]);
    expect(outcome).toBeNull();
    expect(calls[0].method).toBe("transaction:begin");
    expect(calls[calls.length - 1].method).toBe("transaction:commit");

    const sql = rawSql(calls);
    expect(sql[0]).toMatch(/^SELECT/i);
    const rest = sql.slice(1);
    expect(rest).toEqual([
      "DROP INDEX teams_tournament_id_idx",
      "DROP INDEX teams_tournament_name_manual_uniq",
      "DROP INDEX teams_tournament_external_id_uniq",
      `ALTER TABLE "Teams" DROP CONSTRAINT teams_esclub_no_owner_check`,
      `ALTER TABLE "Teams" DROP CONSTRAINT teams_source_check`,
      `ALTER TABLE "Teams" ALTER COLUMN "owner_id" SET NOT NULL`,
    ]);

    const removed = callsTo(calls, "removeColumn").map((c) => c.args[1]);
    expect(removed.sort()).toEqual(
      [
        "tournament_id", "source", "external_id", "external_org_id",
        "acronym", "colors", "archived_at",
      ].sort(),
    );
    for (const call of callsTo(calls, "removeColumn")) {
      expect(call.args[0]).toBe("Teams");
      expect(call.args[2].transaction).toBe(transaction);
    }
  });

  it("removes exactly the columns up adds, in reverse order", async () => {
    const up = await runUp();
    const down = await runDown([]);
    const added = callsTo(up.calls, "addColumn").map((c) => c.args[1]);
    const removed = callsTo(down.calls, "removeColumn").map((c) => c.args[1]);
    expect(removed).toEqual([...added].reverse());
  });

  it("drops the indexes and constraints before the columns, and restores NOT NULL last among the DDL on owner_id", async () => {
    const { calls } = await runDown([]);
    const firstRemove = calls.findIndex((c) => c.method === "removeColumn");
    const lastIndexOrConstraint = calls
      .map((c, i) => (c.method === "query" && /DROP (INDEX|CONSTRAINT)/i.test(String(c.args[0])) ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(lastIndexOrConstraint).toBeLessThan(firstRemove);
  });

  it("drops by the names up created", async () => {
    const up = await runUp();
    const down = await runDown([]);
    const created = [
      ...rawSql(up.calls).map((s) => s.match(/(?:CONSTRAINT|INDEX) (\w+)/)).filter(Boolean).map((m) => m[1]),
      ...callsTo(up.calls, "addIndex").map((c) => c.args[2].name),
    ];
    const dropped = rawSql(down.calls)
      .filter((s) => /^(DROP INDEX|ALTER TABLE "Teams" DROP CONSTRAINT)/.test(s))
      .map((s) => s.match(/(?:CONSTRAINT|INDEX) (\w+)/)[1]);
    expect(dropped.sort()).toEqual(created.sort());
  });
});
