"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable("LeaguePlayerNames", {
        tournament_id: {
          type: Sequelize.UUID, allowNull: false, primaryKey: true,
          references: { model: "Tournaments", key: "id" }, onDelete: "CASCADE",
        },
        player_key: { type: Sequelize.TEXT, allowNull: false, primaryKey: true },
        game_name: { type: Sequelize.STRING(64), allowNull: true },
        tag_line: { type: Sequelize.STRING(16), allowNull: true },
        checked_at: { type: Sequelize.DATE, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      }, { transaction });
      await queryInterface.sequelize.query(
        'ALTER TABLE "LeaguePlayerNames" ADD CONSTRAINT league_player_names_name_pair CHECK ((game_name IS NULL) = (tag_line IS NULL))',
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable("LeaguePlayerNames");
  },
};
