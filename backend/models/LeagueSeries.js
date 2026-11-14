const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PARENT_TYPES = ["Group", "Round"];
const DRAFT_TYPES = ["fearless", "standard"];
const SERIES_STATUSES = ["upcoming", "in_progress", "finished"];

// One esclub serie (id_serie): a best-of-N between two rosters.
const LeagueSeries = sequelize.define(
  "LeagueSeries",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tournament_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "Tournaments", key: "id" },
    },
    stage_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "LeagueStages", key: "id" },
    },
    external_id: { type: DataTypes.STRING(64), allowNull: false },
    parent_type: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [PARENT_TYPES] },
    },
    number: { type: DataTypes.INTEGER, allowNull: false },
    team1_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "Teams", key: "id" },
    },
    team2_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "Teams", key: "id" },
    },
    best_of: { type: DataTypes.INTEGER, allowNull: false },
    draft_type: {
      type: DataTypes.STRING(16),
      allowNull: true,
      validate: { isIn: [DRAFT_TYPES] },
    },
    starts_at: { type: DataTypes.DATE, allowNull: true },
    esclub_status: { type: DataTypes.STRING(32), allowNull: false },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [SERIES_STATUSES] },
    },
    complete: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    finished_at: { type: DataTypes.DATE, allowNull: true },
    last_synced_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "LeagueSeries" },
);

module.exports = LeagueSeries;
