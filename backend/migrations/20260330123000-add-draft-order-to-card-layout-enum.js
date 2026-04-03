"use strict";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TYPE "enum_Canvases_cardLayout" ADD VALUE IF NOT EXISTS \'draft-order\';'
    );
  },

  async down() {
    // Postgres enums do not support removing a single value without recreating the type.
  },
};
