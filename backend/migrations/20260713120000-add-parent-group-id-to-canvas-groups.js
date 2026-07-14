"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    // No DB-level cascade: recursive deletion (promote-up) is handled in
    // application logic in a later slice.
    await queryInterface.addColumn("CanvasGroups", "parent_group_id", {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "CanvasGroups", key: "id" },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("CanvasGroups", "parent_group_id");
  },
};
