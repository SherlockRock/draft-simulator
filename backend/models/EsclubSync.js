const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SYNC_KINDS = ["add", "league", "serie"];
const SYNC_VIAS = ["api", "cli"];
const SYNC_STATUSES = ["running", "succeeded", "failed"];

// Sync log, lock and limits (S2 D3). No associations: the sync code queries
// by id. A partial unique index on status = 'running' allows one running row.
const EsclubSync = sequelize.define(
  "EsclubSync",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    kind: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [SYNC_KINDS] },
    },
    tournament_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "Tournaments", key: "id" },
    },
    stage_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "LeagueStages", key: "id" },
    },
    series_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "LeagueSeries", key: "id" },
    },
    requested_by: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "Users", key: "id" },
    },
    via: {
      type: DataTypes.STRING(8),
      allowNull: false,
      validate: { isIn: [SYNC_VIAS] },
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      validate: { isIn: [SYNC_STATUSES] },
    },
    started_at: { type: DataTypes.DATE, allowNull: false },
    heartbeat_at: { type: DataTypes.DATE, allowNull: false },
    finished_at: { type: DataTypes.DATE, allowNull: true },
    request_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    error_class: { type: DataTypes.STRING(64), allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    summary: { type: DataTypes.JSONB, allowNull: true },
  },
  { tableName: "EsclubSyncs" },
);

module.exports = EsclubSync;
