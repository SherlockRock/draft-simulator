const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const TeamPlayer = sequelize.define("TeamPlayer", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  team_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: "Teams", key: "id" },
  },
  role: {
    type: DataTypes.ENUM("top", "jungle", "mid", "adc", "support"),
    allowNull: true,
  },
  gameName: {
    type: DataTypes.STRING(64),
    allowNull: false,
    validate: { notEmpty: true, len: [1, 64] },
  },
  tagLine: {
    type: DataTypes.STRING(16),
    allowNull: false,
    validate: { notEmpty: true, len: [1, 16] },
  },
  ordinal: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
});

module.exports = TeamPlayer;
