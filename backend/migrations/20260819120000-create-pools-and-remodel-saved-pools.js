"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "Pools",
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          name: { type: Sequelize.STRING(120), allowNull: false },
          champions: {
            type: Sequelize.JSONB,
            allowNull: false,
            defaultValue: { top: [], jungle: [], mid: [], adc: [], support: [] },
          },
          version: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction },
      );

      // Id-preserving copy: reusing the SavedPool id as the Pool id makes the
      // FK backfill a self-assignment and rollback a straight join.
      await queryInterface.sequelize.query(
        `INSERT INTO "Pools" (id, name, champions, "createdAt", "updatedAt")
         SELECT id, name, champions, "createdAt", "updatedAt" FROM "SavedPools"`,
        { transaction },
      );

      await queryInterface.addColumn(
        "SavedPools",
        "pool_id",
        {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: "Pools", key: "id" },
          onUpdate: "CASCADE",
          onDelete: "CASCADE",
        },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `UPDATE "SavedPools" SET pool_id = id`,
        { transaction },
      );
      await queryInterface.changeColumn(
        "SavedPools",
        "pool_id",
        { type: Sequelize.UUID, allowNull: false },
        { transaction },
      );
      await queryInterface.addIndex("SavedPools", ["pool_id"], {
        name: "saved_pools_pool_id_unique",
        unique: true,
        transaction,
      });

      await queryInterface.removeColumn("SavedPools", "name", { transaction });
      await queryInterface.removeColumn("SavedPools", "champions", {
        transaction,
      });
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        "SavedPools",
        "name",
        { type: Sequelize.STRING(120), allowNull: true },
        { transaction },
      );
      await queryInterface.addColumn(
        "SavedPools",
        "champions",
        { type: Sequelize.JSONB, allowNull: true },
        { transaction },
      );
      await queryInterface.sequelize.query(
        `UPDATE "SavedPools" sp
         SET name = p.name, champions = p.champions
         FROM "Pools" p WHERE p.id = sp.pool_id`,
        { transaction },
      );
      await queryInterface.changeColumn(
        "SavedPools",
        "name",
        { type: Sequelize.STRING(120), allowNull: false },
        { transaction },
      );
      await queryInterface.changeColumn(
        "SavedPools",
        "champions",
        {
          type: Sequelize.JSONB,
          allowNull: false,
          defaultValue: { top: [], jungle: [], mid: [], adc: [], support: [] },
        },
        { transaction },
      );
      await queryInterface.removeIndex(
        "SavedPools",
        "saved_pools_pool_id_unique",
        { transaction },
      );
      await queryInterface.removeColumn("SavedPools", "pool_id", {
        transaction,
      });
      // M2's down already deleted canvas-claimed pool rows; what remains are
      // the saved-entry payloads just copied back.
      await queryInterface.dropTable("Pools", { transaction });
    });
  },
};
