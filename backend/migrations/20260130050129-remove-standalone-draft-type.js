"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Convert existing standalone drafts to canvas
    await queryInterface.sequelize.query(
      `UPDATE "Drafts" SET "type" = 'canvas' WHERE "type" = 'standalone'`
    );
    // Change default value
    await queryInterface.changeColumn("Drafts", "type", {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "canvas",
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn("Drafts", "type", {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: "standalone",
    });
  },
};
