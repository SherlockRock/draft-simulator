"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "Tournaments",
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          name: { type: Sequelize.STRING(200), allowNull: false },
          // STRING + CHECK rather than an ENUM: a new source is a one-line
          // constraint change, not an ENUM migration.
          source: {
            type: Sequelize.STRING(16),
            allowNull: false,
            defaultValue: "manual",
          },
          // esclub season id (id_event_active); null for manual tournaments.
          external_id: { type: Sequelize.STRING(64), allowNull: true },
          // The allowed set is enforced in code (VALID_REGIONS in routes/teams.js).
          region: {
            type: Sequelize.STRING(8),
            allowNull: false,
            defaultValue: "na1",
          },
          starts_at: { type: Sequelize.DATE, allowNull: true },
          ends_at: { type: Sequelize.DATE, allowNull: true },
          // Provenance only: deleting the creator keeps the tournament.
          created_by: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: "Users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "SET NULL",
          },
          archived_at: { type: Sequelize.DATE, allowNull: true },
          last_synced_at: { type: Sequelize.DATE, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "Tournaments"
           ADD CONSTRAINT tournaments_source_check
           CHECK (source IN ('manual', 'esclub'))`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX tournaments_source_external_id_uniq
           ON "Tournaments" (source, external_id)
           WHERE external_id IS NOT NULL`,
        { transaction },
      );

      await queryInterface.createTable(
        "UserTournaments",
        {
          user_id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            references: { model: "Users", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
          },
          tournament_id: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            references: { model: "Tournaments", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
          },
          archived_at: { type: Sequelize.DATE, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("UserTournaments", { transaction });
      await queryInterface.dropTable("Tournaments", { transaction });
    });
  },
};
