const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const EMPTY_TEAM_POOL = {
  display: { top: [], jungle: [], mid: [], adc: [], support: [] },
  search: [],
};

const NavigatorSession = sequelize.define("NavigatorSession", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "Users", key: "id" },
  },
  our_side: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: { isIn: [["blue", "red"]] },
  },
  blue_pool: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: EMPTY_TEAM_POOL,
  },
  red_pool: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: EMPTY_TEAM_POOL,
  },
  opponent_pool: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  draft_mode: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "standard",
    validate: { isIn: [["standard", "fearless", "ironman"]] },
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "setup",
    validate: { isIn: [["setup", "active", "completed"]] },
  },
  config_version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
});

module.exports = NavigatorSession;
