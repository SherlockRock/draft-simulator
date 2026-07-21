"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("Teams", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      owner_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      name: { type: Sequelize.STRING(120), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex("Teams", ["owner_id"], {
      name: "teams_owner_id_idx",
    });

    await queryInterface.addColumn("CanvasGroups", "team1_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "Teams", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });
    await queryInterface.addColumn("CanvasGroups", "team2_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "Teams", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("CanvasGroups", "team2_id");
    await queryInterface.removeColumn("CanvasGroups", "team1_id");
    await queryInterface.removeIndex("Teams", "teams_owner_id_idx");
    await queryInterface.dropTable("Teams");
  },
};
