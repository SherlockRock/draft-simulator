const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SIDES = ["blue", "red"];

// One game of a mirrored series. `picks` is the Draft.picks layout (20 slots).
const LeagueGame = sequelize.define(
  "LeagueGame",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    series_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: "LeagueSeries", key: "id" },
    },
    external_match_id: { type: DataTypes.STRING(64), allowNull: false },
    number: { type: DataTypes.INTEGER, allowNull: false },
    picks: { type: DataTypes.ARRAY(DataTypes.TEXT), allowNull: false },
    first_pick: {
      type: DataTypes.STRING(4),
      allowNull: false,
      validate: { isIn: [SIDES] },
    },
    blue_side_team: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      validate: { isIn: [[1, 2]] },
    },
    winner: {
      type: DataTypes.STRING(4),
      allowNull: true,
      validate: { isIn: [SIDES] },
    },
    participants: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    substitutions: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },
    unmatched_participants: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    played_at: { type: DataTypes.DATE, allowNull: true },
    complete: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: "LeagueGames" },
);

module.exports = LeagueGame;
