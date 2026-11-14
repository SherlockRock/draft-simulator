"use strict";

// The esclub league mirror (S2, D1): LeagueStages, LeagueSeries, LeagueGames.
// Mirror data only; nothing else points at these tables until S3, so `down`
// just drops them (games, then series, then stages).
//
// STRING + CHECK rather than ENUM, as in the Tournaments migration. Every
// constraint and index is named so `down` and the dry run can refer to it.

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const id = {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      };
      const ref = (model, onDelete, allowNull) => ({
        type: Sequelize.UUID,
        allowNull,
        references: { model, key: "id" },
        onUpdate: "CASCADE",
        onDelete,
      });
      const timestamps = {
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      };
      const sql = (text) =>
        queryInterface.sequelize.query(text, { transaction });

      await queryInterface.createTable(
        "LeagueStages",
        {
          id,
          tournament_id: ref("Tournaments", "CASCADE", false),
          // esclub id_event_stage
          external_id: { type: Sequelize.STRING(64), allowNull: false },
          name: { type: Sequelize.STRING(200), allowNull: false },
          // Provenance only: deleting the user keeps the stage.
          added_by: ref("Users", "SET NULL", true),
          last_synced_at: { type: Sequelize.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction },
      );
      await sql(
        `ALTER TABLE "LeagueStages"
           ADD CONSTRAINT league_stages_external_id_uniq UNIQUE (external_id)`,
      );
      await sql(
        `CREATE INDEX league_stages_tournament_id_idx
           ON "LeagueStages" (tournament_id)`,
      );

      await queryInterface.createTable(
        "LeagueSeries",
        {
          id,
          tournament_id: ref("Tournaments", "CASCADE", false),
          stage_id: ref("LeagueStages", "CASCADE", false),
          // esclub id_serie
          external_id: { type: Sequelize.STRING(64), allowNull: false },
          parent_type: { type: Sequelize.STRING(16), allowNull: false },
          number: { type: Sequelize.INTEGER, allowNull: false },
          // Null until the members reply names two rosters. RESTRICT: a team
          // that games point at cannot be deleted.
          team1_id: ref("Teams", "RESTRICT", true),
          team2_id: ref("Teams", "RESTRICT", true),
          best_of: { type: Sequelize.INTEGER, allowNull: false },
          // Null until a game has a draft.
          draft_type: { type: Sequelize.STRING(16), allowNull: true },
          starts_at: { type: Sequelize.DATE, allowNull: true },
          // The raw awaiting_status.
          esclub_status: { type: Sequelize.STRING(32), allowNull: false },
          status: { type: Sequelize.STRING(16), allowNull: false },
          complete: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          finished_at: { type: Sequelize.DATE, allowNull: true },
          last_synced_at: { type: Sequelize.DATE, allowNull: true },
          ...timestamps,
        },
        { transaction },
      );
      await sql(
        `ALTER TABLE "LeagueSeries"
           ADD CONSTRAINT league_series_external_id_uniq UNIQUE (external_id)`,
      );
      await sql(
        `ALTER TABLE "LeagueSeries"
           ADD CONSTRAINT league_series_parent_type_check
           CHECK (parent_type IN ('Group', 'Round'))`,
      );
      await sql(
        `ALTER TABLE "LeagueSeries"
           ADD CONSTRAINT league_series_draft_type_check
           CHECK (draft_type IS NULL OR draft_type IN ('fearless', 'standard'))`,
      );
      await sql(
        `ALTER TABLE "LeagueSeries"
           ADD CONSTRAINT league_series_status_check
           CHECK (status IN ('upcoming', 'in_progress', 'finished'))`,
      );
      await sql(
        `ALTER TABLE "LeagueSeries"
           ADD CONSTRAINT league_series_distinct_teams_check
           CHECK (team1_id IS NULL OR team2_id IS NULL OR team1_id <> team2_id)`,
      );
      for (const column of ["tournament_id", "stage_id", "team1_id", "team2_id"]) {
        await sql(
          `CREATE INDEX league_series_${column}_idx
             ON "LeagueSeries" (${column})`,
        );
      }

      await queryInterface.createTable(
        "LeagueGames",
        {
          id,
          series_id: ref("LeagueSeries", "CASCADE", false),
          // esclub id_match
          external_match_id: { type: Sequelize.STRING(64), allowNull: false },
          number: { type: Sequelize.INTEGER, allowNull: false },
          // 20 slots, the Draft.picks layout.
          picks: { type: Sequelize.ARRAY(Sequelize.TEXT), allowNull: false },
          first_pick: { type: Sequelize.STRING(4), allowNull: false },
          // Which of the two teams of the series played blue (1 or 2).
          blue_side_team: { type: Sequelize.SMALLINT, allowNull: false },
          winner: { type: Sequelize.STRING(4), allowNull: true },
          // champion -> { lane, playerKey, gameName, tagLine }
          participants: {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: {},
          },
          substitutions: {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: [],
          },
          unmatched_participants: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          played_at: { type: Sequelize.DATE, allowNull: true },
          complete: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          ...timestamps,
        },
        { transaction },
      );
      await sql(
        `ALTER TABLE "LeagueGames"
           ADD CONSTRAINT league_games_external_match_id_uniq
           UNIQUE (external_match_id)`,
      );
      await sql(
        `ALTER TABLE "LeagueGames"
           ADD CONSTRAINT league_games_series_number_uniq
           UNIQUE (series_id, number)`,
      );
      await sql(
        `ALTER TABLE "LeagueGames"
           ADD CONSTRAINT league_games_first_pick_check
           CHECK (first_pick IN ('blue', 'red'))`,
      );
      await sql(
        `ALTER TABLE "LeagueGames"
           ADD CONSTRAINT league_games_blue_side_team_check
           CHECK (blue_side_team IN (1, 2))`,
      );
      await sql(
        `ALTER TABLE "LeagueGames"
           ADD CONSTRAINT league_games_winner_check
           CHECK (winner IS NULL OR winner IN ('blue', 'red'))`,
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("LeagueGames", { transaction });
      await queryInterface.dropTable("LeagueSeries", { transaction });
      await queryInterface.dropTable("LeagueStages", { transaction });
    });
  },
};
