import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const migration = require("../../migrations/20261114120000-add-versus-draft-league-series");
const {
  createRecordingQueryInterface,
  callsTo,
  rawSql,
} = require("./recordingQueryInterface");

const INDEX = "versus_drafts_league_series_id_idx";

async function run(direction) {
  const fake = createRecordingQueryInterface();
  await migration[direction](fake.queryInterface, fake.Sequelize);
  return fake;
}

function expectOneTransaction({ calls, transaction }) {
  expect(calls[0].method).toBe("transaction:begin");
  expect(calls[calls.length - 1].method).toBe("transaction:commit");
  expect(callsTo(calls, "transaction:begin")).toHaveLength(1);
  for (const call of calls) {
    if (call.method.startsWith("transaction:")) continue;
    const options = call.args[call.args.length - 1];
    expect(options.transaction, call.method).toBe(transaction);
  }
}

describe("add-versus-draft-league-series migration: up", () => {
  it("adds VersusDrafts.league_series_id, then its named index", async () => {
    const { calls } = await run("up");
    const work = calls.filter((c) => !c.method.startsWith("transaction:"));
    expect(work.map((c) => c.method)).toEqual(["addColumn", "query"]);
    expect(work[0].args[0]).toBe("VersusDrafts");
    expect(work[0].args[1]).toBe("league_series_id");
  });

  it("makes the column a nullable UUID FK to LeagueSeries, SET NULL on delete", async () => {
    const { calls } = await run("up");
    const column = callsTo(calls, "addColumn")[0].args[2];
    expect(column.type.key).toBe("UUID");
    expect(column.allowNull).toBe(true);
    expect(column.references).toEqual({ model: "LeagueSeries", key: "id" });
    expect(column.onDelete).toBe("SET NULL");
    expect(column.onUpdate).toBe("CASCADE");
    expect(column.unique).toBeUndefined();
    expect(column.defaultValue).toBeUndefined();
  });

  it("creates a plain (not unique) named index on the column", async () => {
    const { calls } = await run("up");
    expect(rawSql(calls)).toEqual([
      `CREATE INDEX ${INDEX} ON "VersusDrafts" (league_series_id)`,
    ]);
  });

  it("runs inside one transaction and passes it to every call", async () => {
    expectOneTransaction(await run("up"));
  });
});

describe("add-versus-draft-league-series migration: down", () => {
  it("drops the index, then removes the column", async () => {
    const { calls } = await run("down");
    const work = calls.filter((c) => !c.method.startsWith("transaction:"));
    expect(work.map((c) => c.method)).toEqual(["query", "removeColumn"]);
    expect(rawSql(calls)).toEqual([`DROP INDEX ${INDEX}`]);
    expect(work[1].args.slice(0, 2)).toEqual(["VersusDrafts", "league_series_id"]);
  });

  it("runs inside one transaction and passes it to every call", async () => {
    expectOneTransaction(await run("down"));
  });
});
