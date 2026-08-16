"use strict";

/**
 * Inline-champions amendment (design §6–§7): champions live as @[Name]
 * tokens inside `text`; the strip column goes. The maintainer chose to
 * retype their test notes rather than shim (2026-08-16), so `down` restores
 * the column but not its data.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn("CanvasAnnotations", "championIds");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("CanvasAnnotations", "championIds", {
      type: Sequelize.JSONB,
      allowNull: false,
      defaultValue: [],
    });
  },
};
