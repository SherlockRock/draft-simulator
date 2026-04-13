"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("VersusDrafts", "origin", {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "live",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("VersusDrafts", "origin");
  },
};
