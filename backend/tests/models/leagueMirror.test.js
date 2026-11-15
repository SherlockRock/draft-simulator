import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const LeagueStage = require("../../models/LeagueStage");
const LeagueSeries = require("../../models/LeagueSeries");
const LeagueGame = require("../../models/LeagueGame");
const Tournament = require("../../models/Tournament");
const Team = require("../../models/Team");
const setupAssociations = require("../../models/associations");

setupAssociations();

function expectColumns(model, columns) {
  const attrs = model.getAttributes();
  for (const column of columns) {
    expect(attrs[column], `missing column ${column}`).toBeDefined();
  }
}

async function validationFails(instance) {
  await expect(instance.validate()).rejects.toThrow();
}

const stageRow = {
  tournament_id: "11111111-1111-4111-8111-111111111111",
  external_id: "100",
  name: "Group Stage",
};
const seriesRow = {
  tournament_id: "11111111-1111-4111-8111-111111111111",
  stage_id: "22222222-2222-4222-8222-222222222222",
  external_id: "200",
  parent_type: "Group",
  number: 1,
  best_of: 3,
  esclub_status: "Finished",
  status: "finished",
};
const gameRow = {
  series_id: "33333333-3333-4333-8333-333333333333",
  external_match_id: "300",
  number: 1,
  picks: new Array(20).fill(""),
  first_pick: "blue",
  blue_side_team: 1,
};

describe("LeagueStage model", () => {
  const attrs = LeagueStage.getAttributes();

  it("maps to the LeagueStages table with snake_case columns", () => {
    expect(LeagueStage.tableName).toBe("LeagueStages");
    expectColumns(LeagueStage, [
      "id", "tournament_id", "external_id", "name", "added_by", "last_synced_at",
    ]);
    expect(attrs.externalId).toBeUndefined();
  });

  it("has a UUID primary key and required fields", () => {
    expect(attrs.id.primaryKey).toBe(true);
    expect(attrs.id.type.key).toBe("UUID");
    expect(attrs.tournament_id.allowNull).toBe(false);
    expect(attrs.external_id.allowNull).toBe(false);
    expect(attrs.external_id.type.toString()).toBe("VARCHAR(64)");
    expect(attrs.name.allowNull).toBe(false);
    expect(attrs.name.type.toString()).toBe("VARCHAR(200)");
  });

  it("makes added_by and last_synced_at nullable", () => {
    expect(attrs.added_by.allowNull).toBe(true);
    expect(attrs.added_by.references).toEqual({ model: "Users", key: "id" });
    expect(attrs.last_synced_at.allowNull).toBe(true);
    expect(attrs.last_synced_at.type.key).toBe("DATE");
  });

  it("validates a good row and rejects an empty name", async () => {
    await expect(LeagueStage.build(stageRow).validate()).resolves.toBeDefined();
    await validationFails(LeagueStage.build({ ...stageRow, name: "" }));
  });
});

describe("LeagueSeries model", () => {
  const attrs = LeagueSeries.getAttributes();

  it("maps to the LeagueSeries table with snake_case columns", () => {
    expect(LeagueSeries.tableName).toBe("LeagueSeries");
    expectColumns(LeagueSeries, [
      "id", "tournament_id", "stage_id", "external_id", "parent_type", "number",
      "team1_id", "team2_id", "best_of", "draft_type", "starts_at",
      "esclub_status", "status", "complete", "finished_at", "last_synced_at",
    ]);
  });

  it("has the right nullability", () => {
    for (const column of [
      "tournament_id", "stage_id", "external_id", "parent_type", "number",
      "best_of", "esclub_status", "status", "complete",
    ]) {
      expect(attrs[column].allowNull, column).toBe(false);
    }
    for (const column of [
      "team1_id", "team2_id", "draft_type", "starts_at", "finished_at",
      "last_synced_at",
    ]) {
      expect(attrs[column].allowNull, column).toBe(true);
    }
  });

  it("references Teams, LeagueStages and Tournaments", () => {
    expect(attrs.team1_id.references).toEqual({ model: "Teams", key: "id" });
    expect(attrs.team2_id.references).toEqual({ model: "Teams", key: "id" });
    expect(attrs.stage_id.references).toEqual({ model: "LeagueStages", key: "id" });
    expect(attrs.tournament_id.references).toEqual({ model: "Tournaments", key: "id" });
  });

  it("defaults complete to false", () => {
    expect(attrs.complete.defaultValue).toBe(false);
    expect(LeagueSeries.build(seriesRow).complete).toBe(false);
  });

  it("limits the small enums", () => {
    expect(attrs.parent_type.validate.isIn).toEqual([["Group", "Round"]]);
    expect(attrs.draft_type.validate.isIn).toEqual([["fearless", "standard"]]);
    expect(attrs.status.validate.isIn).toEqual([
      ["upcoming", "in_progress", "finished"],
    ]);
  });

  it("validates a good row and rejects bad enum values", async () => {
    await expect(LeagueSeries.build(seriesRow).validate()).resolves.toBeDefined();
    await expect(
      LeagueSeries.build({ ...seriesRow, draft_type: "fearless" }).validate(),
    ).resolves.toBeDefined();
    await validationFails(LeagueSeries.build({ ...seriesRow, parent_type: "Bracket" }));
    await validationFails(LeagueSeries.build({ ...seriesRow, draft_type: "random" }));
    await validationFails(LeagueSeries.build({ ...seriesRow, status: "done" }));
  });
});

