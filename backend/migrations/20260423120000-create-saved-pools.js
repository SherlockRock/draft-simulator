"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("SavedPools", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      owner_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      name: {
        type: Sequelize.STRING(120),
        allowNull: false,
      },
      champions: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {
          top: [],
          jungle: [],
          mid: [],
          adc: [],
          support: [],
        },
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex("SavedPools", ["owner_id"], {
      name: "saved_pools_owner_id_idx",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("SavedPools", "saved_pools_owner_id_idx");
    await queryInterface.dropTable("SavedPools");
  },
};
