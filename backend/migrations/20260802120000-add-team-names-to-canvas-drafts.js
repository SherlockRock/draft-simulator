"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("CanvasDrafts", "team1Name", {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn("CanvasDrafts", "team2Name", {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("CanvasDrafts", "team1Name");
    await queryInterface.removeColumn("CanvasDrafts", "team2Name");
  },
};
