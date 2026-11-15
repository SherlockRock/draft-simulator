"use strict";

// S3 D1: the provenance of an imported canvas series. A VersusDraft with a
// league_series_id was sent from the esclub league mirror; manual series keep
// NULL. Not unique: the same series can sit on many canvases (design 4.3).
// ON DELETE SET NULL (S2 D14), so purging a tournament's mirror keeps the
// canvas cards; the series becomes a plain manual one.
//
// up: adds the column and a named index. down: drops the index, then the
// column (the FK goes with it). No data is written either way.

const INDEX = "versus_drafts_league_series_id_idx";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        "VersusDrafts",
        "league_series_id",
        {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: "LeagueSeries", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "SET NULL",
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX ${INDEX} ON "VersusDrafts" (league_series_id)`,
        { transaction },
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(`DROP INDEX ${INDEX}`, {
        transaction,
      });
      await queryInterface.removeColumn("VersusDrafts", "league_series_id", {
        transaction,
      });
    });
  },
};
