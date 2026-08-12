"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("CanvasAnnotations", {
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
      group_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "CanvasGroups", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      positionX: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 50 },
      positionY: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 50 },
      width: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 380 },
      height: { type: Sequelize.FLOAT, allowNull: false, defaultValue: 120 },
      manualWidth: { type: Sequelize.FLOAT, allowNull: true },
      manualHeight: { type: Sequelize.FLOAT, allowNull: true },
      source_id: { type: Sequelize.UUID, allowNull: true },
      text: { type: Sequelize.TEXT, allowNull: false, defaultValue: "" },
      championIds: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      color: {
        type: Sequelize.ENUM(
          "none",
          "slate",
          "purple",
          "teal",
          "amber",
          "crimson",
          "emerald",
        ),
        allowNull: false,
        defaultValue: "slate",
      },
      fontSize: {
        type: Sequelize.ENUM("sm", "md", "lg", "xl"),
        allowNull: false,
        defaultValue: "md",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // Every read is "the annotations on this canvas"; the group index serves
    // the container-contents queries the delete branches and sizing paths run.
    await queryInterface.addIndex("CanvasAnnotations", ["canvas_id"], {
      name: "canvas_annotations_canvas_id_idx",
    });
    await queryInterface.addIndex("CanvasAnnotations", ["group_id"], {
      name: "canvas_annotations_group_id_idx",
    });
    // Import dedupe key (design D15). UNIQUE so a repeat import cannot create a
    // second copy even if the application check races, and scoped to the canvas
    // so the same export can be imported into two canvases — which reusing the
    // export's `id` as the PK would have made impossible.
    await queryInterface.addIndex("CanvasAnnotations", ["canvas_id", "source_id"], {
      name: "canvas_annotations_source_idx",
      unique: true,
      where: { source_id: { [Sequelize.Op.ne]: null } },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      "CanvasAnnotations",
      "canvas_annotations_source_idx",
    );
    await queryInterface.removeIndex(
      "CanvasAnnotations",
      "canvas_annotations_group_id_idx",
    );
    await queryInterface.removeIndex(
      "CanvasAnnotations",
      "canvas_annotations_canvas_id_idx",
    );
    await queryInterface.dropTable("CanvasAnnotations");
    // Postgres keeps the enum types behind after dropTable; a re-run of `up`
    // then fails with "type already exists".
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_CanvasAnnotations_color";',
    );
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_CanvasAnnotations_fontSize";',
    );
  },
};
