"use strict";

// Sync log, cross-process lock and daily request budget for the esclub sync
// (S2 D3). Runs after 20261113120000-create-league-mirror, whose LeagueStages
// and LeagueSeries tables the log references.

function parentColumn(model) {
  return (Sequelize) => ({
    type: Sequelize.UUID,
    allowNull: true,
    references: { model, key: "id" },
    onUpdate: "CASCADE",
    // The log outlives a purge of what it synced.
    onDelete: "SET NULL",
  });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "EsclubSyncs",
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          // STRING + CHECK rather than an ENUM, as Tournaments.source.
          kind: { type: Sequelize.STRING(16), allowNull: false },
          tournament_id: parentColumn("Tournaments")(Sequelize),
          stage_id: parentColumn("LeagueStages")(Sequelize),
          series_id: parentColumn("LeagueSeries")(Sequelize),
          requested_by: parentColumn("Users")(Sequelize),
          via: { type: Sequelize.STRING(8), allowNull: false },
          status: { type: Sequelize.STRING(16), allowNull: false },
          started_at: { type: Sequelize.DATE, allowNull: false },
          heartbeat_at: { type: Sequelize.DATE, allowNull: false },
          finished_at: { type: Sequelize.DATE, allowNull: true },
          request_count: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          error_class: { type: Sequelize.STRING(64), allowNull: true },
          error_message: { type: Sequelize.TEXT, allowNull: true },
          // Counts only (series seen, written, skipped, games, failed).
          summary: { type: Sequelize.JSONB, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction },
      );

      const statements = [
        `ALTER TABLE "EsclubSyncs"
           ADD CONSTRAINT esclub_syncs_kind_check
           CHECK (kind IN ('add', 'league', 'serie'))`,
        `ALTER TABLE "EsclubSyncs"
           ADD CONSTRAINT esclub_syncs_via_check
           CHECK (via IN ('api', 'cli'))`,
        `ALTER TABLE "EsclubSyncs"
           ADD CONSTRAINT esclub_syncs_status_check
           CHECK (status IN ('running', 'succeeded', 'failed'))`,
      ];
      for (const sql of statements) {
        await queryInterface.sequelize.query(sql, { transaction });
      }

      // The lock: at most one running row in the whole table, so "one sync
      // at a time" holds across processes.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX esclub_syncs_one_running
           ON "EsclubSyncs" (status)
           WHERE status = 'running'`,
        { transaction },
      );

      // Cooldown and per-user limit lookups.
      const indexes = [
        `CREATE INDEX esclub_syncs_tournament_kind_finished_idx
           ON "EsclubSyncs" (tournament_id, kind, finished_at)`,
        `CREATE INDEX esclub_syncs_series_kind_finished_idx
           ON "EsclubSyncs" (series_id, kind, finished_at)`,
        `CREATE INDEX esclub_syncs_requester_kind_started_idx
           ON "EsclubSyncs" (requested_by, kind, started_at)`,
      ];
      for (const sql of indexes) {
        await queryInterface.sequelize.query(sql, { transaction });
      }

      await queryInterface.createTable(
        "EsclubDailyUsage",
        {
          // UTC date.
          day: {
            type: Sequelize.DATEONLY,
            allowNull: false,
            primaryKey: true,
          },
          request_count: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "EsclubDailyUsage"
           ADD CONSTRAINT esclub_daily_usage_request_count_check
           CHECK (request_count >= 0)`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("EsclubDailyUsage", { transaction });
      await queryInterface.dropTable("EsclubSyncs", { transaction });
    });
  },
};