describe("LeagueGame model", () => {
  const attrs = LeagueGame.getAttributes();

  it("maps to the LeagueGames table with snake_case columns", () => {
    expect(LeagueGame.tableName).toBe("LeagueGames");
    expectColumns(LeagueGame, [
      "id", "series_id", "external_match_id", "number", "picks", "first_pick",
      "blue_side_team", "winner", "participants", "substitutions",
      "unmatched_participants", "played_at", "complete",
    ]);
  });

  it("has the right types and nullability", () => {
    expect(attrs.picks.type.key).toBe("ARRAY");
    expect(attrs.picks.allowNull).toBe(false);
    expect(attrs.blue_side_team.type.key).toBe("SMALLINT");
    expect(attrs.participants.type.key).toBe("JSONB");
    expect(attrs.substitutions.type.key).toBe("JSONB");
    expect(attrs.winner.allowNull).toBe(true);
    expect(attrs.played_at.allowNull).toBe(true);
    for (const column of [
      "series_id", "external_match_id", "number", "first_pick",
      "blue_side_team", "participants", "substitutions",
      "unmatched_participants", "complete",
    ]) {
      expect(attrs[column].allowNull, column).toBe(false);
    }
    expect(attrs.series_id.references).toEqual({ model: "LeagueSeries", key: "id" });
  });

  it("applies defaults on build", () => {
    const game = LeagueGame.build(gameRow);
    expect(game.participants).toEqual({});
    expect(game.substitutions).toEqual([]);
    expect(game.unmatched_participants).toBe(0);
    expect(game.complete).toBe(false);
    expect(game.winner == null).toBe(true);
  });

  it("limits first_pick, winner and blue_side_team", async () => {
    await expect(LeagueGame.build(gameRow).validate()).resolves.toBeDefined();
    await expect(
      LeagueGame.build({ ...gameRow, winner: "red", blue_side_team: 2 }).validate(),
    ).resolves.toBeDefined();
    await validationFails(LeagueGame.build({ ...gameRow, first_pick: "green" }));
    await validationFails(LeagueGame.build({ ...gameRow, winner: "green" }));
    await validationFails(LeagueGame.build({ ...gameRow, blue_side_team: 3 }));
  });
});

describe("league mirror associations", () => {
  it("Tournament has many LeagueStages and LeagueSeries, cascading", () => {
    const stages = Tournament.associations.LeagueStages;
    expect(stages.associationType).toBe("HasMany");
    expect(stages.target).toBe(LeagueStage);
    expect(stages.foreignKey).toBe("tournament_id");
    expect(stages.options.onDelete).toBe("CASCADE");

    const series = Tournament.associations.LeagueSeries;
    expect(series.associationType).toBe("HasMany");
    expect(series.target).toBe(LeagueSeries);
    expect(series.foreignKey).toBe("tournament_id");
    expect(series.options.onDelete).toBe("CASCADE");
  });

  it("LeagueStage and LeagueSeries belong to a Tournament", () => {
    for (const model of [LeagueStage, LeagueSeries]) {
      const assoc = model.associations.Tournament;
      expect(assoc.associationType).toBe("BelongsTo");
      expect(assoc.target).toBe(Tournament);
      expect(assoc.foreignKey).toBe("tournament_id");
    }
  });

  it("LeagueStage has many LeagueSeries; a series belongs to its Stage", () => {
    const many = LeagueStage.associations.LeagueSeries;
    expect(many.associationType).toBe("HasMany");
    expect(many.target).toBe(LeagueSeries);
    expect(many.foreignKey).toBe("stage_id");
    expect(many.options.onDelete).toBe("CASCADE");

    const one = LeagueSeries.associations.Stage;
    expect(one.associationType).toBe("BelongsTo");
    expect(one.target).toBe(LeagueStage);
    expect(one.foreignKey).toBe("stage_id");
  });

  it("LeagueSeries belongs to Team1 and Team2, RESTRICT", () => {
    for (const [as, key] of [["Team1", "team1_id"], ["Team2", "team2_id"]]) {
      const assoc = LeagueSeries.associations[as];
      expect(assoc.associationType).toBe("BelongsTo");
      expect(assoc.target).toBe(Team);
      expect(assoc.foreignKey).toBe(key);
      expect(assoc.options.onDelete).toBe("RESTRICT");
    }
  });

  it("LeagueSeries has many Games, cascading; a game belongs to its series", () => {
    const games = LeagueSeries.associations.Games;
    expect(games.associationType).toBe("HasMany");
    expect(games.target).toBe(LeagueGame);
    expect(games.foreignKey).toBe("series_id");
    expect(games.options.onDelete).toBe("CASCADE");

    const series = Object.values(LeagueGame.associations).find((a) => a.target === LeagueSeries);
    expect(series.associationType).toBe("BelongsTo");
    expect(series.target).toBe(LeagueSeries);
    expect(series.foreignKey).toBe("series_id");
  });
});
