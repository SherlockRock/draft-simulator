import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const migration = require("../../migrations/20261112120000-create-tournaments");
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

function tableColumns(calls, name) {
  const call = callsTo(calls, "createTable").find((c) => c.args[0] === name);
  expect(call, `createTable ${name}`).toBeDefined();
  return call.args[1];
}

describe("create-tournaments migration: up", () => {
  it("creates Tournaments, then UserTournaments", async () => {
    const { calls } = await runUp();
    expect(callsTo(calls, "createTable").map((c) => c.args[0])).toEqual([
      "Tournaments",
      "UserTournaments",
    ]);
  });

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

  it("defines the Tournaments columns", async () => {
    const { calls, Sequelize } = await runUp();
    const columns = tableColumns(calls, "Tournaments");
    expect(Object.keys(columns).sort()).toEqual(
      [
        "id", "name", "source", "external_id", "region", "starts_at",
        "ends_at", "created_by", "archived_at", "last_synced_at",
        "createdAt", "updatedAt",
      ].sort(),
    );

    expect(columns.id.primaryKey).toBe(true);
    expect(columns.id.type).toBe(Sequelize.UUID);
    expect(columns.id.defaultValue).toBe(Sequelize.UUIDV4);

    expect(columns.name.type.toString()).toBe(Sequelize.STRING(200).toString());
    expect(columns.name.allowNull).toBe(false);

    expect(columns.source.type.toString()).toBe(Sequelize.STRING(16).toString());
    expect(columns.source.allowNull).toBe(false);
    expect(columns.source.defaultValue).toBe("manual");

    expect(columns.external_id.type.toString()).toBe(Sequelize.STRING(64).toString());
    expect(columns.external_id.allowNull).toBe(true);

    expect(columns.region.type.toString()).toBe(Sequelize.STRING(8).toString());
    expect(columns.region.allowNull).toBe(false);
    expect(columns.region.defaultValue).toBe("na1");

    for (const name of ["starts_at", "ends_at", "archived_at", "last_synced_at"]) {
      expect(columns[name].type, name).toBe(Sequelize.DATE);
      expect(columns[name].allowNull, name).toBe(true);
    }

    expect(columns.created_by.type).toBe(Sequelize.UUID);
    expect(columns.created_by.allowNull).toBe(true);
    expect(columns.created_by.references).toEqual({ model: "Users", key: "id" });
    expect(columns.created_by.onDelete).toBe("SET NULL");

    for (const name of ["createdAt", "updatedAt"]) {
      expect(columns[name].type).toBe(Sequelize.DATE);
      expect(columns[name].allowNull).toBe(false);
    }
  });

  it("does not use an ENUM for source", async () => {
    const { calls } = await runUp();
    const columns = tableColumns(calls, "Tournaments");
    expect(columns.source.type.key).toBe("STRING");
  });

  it("restricts source to manual or esclub with a CHECK", async () => {
    const { calls } = await runUp();
    const checks = rawSql(calls).filter((sql) => /CHECK/i.test(sql));
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatch(/ALTER TABLE "Tournaments"/);
    expect(checks[0]).toMatch(/CHECK \(source IN \('manual', ?'esclub'\)\)/);
  });

  it("adds no region CHECK (the region set lives in code)", async () => {
    const { calls } = await runUp();
    expect(rawSql(calls).some((sql) => /region/i.test(sql))).toBe(false);
  });

  it("creates the partial unique index on (source, external_id)", async () => {
    const { calls } = await runUp();
    const indexes = rawSql(calls).filter((sql) => /CREATE UNIQUE INDEX/i.test(sql));
    expect(indexes).toHaveLength(1);
    expect(indexes[0]).toMatch(/ON "Tournaments" \(source, external_id\)/);
    expect(indexes[0]).toMatch(/WHERE external_id IS NOT NULL$/);
  });

  it("defines UserTournaments with a composite primary key", async () => {
    const { calls, Sequelize } = await runUp();
    const columns = tableColumns(calls, "UserTournaments");
    expect(Object.keys(columns).sort()).toEqual(
      ["user_id", "tournament_id", "archived_at", "createdAt", "updatedAt"].sort(),
    );

    expect(columns.user_id.type).toBe(Sequelize.UUID);
    expect(columns.user_id.allowNull).toBe(false);
    expect(columns.user_id.primaryKey).toBe(true);
    expect(columns.user_id.references).toEqual({ model: "Users", key: "id" });
    expect(columns.user_id.onDelete).toBe("CASCADE");

    expect(columns.tournament_id.type).toBe(Sequelize.UUID);
    expect(columns.tournament_id.allowNull).toBe(false);
    expect(columns.tournament_id.primaryKey).toBe(true);
    expect(columns.tournament_id.references).toEqual({
      model: "Tournaments",
      key: "id",
    });
    expect(columns.tournament_id.onDelete).toBe("CASCADE");

    expect(columns.archived_at.type).toBe(Sequelize.DATE);
    expect(columns.archived_at.allowNull).toBe(true);
    expect(columns.archived_at.primaryKey).toBeFalsy();
    for (const name of ["createdAt", "updatedAt"]) {
      expect(columns[name].allowNull).toBe(false);
    }
  });
});

describe("create-tournaments migration: down", () => {
  it("drops UserTournaments, then Tournaments, in one transaction", async () => {
    const fake = createRecordingQueryInterface();
    await migration.down(fake.queryInterface, fake.Sequelize);
    expect(callsTo(fake.calls, "dropTable").map((c) => c.args[0])).toEqual([
      "UserTournaments",
      "Tournaments",
    ]);
    expect(fake.calls[0].method).toBe("transaction:begin");
    expect(fake.calls[fake.calls.length - 1].method).toBe("transaction:commit");
    for (const call of callsTo(fake.calls, "dropTable")) {
      expect(call.args[1].transaction).toBe(fake.transaction);
    }
  });

  it("drops exactly the tables up creates, in reverse order", async () => {
    const up = await runUp();
    const down = createRecordingQueryInterface();
    await migration.down(down.queryInterface, down.Sequelize);
    const created = callsTo(up.calls, "createTable").map((c) => c.args[0]);
    const dropped = callsTo(down.calls, "dropTable").map((c) => c.args[0]);
    expect(dropped).toEqual([...created].reverse());
  });
});
