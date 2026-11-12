"use strict";

// up: adds the tournament columns to Teams, makes owner_id nullable (its FK
// and ON DELETE CASCADE stay), and adds two CHECKs, two partial unique indexes
// and a plain index. Existing rows take the defaults: source = 'manual',
// tournament_id = NULL, so every existing team becomes a pickup team with the
// same owner and roster. No other data is written.
//
// down: refuses (throws, changes nothing) if any team has source = 'esclub',
// owner_id IS NULL or a tournament_id: the old shape cannot hold the first two
// and would silently lose the third (branch review M1). Otherwise
// it reverses up: drops the indexes and constraints, restores owner_id NOT NULL
// and removes the columns.

const SOURCE_CHECK = "teams_source_check";
const NO_OWNER_CHECK = "teams_esclub_no_owner_check";
const EXTERNAL_ID_INDEX = "teams_tournament_external_id_uniq";
const NAME_INDEX = "teams_tournament_name_manual_uniq";
const TOURNAMENT_INDEX = "teams_tournament_id_idx";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        "Teams",
        "tournament_id",
        {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: "Tournaments", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "RESTRICT",
        },
        { transaction },
      );
      // STRING + CHECK rather than an ENUM: a new source is a one-line
      // constraint change, not an ENUM migration.
      await queryInterface.addColumn(
        "Teams",
        "source",
        {
          type: Sequelize.STRING(16),
          allowNull: false,
          defaultValue: "manual",
        },
        { transaction },
      );
      // esclub id_team_roster
      await queryInterface.addColumn(
        "Teams",
        "external_id",
        { type: Sequelize.STRING(64), allowNull: true },
        { transaction },
      );
      // esclub id_team_organisation
      await queryInterface.addColumn(
        "Teams",
        "external_org_id",
        { type: Sequelize.STRING(64), allowNull: true },
        { transaction },
      );
      await queryInterface.addColumn(
        "Teams",
        "acronym",
        { type: Sequelize.STRING(16), allowNull: true },
        { transaction },
      );
      // { primary, secondary }
      await queryInterface.addColumn(
        "Teams",
        "colors",
        { type: Sequelize.JSONB, allowNull: true },
        { transaction },
      );
      // Pickup teams only (global archive).
      await queryInterface.addColumn(
        "Teams",
        "archived_at",
        { type: Sequelize.DATE, allowNull: true },
        { transaction },
      );

      // Raw ALTER rather than changeColumn: on Postgres changeColumn with
      // `references` can drop and re-add the FK. This touches nullability only,
      // so owner_id keeps its FK and ON DELETE CASCADE.
      await queryInterface.sequelize.query(
        `ALTER TABLE "Teams" ALTER COLUMN "owner_id" DROP NOT NULL`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `ALTER TABLE "Teams"
           ADD CONSTRAINT ${SOURCE_CHECK}
           CHECK (source IN ('manual', 'esclub'))`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "Teams"
           ADD CONSTRAINT ${NO_OWNER_CHECK}
           CHECK (source <> 'esclub' OR owner_id IS NULL)`,
        { transaction },
      );

      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX ${EXTERNAL_ID_INDEX}
           ON "Teams" (tournament_id, external_id)
           WHERE external_id IS NOT NULL`,
        { transaction },
      );
      // Expression index, so raw SQL: manual team names are unique per
      // tournament, case-insensitively. Imported names are not constrained.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX ${NAME_INDEX}
           ON "Teams" (tournament_id, lower(name))
           WHERE tournament_id IS NOT NULL AND source = 'manual'`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX ${TOURNAMENT_INDEX} ON "Teams" (tournament_id)`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const rows = await queryInterface.sequelize.query(
        `SELECT id FROM "Teams"
           WHERE source = 'esclub' OR owner_id IS NULL
              OR tournament_id IS NOT NULL
           LIMIT 1`,
        { type: "SELECT", transaction },
      );
      if (rows && rows.length > 0) {
        throw new Error(
          "Cannot reverse add-team-tournament-columns: Teams has rows with " +
            "source = 'esclub', owner_id IS NULL or a tournament_id, which the " +
            "old schema cannot hold. Delete or reassign them first.",
        );
      }

      await queryInterface.sequelize.query(`DROP INDEX ${TOURNAMENT_INDEX}`, {
        transaction,
      });
      await queryInterface.sequelize.query(`DROP INDEX ${NAME_INDEX}`, {
        transaction,
      });
      await queryInterface.sequelize.query(`DROP INDEX ${EXTERNAL_ID_INDEX}`, {
        transaction,
      });
      await queryInterface.sequelize.query(
        `ALTER TABLE "Teams" DROP CONSTRAINT ${NO_OWNER_CHECK}`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "Teams" DROP CONSTRAINT ${SOURCE_CHECK}`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `ALTER TABLE "Teams" ALTER COLUMN "owner_id" SET NOT NULL`,
        { transaction },
      );

      for (const column of [
        "archived_at",
        "colors",
        "acronym",
        "external_org_id",
        "external_id",
        "source",
        "tournament_id",
      ]) {
        await queryInterface.removeColumn("Teams", column, { transaction });
      }
    });
  },
};
