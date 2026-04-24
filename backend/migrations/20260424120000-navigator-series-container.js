"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn("NavigatorSessions", "series_length", {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      validate: { isIn: [[1, 3, 5, 7]] },
    });

    await queryInterface.addColumn("NavigatorSessions", "side_swap_mode", {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "auto",
      validate: { isIn: [["auto", "manual"]] },
    });

    await queryInterface.addColumn("NavigatorDrafts", "our_side_override", {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isIn: [["blue", "red"]] },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("NavigatorDrafts", "our_side_override");
    await queryInterface.removeColumn("NavigatorSessions", "side_swap_mode");
    await queryInterface.removeColumn("NavigatorSessions", "series_length");
  },
};
