"use strict";

const EMPTY_ROLE_POOL_MAP = {
  top: [],
  jungle: [],
  mid: [],
  adc: [],
  support: [],
};

const EMPTY_TEAM_POOL = {
  display: EMPTY_ROLE_POOL_MAP,
  search: [],
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn("NavigatorSessions", "blue_pool", {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: EMPTY_TEAM_POOL,
    });

    await queryInterface.addColumn("NavigatorSessions", "red_pool", {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: EMPTY_TEAM_POOL,
    });

    await queryInterface.addColumn("NavigatorSessions", "draft_mode", {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "standard",
      validate: { isIn: [["standard", "fearless", "ironman"]] },
    });

    // Migrate existing rows: mirror the old display_pool onto both teams'
    // display.top bucket (intentionally naive — users will review and
    // re-bucket by role via the new editor). Search pool mirrors across both.
    // fearless: true → draft_mode: "fearless"; false → "standard"
    const [sessions] = await queryInterface.sequelize.query(
      `SELECT id, display_pool, search_pool, fearless FROM "NavigatorSessions"`
    );

    for (const row of sessions) {
      const displayPool = Array.isArray(row.display_pool) ? row.display_pool : [];
      const searchPool = Array.isArray(row.search_pool) ? row.search_pool : [];
      const teamPool = {
        display: {
          top: [...displayPool],
          jungle: [],
          mid: [],
          adc: [],
          support: [],
        },
        search: [...searchPool],
      };
      const draftMode = row.fearless ? "fearless" : "standard";

      await queryInterface.sequelize.query(
        `UPDATE "NavigatorSessions" SET blue_pool = :pool, red_pool = :pool, draft_mode = :mode WHERE id = :id`,
        { replacements: { pool: JSON.stringify(teamPool), mode: draftMode, id: row.id } }
      );
    }

    await queryInterface.removeColumn("NavigatorSessions", "display_pool");
    await queryInterface.removeColumn("NavigatorSessions", "search_pool");
    await queryInterface.removeColumn("NavigatorSessions", "fearless");
  },

  async down(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    await queryInterface.addColumn("NavigatorSessions", "display_pool", {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    });
    await queryInterface.addColumn("NavigatorSessions", "search_pool", {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    });
    await queryInterface.addColumn("NavigatorSessions", "fearless", {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    });

    const [sessions] = await queryInterface.sequelize.query(
      `SELECT id, blue_pool, draft_mode FROM "NavigatorSessions"`
    );
    for (const row of sessions) {
      const pool = row.blue_pool || { display: EMPTY_ROLE_POOL_MAP, search: [] };
      const flatDisplay = Object.values(pool.display || {}).flat();
      await queryInterface.sequelize.query(
        `UPDATE "NavigatorSessions" SET display_pool = :dp, search_pool = :sp, fearless = :f WHERE id = :id`,
        {
          replacements: {
            dp: JSON.stringify(flatDisplay),
            sp: JSON.stringify(pool.search || []),
            f: row.draft_mode === "fearless",
            id: row.id,
          },
        }
      );
    }

    await queryInterface.removeColumn("NavigatorSessions", "blue_pool");
    await queryInterface.removeColumn("NavigatorSessions", "red_pool");
    await queryInterface.removeColumn("NavigatorSessions", "draft_mode");
  },
};
