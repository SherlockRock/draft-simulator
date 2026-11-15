import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { Sequelize } = require("sequelize");
const sequelize = require("../../config/database");
const Tournament = require("../../models/Tournament");
const Team = require("../../models/Team");
const TeamPlayer = require("../../models/TeamPlayer");
const Stage = require("../../models/LeagueStage");
const Series = require("../../models/LeagueSeries");
const Game = require("../../models/LeagueGame");
const Name = require("../../models/LeaguePlayerName");
const store = require("../../services/esclub/mirrorStore");

// Deliberately fixed to the permitted local scratch copy. No .env connection
// can be used: all model SQL and transactions are redirected to this instance.
const run = process.env.S2B_POSTGRES_TESTS === "1" ? describe : describe.skip;
run("linked names on local scratch Postgres", () => {
  const local = new Sequelize("firstpick_s2b_build", "rsmith", null, {
    dialect: "postgres", host: "/var/run/postgresql", logging: false,
  });
  let tx;
  let tournament;
  let stage;
  let a;
  let b;
  const checked = new Date("2026-11-15T12:00:00Z");
  const row = (extra = {}) => ({ player_key: "synthetic-pg-account", game_name: "Linked", tag_line: "TEST", checked_at: checked, ...extra });
  beforeAll(() => {
    vi.spyOn(sequelize, "query").mockImplementation(local.query.bind(local));
    vi.spyOn(sequelize, "transaction").mockImplementation(local.transaction.bind(local));
  });
  beforeEach(async () => {
    tx = await local.transaction();
    tournament = await Tournament.create({ name: "Synthetic S2b league", source: "esclub", external_id: randomUUID(), region: "na1" }, { transaction: tx });
    stage = await Stage.create({ tournament_id: tournament.id, external_id: randomUUID(), name: "Synthetic stage" }, { transaction: tx });
    a = await Team.create({ tournament_id: tournament.id, name: "Synthetic A", source: "esclub", owner_id: null, region: "na1", external_id: randomUUID(), external_org_id: randomUUID() }, { transaction: tx });
    b = await Team.create({ tournament_id: tournament.id, name: "Synthetic B", source: "esclub", owner_id: null, region: "na1", external_id: randomUUID(), external_org_id: randomUUID() }, { transaction: tx });
    const series = await Series.create({ tournament_id: tournament.id, stage_id: stage.id, external_id: randomUUID(), parent_type: "Round", number: 1,
      best_of: 1, esclub_status: "Finished", status: "finished", team1_id: a.id, team2_id: b.id }, { transaction: tx });
    await Game.create({ series_id: series.id, external_match_id: randomUUID(), number: 1, picks: Array(20).fill("Ahri"), first_pick: "blue", blue_side_team: 2,
      winner: "blue", played_at: new Date("2026-11-14T12:00:00Z"), participants: {
        Ahri: { playerKey: "synthetic-pg-account", side: "red", lane: "mid", gameName: null, tagLine: null },
        Zed: { playerKey: "synthetic-pg-opponent", side: "blue", lane: "mid", gameName: null, tagLine: null },
      } }, { transaction: tx, logging: false });
  });
  afterEach(async () => { if (tx) await tx.rollback(); });
  afterAll(async () => { vi.restoreAllMocks(); await local.close(); });

  it("upserts a no-match to a name on the composite key and keeps tournaments isolated", async () => {
    await store.upsertPlayerNames(tournament.id, [row({ game_name: null, tag_line: null })], tx);
    await store.upsertPlayerNames(tournament.id, [row()], tx);
    await store.upsertPlayerNames(tournament.id, [row({ game_name: "Updated" })], tx);
    const names = await store.loadPlayerNames(tournament.id, tx);
    expect(names).toHaveLength(1);
    expect(names[0].game_name).toBe("Updated");
    expect(names[0].checked_at).toEqual(checked);
    expect(await store.loadPlayerNames(randomUUID(), tx)).toEqual([]);
  });
  it("loads stage teams with tournament-wide side-correct inputs and rebuilds from a linked name", async () => {
    const inputs = await store.loadStageTeamPlayers(tournament.id, stage.id, tx);
    expect(inputs.teams).toHaveLength(2);
    expect(inputs.allKeys.size).toBe(2);
    expect(inputs.teams.find((t) => t.id === a.id).entries[0].teamNumber).toBe(1);
    await store.upsertPlayerNames(tournament.id, [row()], tx);
    expect(await store.rebuildRoster(a, tournament.id, tx)).toBe(1);
    expect(await store.rebuildRoster(b, tournament.id, tx)).toBe(0);
    const roster = await TeamPlayer.findAll({ where: { team_id: a.id }, raw: true, transaction: tx, logging: false });
    expect(roster.map((p) => [p.gameName, p.tagLine, p.role])).toEqual([["Linked", "TEST", "mid"]]);
  });
  it("cascades name rows when the tournament is deleted", async () => {
    await store.upsertPlayerNames(tournament.id, [row()], tx);
    await Series.destroy({ where: { tournament_id: tournament.id }, transaction: tx });
    await Team.destroy({ where: { tournament_id: tournament.id }, transaction: tx });
    await Tournament.destroy({ where: { id: tournament.id }, transaction: tx });
    expect(await Name.count({ where: { tournament_id: tournament.id }, transaction: tx, logging: false })).toBe(0);
  });
  it("the database rejects a half-null name pair", async () => {
    await expect(local.query('INSERT INTO "LeaguePlayerNames" (tournament_id, player_key, game_name, tag_line, checked_at, "createdAt", "updatedAt") VALUES (:tid, :key, NULL, :tag, NOW(), NOW(), NOW())',
      { replacements: { tid: tournament.id, key: "synthetic-constraint-key", tag: "TEST" }, transaction: tx, logging: false })).rejects.toMatchObject({ name: "SequelizeDatabaseError", parent: { constraint: "league_player_names_name_pair" } });
  });
});
