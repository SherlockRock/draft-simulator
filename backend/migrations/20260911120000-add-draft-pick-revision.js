"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        "Drafts",
        "picksVersion",
        {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        "Drafts",
        "lastPickMutationId",
        {
          type: Sequelize.UUID,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn("Drafts", "lastPickMutationId", {
        transaction,
      });
      await queryInterface.removeColumn("Drafts", "picksVersion", {
        transaction,
      });
    });
  },
};
