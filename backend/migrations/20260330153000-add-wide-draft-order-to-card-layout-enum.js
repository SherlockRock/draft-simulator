"use strict";

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TYPE "enum_Canvases_cardLayout" ADD VALUE IF NOT EXISTS \'wide-draft-order\';'
    );
  },

  async down() {
    // PostgreSQL enum values are not removed in down migrations.
  },
};
