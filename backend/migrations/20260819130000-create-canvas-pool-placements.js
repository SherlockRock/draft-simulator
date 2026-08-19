"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "CanvasPoolPlacements",
        {
          id: {
            type: Sequelize.UUID,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          canvas_id: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "Canvases", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
          },
          pool_id: {
            type: Sequelize.UUID,
            allowNull: false,
            unique: true,
            references: { model: "Pools", key: "id" },
            onUpdate: "CASCADE",
            onDelete: "CASCADE",
          },
          positionX: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 50 },
          positionY: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 50 },
          source_id: { type: Sequelize.UUID, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false },
        },
        { transaction },
      );

      await queryInterface.addIndex("CanvasPoolPlacements", ["canvas_id"], {
        name: "canvas_pool_placements_canvas_id_idx",
        transaction,
      });
      // (pool_id UNIQUE comes from the column; source dedupe mirrors
      // canvas_annotations_source_idx.)
      await queryInterface.addIndex(
        "CanvasPoolPlacements",
        ["canvas_id", "source_id"],
        {
          name: "canvas_pool_placements_source_idx",
          unique: true,
          where: { source_id: { [Sequelize.Op.ne]: null } },
          transaction,
        },
      );
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Canvas pools have no other parent and would orphan once the table is
      // gone (design §2) — delete the claimed Pool rows first.
      await queryInterface.sequelize.query(
        `DELETE FROM "Pools" WHERE id IN (SELECT pool_id FROM "CanvasPoolPlacements")`,
        { transaction },
      );
      await queryInterface.removeIndex(
        "CanvasPoolPlacements",
        "canvas_pool_placements_source_idx",
        { transaction },
      );
      await queryInterface.removeIndex(
        "CanvasPoolPlacements",
        "canvas_pool_placements_canvas_id_idx",
        { transaction },
      );
      await queryInterface.dropTable("CanvasPoolPlacements", { transaction });
    });
  },
};
