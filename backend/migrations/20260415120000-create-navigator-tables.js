"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("NavigatorSessions", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      user_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "Users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      our_side: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      display_pool: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      search_pool: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      opponent_pool: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      fearless: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "setup",
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

    await queryInterface.createTable("NavigatorDrafts", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      session_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "NavigatorSessions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      game_number: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "active",
      },
      draft_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "Drafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
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

    await queryInterface.createTable("NavigatorEvents", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      navigator_draft_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "NavigatorDrafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      event_type: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      slot: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      side: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      champion_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      user_injected: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
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

    await queryInterface.createTable("NavigatorSnapshots", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      navigator_draft_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "NavigatorDrafts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      after_event_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "NavigatorEvents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      pruned_tree: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      scenarios: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      compute_meta: {
        type: Sequelize.JSONB,
        allowNull: true,
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
  },

  async down(queryInterface) {
    await queryInterface.dropTable("NavigatorSnapshots");
    await queryInterface.dropTable("NavigatorEvents");
    await queryInterface.dropTable("NavigatorDrafts");
    await queryInterface.dropTable("NavigatorSessions");
  },
};
