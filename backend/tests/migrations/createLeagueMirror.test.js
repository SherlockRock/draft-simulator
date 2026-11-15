import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const migration = require("../../migrations/20261113120000-create-league-mirror");
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

function sqlFor(calls, table, pattern) {
  const found = rawSql(calls).filter(
    (sql) => sql.includes(`"${table}"`) && pattern.test(sql),
  );
  expect(found, `${table} ${pattern}`).toHaveLength(1);
  return found[0];
}

function expectString(column, length, allowNull) {
  expect(column.type.toString()).toBe(`VARCHAR(${length})`);
  expect(column.allowNull).toBe(allowNull);
}

function expectFk(column, model, onDelete, allowNull) {
  expect(column.type.key).toBe("UUID");
  expect(column.allowNull).toBe(allowNull);
  expect(column.references).toEqual({ model, key: "id" });
  expect(column.onDelete).toBe(onDelete);
}

function expectTimestamps(columns) {
  for (const name of ["createdAt", "updatedAt"]) {
    expect(columns[name].type.key).toBe("DATE");
    expect(columns[name].allowNull).toBe(false);
  }
}

describe("create-league-mirror migration: up", () => {
  it("creates LeagueStages, LeagueSeries, then LeagueGames", async () => {
    const { calls } = await runUp();
    expect(callsTo(calls, "createTable").map((c) => c.args[0])).toEqual([
      "LeagueStages",
      "LeagueSeries",
      "LeagueGames",
    ]);
  });

  it("runs inside one transaction and passes it to every call", async () => {
    const { calls, transaction } = await runUp();
    expect(calls[0].method).toBe("transaction:begin");
    expect(calls[calls.length - 1].method).toBe("transaction:commit");
    expect(callsTo(calls, "transaction:begin")).toHaveLength(1);
    for (const call of calls) {
      if (call.method.startsWith("transaction:")) continue;
      const options = call.args[call.args.length - 1];
      expect(options.transaction, call.method).toBe(transaction);
    }
  });

  it("defines the LeagueStages columns", async () => {
    const { calls, Sequelize } = await runUp();
    const c = tableColumns(calls, "LeagueStages");
    expect(Object.keys(c).sort()).toEqual(
      [
        "id", "tournament_id", "external_id", "name", "added_by",
        "last_synced_at", "createdAt", "updatedAt",
      ].sort(),
    );
    expect(c.id.primaryKey).toBe(true);
    expect(c.id.type.key).toBe("UUID");
    expect(c.id.defaultValue).toBe(Sequelize.UUIDV4);
    expectFk(c.tournament_id, "Tournaments", "CASCADE", false);
    expectString(c.external_id, 64, false);
    expectString(c.name, 200, false);
    expectFk(c.added_by, "Users", "SET NULL", true);
    expect(c.last_synced_at.type.key).toBe("DATE");
    expect(c.last_synced_at.allowNull).toBe(true);
    expectTimestamps(c);
  });

  it("names LeagueStages' unique constraint and index", async () => {
    const { calls } = await runUp();
    expect(sqlFor(calls, "LeagueStages", /league_stages_external_id_uniq/)).toMatch(
      /ADD CONSTRAINT league_stages_external_id_uniq UNIQUE \(external_id\)$/,
    );
    expect(sqlFor(calls, "LeagueStages", /league_stages_tournament_id_idx/)).toMatch(
      /^CREATE INDEX league_stages_tournament_id_idx ON "LeagueStages" \(tournament_id\)$/,
    );
  });

  it("defines the LeagueSeries columns", async () => {
    const { calls } = await runUp();
    const c = tableColumns(calls, "LeagueSeries");
    expect(Object.keys(c).sort()).toEqual(
      [
        "id", "tournament_id", "stage_id", "external_id", "parent_type",
        "number", "team1_id", "team2_id", "best_of", "draft_type", "starts_at",
        "esclub_status", "status", "complete", "finished_at", "last_synced_at",
        "createdAt", "updatedAt",
      ].sort(),
    );
    expect(c.id.primaryKey).toBe(true);
    expectFk(c.tournament_id, "Tournaments", "CASCADE", false);
    expectFk(c.stage_id, "LeagueStages", "CASCADE", false);
    expectString(c.external_id, 64, false);
    expectString(c.parent_type, 16, false);
    expect(c.number.type.key).toBe("INTEGER");
    expect(c.number.allowNull).toBe(false);
    expectFk(c.team1_id, "Teams", "RESTRICT", true);
    expectFk(c.team2_id, "Teams", "RESTRICT", true);
    expect(c.best_of.type.key).toBe("INTEGER");
    expect(c.best_of.allowNull).toBe(false);
    expectString(c.draft_type, 16, true);
    expect(c.starts_at.type.key).toBe("DATE");
    expect(c.starts_at.allowNull).toBe(true);
    expectString(c.esclub_status, 32, false);
    expectString(c.status, 16, false);
    expect(c.complete.type.key).toBe("BOOLEAN");
    expect(c.complete.allowNull).toBe(false);
    expect(c.complete.defaultValue).toBe(false);
    for (const name of ["finished_at", "last_synced_at"]) {
      expect(c[name].type.key, name).toBe("DATE");
      expect(c[name].allowNull, name).toBe(true);
    }
    expectTimestamps(c);
  });

  it("names LeagueSeries' unique constraint, CHECKs and indexes", async () => {
    const { calls } = await runUp();
    const t = "LeagueSeries";
    expect(sqlFor(calls, t, /league_series_external_id_uniq/)).toMatch(
      /ADD CONSTRAINT league_series_external_id_uniq UNIQUE \(external_id\)$/,
    );
    expect(sqlFor(calls, t, /league_series_parent_type_check/)).toMatch(
      /ADD CONSTRAINT league_series_parent_type_check CHECK \(parent_type IN \('Group', 'Round'\)\)$/,
    );
    expect(sqlFor(calls, t, /league_series_draft_type_check/)).toMatch(
      /ADD CONSTRAINT league_series_draft_type_check CHECK \(draft_type IS NULL OR draft_type IN \('fearless', 'standard'\)\)$/,
    );
    expect(sqlFor(calls, t, /league_series_status_check/)).toMatch(
      /ADD CONSTRAINT league_series_status_check CHECK \(status IN \('upcoming', 'in_progress', 'finished'\)\)$/,
    );
    expect(sqlFor(calls, t, /league_series_distinct_teams_check/)).toMatch(
      /ADD CONSTRAINT league_series_distinct_teams_check CHECK \(team1_id IS NULL OR team2_id IS NULL OR team1_id <> team2_id\)$/,
    );
    for (const column of ["tournament_id", "stage_id", "team1_id", "team2_id"]) {
      expect(sqlFor(calls, t, new RegExp(`league_series_${column}_idx`))).toBe(
        `CREATE INDEX league_series_${column}_idx ON "LeagueSeries" (${column})`,
      );
    }
  });

  it("defines the LeagueGames columns", async () => {
    const { calls } = await runUp();
    const c = tableColumns(calls, "LeagueGames");
    expect(Object.keys(c).sort()).toEqual(
      [
        "id", "series_id", "external_match_id", "number", "picks", "first_pick",
        "blue_side_team", "winner", "participants", "substitutions",
        "unmatched_participants", "played_at", "complete", "createdAt",
        "updatedAt",
      ].sort(),
    );
    expect(c.id.primaryKey).toBe(true);
    expectFk(c.series_id, "LeagueSeries", "CASCADE", false);
    expectString(c.external_match_id, 64, false);
    expect(c.number.type.key).toBe("INTEGER");
    expect(c.number.allowNull).toBe(false);
    expect(c.picks.type.key).toBe("ARRAY");
    expect(c.picks.type.type.key).toBe("TEXT");
    expect(c.picks.allowNull).toBe(false);
    expectString(c.first_pick, 4, false);
    expect(c.blue_side_team.type.key).toBe("SMALLINT");
    expect(c.blue_side_team.allowNull).toBe(false);
    expectString(c.winner, 4, true);
    expect(c.participants.type.key).toBe("JSONB");
    expect(c.participants.allowNull).toBe(false);
    expect(c.participants.defaultValue).toEqual({});
    expect(c.substitutions.type.key).toBe("JSONB");
    expect(c.substitutions.allowNull).toBe(false);
    expect(c.substitutions.defaultValue).toEqual([]);
    expect(c.unmatched_participants.type.key).toBe("INTEGER");
    expect(c.unmatched_participants.allowNull).toBe(false);
    expect(c.unmatched_participants.defaultValue).toBe(0);
    expect(c.played_at.type.key).toBe("DATE");
    expect(c.played_at.allowNull).toBe(true);
    expect(c.complete.type.key).toBe("BOOLEAN");
    expect(c.complete.allowNull).toBe(false);
    expect(c.complete.defaultValue).toBe(false);
    expectTimestamps(c);
  });

  it("names LeagueGames' unique constraints and CHECKs", async () => {
    const { calls } = await runUp();
    const t = "LeagueGames";
    expect(sqlFor(calls, t, /league_games_external_match_id_uniq/)).toMatch(
      /ADD CONSTRAINT league_games_external_match_id_uniq UNIQUE \(external_match_id\)$/,
    );
    expect(sqlFor(calls, t, /league_games_series_number_uniq/)).toMatch(
      /ADD CONSTRAINT league_games_series_number_uniq UNIQUE \(series_id, number\)$/,
    );
    expect(sqlFor(calls, t, /league_games_first_pick_check/)).toMatch(
      /CHECK \(first_pick IN \('blue', 'red'\)\)$/,
    );
    expect(sqlFor(calls, t, /league_games_blue_side_team_check/)).toMatch(
      /CHECK \(blue_side_team IN \(1, 2\)\)$/,
    );
    expect(sqlFor(calls, t, /league_games_winner_check/)).toMatch(
      /CHECK \(winner IS NULL OR winner IN \('blue', 'red'\)\)$/,
    );
  });

  it("runs no raw SQL beyond the named constraints and indexes", async () => {
    const { calls } = await runUp();
    for (const sql of rawSql(calls)) {
      expect(sql).toMatch(/^(ALTER TABLE .* ADD CONSTRAINT \w+ |CREATE INDEX \w+ )/);
    }
    // 1 + 1 stages, 1 + 4 CHECKs + 4 indexes series, 2 + 3 games = 16
    expect(rawSql(calls)).toHaveLength(16);
  });
});

describe("create-league-mirror migration: down", () => {
  it("drops games, series, stages in one transaction", async () => {
    const fake = createRecordingQueryInterface();
    await migration.down(fake.queryInterface, fake.Sequelize);
    expect(callsTo(fake.calls, "dropTable").map((c) => c.args[0])).toEqual([
      "LeagueGames",
      "LeagueSeries",
      "LeagueStages",
    ]);
    expect(fake.calls[0].method).toBe("transaction:begin");
    expect(fake.calls[fake.calls.length - 1].method).toBe("transaction:commit");
    expect(callsTo(fake.calls, "transaction:begin")).toHaveLength(1);
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
