"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Helper: skip table creation if it already exists (safe for existing prod DB)
    async function createIfNotExists(tableName, attributes, options = {}) {
      const tableExists = await queryInterface.sequelize.query(
        `SELECT to_regclass('"${tableName}"') AS t`,
        { type: Sequelize.QueryTypes.SELECT }
      );
      if (tableExists[0].t) {
        console.log(`Table "${tableName}" already exists, skipping.`);
        return;
      }
      await queryInterface.createTable(tableName, attributes, options);
    }

    // 1. Users
    await createIfNotExists("Users", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      name: { type: Sequelize.STRING, defaultValue: "" },
      email: { type: Sequelize.STRING, defaultValue: "" },
      picture: { type: Sequelize.STRING, defaultValue: "" },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 2. UserTokens
    await createIfNotExists("UserTokens", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      refresh: { type: Sequelize.STRING(1234), defaultValue: "" },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // UserTokens unique index
    const userTokenIndexes = await queryInterface.showIndex("UserTokens").catch(() => []);
    const hasUserTokenUniqueIndex = userTokenIndexes.some(
      (idx) => idx.unique && idx.fields.some((f) => f.attribute === "user_id") && idx.fields.some((f) => f.attribute === "refresh")
    );
    if (!hasUserTokenUniqueIndex) {
      await queryInterface.addIndex("UserTokens", ["user_id", "refresh"], {
        unique: true,
        name: "user_tokens_user_id_refresh_unique",
      });
    }

    // 3. VersusDrafts
    await createIfNotExists("VersusDrafts", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      name: { type: Sequelize.STRING, allowNull: false },
      blueTeamName: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "Team 1",
      },
      redTeamName: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "Team 2",
      },
      description: { type: Sequelize.TEXT, allowNull: true },
      length: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 3,
      },
      competitive: { type: Sequelize.BOOLEAN, defaultValue: false },
      icon: { type: Sequelize.TEXT, allowNull: false, defaultValue: "" },
      type: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "standard",
      },
      shareLink: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      disabledChampions: {
        type: Sequelize.ARRAY(Sequelize.TEXT),
        defaultValue: [],
      },
      owner_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 4. VersusParticipants
    await createIfNotExists("VersusParticipants", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      versus_draft_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "VersusDrafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      role: { type: Sequelize.STRING, allowNull: false },
      lastSeenAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
      reclaimToken: { type: Sequelize.STRING, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 5. Canvases
    await createIfNotExists("Canvases", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      name: { type: Sequelize.STRING, defaultValue: "New Draft" },
      description: {
        type: Sequelize.TEXT,
        allowNull: false,
        defaultValue: "",
      },
      icon: { type: Sequelize.TEXT, allowNull: false, defaultValue: "" },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 6. UserCanvases (composite PK)
    await createIfNotExists("UserCanvases", {
      user_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      canvas_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        references: { model: "Canvases", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      lastViewportX: { type: Sequelize.FLOAT, defaultValue: 0 },
      lastViewportY: { type: Sequelize.FLOAT, defaultValue: 0 },
      lastZoomLevel: { type: Sequelize.FLOAT, defaultValue: 1 },
      lastAccessedAt: { type: Sequelize.DATE, defaultValue: Sequelize.NOW },
      permissions: {
        type: Sequelize.ENUM("view", "edit", "admin"),
        defaultValue: "view",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 7. CanvasShares
    await createIfNotExists("CanvasShares", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      access_level: {
        type: Sequelize.ENUM("viewer", "editor"),
        defaultValue: "viewer",
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      canvas_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Canvases", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 8. Drafts
    await createIfNotExists("Drafts", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      name: { type: Sequelize.STRING, defaultValue: "New Draft" },
      public: { type: Sequelize.BOOLEAN, defaultValue: true },
      type: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "canvas",
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: false,
        defaultValue: "",
      },
      icon: { type: Sequelize.TEXT, allowNull: false, defaultValue: "" },
      picks: {
        type: Sequelize.ARRAY(Sequelize.TEXT),
        defaultValue: Array(20).fill(""),
      },
      versus_draft_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "VersusDrafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      seriesIndex: { type: Sequelize.INTEGER, allowNull: true },
      completed: { type: Sequelize.BOOLEAN, defaultValue: false },
      completedAt: { type: Sequelize.DATE, allowNull: true },
      winner: { type: Sequelize.STRING, allowNull: true },
      firstPick: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "blue",
      },
      blueSideTeam: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
      },
      owner_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 9. DraftShares
    await createIfNotExists("DraftShares", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      access_level: {
        type: Sequelize.ENUM("viewer", "editor"),
        defaultValue: "viewer",
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      draft_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Drafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 10. CanvasGroups
    await createIfNotExists("CanvasGroups", {
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
      name: { type: Sequelize.STRING, allowNull: false },
      type: {
        type: Sequelize.ENUM("series", "custom"),
        defaultValue: "series",
      },
      positionX: { type: Sequelize.FLOAT, defaultValue: 50 },
      positionY: { type: Sequelize.FLOAT, defaultValue: 50 },
      width: { type: Sequelize.FLOAT, allowNull: true },
      height: { type: Sequelize.FLOAT, allowNull: true },
      versus_draft_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "VersusDrafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      metadata: { type: Sequelize.JSONB, defaultValue: {} },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // 11. CanvasDrafts
    await createIfNotExists("CanvasDrafts", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      draft_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Drafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      canvas_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "Canvases", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      positionX: { type: Sequelize.FLOAT, defaultValue: 50 },
      positionY: { type: Sequelize.FLOAT, defaultValue: 50 },
      is_locked: { type: Sequelize.BOOLEAN, defaultValue: false },
      group_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "CanvasGroups", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      source_type: {
        type: Sequelize.ENUM("canvas", "versus"),
        defaultValue: "canvas",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // CanvasDrafts unique index
    const canvasDraftIndexes = await queryInterface.showIndex("CanvasDrafts").catch(() => []);
    const hasCanvasDraftUniqueIndex = canvasDraftIndexes.some(
      (idx) => idx.unique && idx.fields.some((f) => f.attribute === "draft_id") && idx.fields.some((f) => f.attribute === "canvas_id")
    );
    if (!hasCanvasDraftUniqueIndex) {
      await queryInterface.addIndex("CanvasDrafts", ["draft_id", "canvas_id"], {
        unique: true,
        name: "unique_draft_canvas",
      });
    }

    // 12. CanvasConnections
    await createIfNotExists("CanvasConnections", {
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
      source_draft_ids: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: [],
      },
      target_draft_ids: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: [],
      },
      vertices: {
        type: Sequelize.JSON,
        allowNull: false,
        defaultValue: [],
      },
      style: {
        type: Sequelize.ENUM("solid", "dashed", "dotted"),
        defaultValue: "solid",
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    // Drop tables in reverse FK dependency order
    await queryInterface.dropTable("CanvasConnections");
    await queryInterface.dropTable("CanvasDrafts");
    await queryInterface.dropTable("CanvasGroups");
    await queryInterface.dropTable("DraftShares");
    await queryInterface.dropTable("Drafts");
    await queryInterface.dropTable("CanvasShares");
    await queryInterface.dropTable("UserCanvases");
    await queryInterface.dropTable("Canvases");
    await queryInterface.dropTable("VersusParticipants");
    await queryInterface.dropTable("VersusDrafts");
    await queryInterface.dropTable("UserTokens");
    await queryInterface.dropTable("Users");

    // Clean up PostgreSQL ENUM types created by Sequelize
    const enumTypes = [
      "enum_UserCanvases_permissions",
      "enum_CanvasShares_access_level",
      "enum_DraftShares_access_level",
      "enum_CanvasGroups_type",
      "enum_CanvasDrafts_source_type",
      "enum_CanvasConnections_style",
    ];
    for (const enumType of enumTypes) {
      await queryInterface.sequelize.query(
        `DROP TYPE IF EXISTS "${enumType}" CASCADE`
      );
    }
  },
};
