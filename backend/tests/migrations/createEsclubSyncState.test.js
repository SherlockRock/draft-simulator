import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const migration = require("../../migrations/20261113120100-create-esclub-sync-state");
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

describe("create-esclub-sync-state migration: up", () => {
  it("creates EsclubSyncs, then EsclubDailyUsage", async () => {
    const { calls } = await runUp();
    expect(callsTo(calls, "createTable").map((c) => c.args[0])).toEqual([
      "EsclubSyncs",
      "EsclubDailyUsage",
    ]);
  });

  it("runs inside one transaction and passes it to every call", async () => {
    const { calls, transaction } = await runUp();
    expect(calls.filter((c) => c.method === "transaction:begin")).toHaveLength(1);
    expect(calls[0].method).toBe("transaction:begin");
    expect(calls[calls.length - 1].method).toBe("transaction:commit");
    for (const call of calls) {
      if (call.method.startsWith("transaction:")) continue;
      const options = call.args[call.args.length - 1];
      expect(options.transaction, call.method).toBe(transaction);
    }
  });

  it("defines the EsclubSyncs columns", async () => {
    const { calls, Sequelize } = await runUp();
    const c = tableColumns(calls, "EsclubSyncs");
    expect(Object.keys(c).sort()).toEqual(
      [
        "id", "kind", "tournament_id", "stage_id", "series_id", "requested_by",
        "via", "status", "started_at", "heartbeat_at", "finished_at",
        "request_count", "error_class", "error_message", "summary",
        "createdAt", "updatedAt",
      ].sort(),
    );

    expect(c.id.primaryKey).toBe(true);
    expect(c.id.type).toBe(Sequelize.UUID);
    expect(c.id.defaultValue).toBe(Sequelize.UUIDV4);

    const str = (name, len, allowNull) => {
      expect(c[name].type.toString(), name).toBe(Sequelize.STRING(len).toString());
      expect(c[name].allowNull, name).toBe(allowNull);
    };
    str("kind", 16, false);
    str("via", 8, false);
    str("status", 16, false);
    str("error_class", 64, true);

    for (const name of ["started_at", "heartbeat_at"]) {
      expect(c[name].type, name).toBe(Sequelize.DATE);
      expect(c[name].allowNull, name).toBe(false);
    }
    expect(c.finished_at.type).toBe(Sequelize.DATE);
    expect(c.finished_at.allowNull).toBe(true);

    expect(c.request_count.type).toBe(Sequelize.INTEGER);
    expect(c.request_count.allowNull).toBe(false);
    expect(c.request_count.defaultValue).toBe(0);

    expect(c.error_message.type).toBe(Sequelize.TEXT);
    expect(c.error_message.allowNull).toBe(true);
    expect(c.summary.type).toBe(Sequelize.JSONB);
    expect(c.summary.allowNull).toBe(true);

    for (const name of ["createdAt", "updatedAt"]) {
      expect(c[name].type).toBe(Sequelize.DATE);
      expect(c[name].allowNull).toBe(false);
    }
  });

  it("references each parent with ON DELETE SET NULL, all nullable", async () => {
    const { calls, Sequelize } = await runUp();
    const c = tableColumns(calls, "EsclubSyncs");
    const parents = {
      tournament_id: "Tournaments",
      stage_id: "LeagueStages",
      series_id: "LeagueSeries",
      requested_by: "Users",
    };
    for (const [column, model] of Object.entries(parents)) {
      expect(c[column].type, column).toBe(Sequelize.UUID);
      expect(c[column].allowNull, column).toBe(true);
      expect(c[column].references, column).toEqual({ model, key: "id" });
      expect(c[column].onDelete, column).toBe("SET NULL");
    }
  });

  it("adds a named CHECK for kind, via, status and the daily count", async () => {
    const { calls } = await runUp();
    const checks = rawSql(calls).filter((sql) => /CHECK/i.test(sql));
    expect(checks).toEqual([
      `ALTER TABLE "EsclubSyncs" ADD CONSTRAINT esclub_syncs_kind_check CHECK (kind IN ('add', 'league', 'serie'))`,
      `ALTER TABLE "EsclubSyncs" ADD CONSTRAINT esclub_syncs_via_check CHECK (via IN ('api', 'cli'))`,
      `ALTER TABLE "EsclubSyncs" ADD CONSTRAINT esclub_syncs_status_check CHECK (status IN ('running', 'succeeded', 'failed'))`,
      `ALTER TABLE "EsclubDailyUsage" ADD CONSTRAINT esclub_daily_usage_request_count_check CHECK (request_count >= 0)`,
    ]);
  });

  it("makes the partial unique index the one-running lock", async () => {
    const { calls } = await runUp();
    const unique = rawSql(calls).filter((sql) => /CREATE UNIQUE INDEX/i.test(sql));
    expect(unique).toEqual([
      `CREATE UNIQUE INDEX esclub_syncs_one_running ON "EsclubSyncs" (status) WHERE status = 'running'`,
    ]);
  });

  it("creates the three lookup indexes", async () => {
    const { calls } = await runUp();
    const plain = rawSql(calls).filter(
      (sql) => /CREATE INDEX/i.test(sql) && !/UNIQUE/i.test(sql),
    );
    expect(plain).toEqual([
      `CREATE INDEX esclub_syncs_tournament_kind_finished_idx ON "EsclubSyncs" (tournament_id, kind, finished_at)`,
      `CREATE INDEX esclub_syncs_series_kind_finished_idx ON "EsclubSyncs" (series_id, kind, finished_at)`,
      `CREATE INDEX esclub_syncs_requester_kind_started_idx ON "EsclubSyncs" (requested_by, kind, started_at)`,
    ]);
  });

  it("defines EsclubDailyUsage keyed by the UTC day", async () => {
    const { calls, Sequelize } = await runUp();
    const c = tableColumns(calls, "EsclubDailyUsage");
    expect(Object.keys(c).sort()).toEqual(
      ["day", "request_count", "createdAt", "updatedAt"].sort(),
    );
    expect(c.day.type).toBe(Sequelize.DATEONLY);
    expect(c.day.primaryKey).toBe(true);
    expect(c.day.allowNull).toBe(false);
    expect(c.request_count.type).toBe(Sequelize.INTEGER);
    expect(c.request_count.allowNull).toBe(false);
    expect(c.request_count.defaultValue).toBe(0);
    for (const name of ["createdAt", "updatedAt"]) {
      expect(c[name].type).toBe(Sequelize.DATE);
      expect(c[name].allowNull).toBe(false);
    }
  });
});

describe("create-esclub-sync-state migration: down", () => {
  it("drops both tables in one transaction, reverse of up", async () => {
    const up = await runUp();
    const down = createRecordingQueryInterface();
    await migration.down(down.queryInterface, down.Sequelize);
    const dropped = callsTo(down.calls, "dropTable").map((c) => c.args[0]);
    expect(dropped).toEqual(["EsclubDailyUsage", "EsclubSyncs"]);
    const created = callsTo(up.calls, "createTable").map((c) => c.args[0]);
    expect(dropped).toEqual([...created].reverse());
    expect(down.calls.filter((c) => c.method === "transaction:begin")).toHaveLength(1);
    expect(down.calls[0].method).toBe("transaction:begin");
    expect(down.calls[down.calls.length - 1].method).toBe("transaction:commit");
    for (const call of callsTo(down.calls, "dropTable")) {
      expect(call.args[1].transaction).toBe(down.transaction);
    }
  });
});
