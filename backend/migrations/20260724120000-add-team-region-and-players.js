"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("Teams", "region", {
      type: Sequelize.STRING(8),
      allowNull: false,
      defaultValue: "na1",
    });

    await queryInterface.createTable("TeamPlayers", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      team_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Teams", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      role: {
        type: Sequelize.ENUM("top", "jungle", "mid", "adc", "support"),
        allowNull: true,
      },
      gameName: { type: Sequelize.STRING(64), allowNull: false },
      tagLine: { type: Sequelize.STRING(16), allowNull: false },
      ordinal: { type: Sequelize.INTEGER, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("TeamPlayers", ["team_id"], {
      name: "team_players_team_id_idx",
    });
    await queryInterface.addConstraint("TeamPlayers", {
      type: "unique",
      fields: ["team_id", "ordinal"],
      name: "team_players_team_ordinal_uq",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint(
      "TeamPlayers",
      "team_players_team_ordinal_uq",
    );
    await queryInterface.removeIndex("TeamPlayers", "team_players_team_id_idx");
    await queryInterface.dropTable("TeamPlayers");
    // Postgres leaves the ENUM type behind after dropTable — drop it so a
    // re-run of up() doesn't collide with an existing "enum_TeamPlayers_role".
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_TeamPlayers_role";',
    );
    await queryInterface.removeColumn("Teams", "region");
  },
};
