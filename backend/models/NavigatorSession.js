const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

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
    references: {
      model: "Users",
      key: "id",
    },
  },
  our_side: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isIn: [["blue", "red"]],
    },
  },
  display_pool: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  search_pool: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  opponent_pool: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  fearless: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "setup",
    validate: {
      isIn: [["setup", "active", "completed"]],
    },
  },
});

module.exports = NavigatorSession;
