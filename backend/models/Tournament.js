const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { TEAM_REGIONS } = require("../utils/teamRegions");

const TOURNAMENT_SOURCES = ["manual", "esclub"];

const Tournament = sequelize.define("Tournament", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING(200),
    allowNull: false,
    validate: { notEmpty: true, len: [1, 200] },
  },
  source: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: "manual",
    validate: { isIn: [TOURNAMENT_SOURCES] },
  },
  external_id: {
    type: DataTypes.STRING(64),
    allowNull: true,
  },
  region: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: "na1",
    validate: { isIn: [TEAM_REGIONS] },
  },
  starts_at: { type: DataTypes.DATE, allowNull: true },
  ends_at: { type: DataTypes.DATE, allowNull: true },
  created_by: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "Users", key: "id" },
  },
  archived_at: { type: DataTypes.DATE, allowNull: true },
  last_synced_at: { type: DataTypes.DATE, allowNull: true },
});

module.exports = Tournament;
