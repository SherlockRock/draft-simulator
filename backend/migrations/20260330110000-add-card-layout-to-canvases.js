"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable("Canvases");
    if (!table.cardLayout) {
      await queryInterface.addColumn("Canvases", "cardLayout", {
        type: Sequelize.ENUM("vertical", "horizontal", "wide", "compact", "draft-order"),
        allowNull: false,
        defaultValue: "vertical",
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable("Canvases");
    if (table.cardLayout) {
      await queryInterface.removeColumn("Canvases", "cardLayout");
    }
  },
};
