const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// One esclub stage (id_event_stage) of a mirrored league.
const LeagueStage = sequelize.define(
  "LeagueStage",
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
    external_id: { type: DataTypes.STRING(64), allowNull: false },
    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
      validate: { notEmpty: true, len: [1, 200] },
    },
    added_by: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: "Users", key: "id" },
    },
    last_synced_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: "LeagueStages" },
);

module.exports = LeagueStage;
