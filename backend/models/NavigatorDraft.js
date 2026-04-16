const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const NavigatorDraft = sequelize.define("NavigatorDraft", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  session_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: "NavigatorSessions",
      key: "id",
    },
  },
  game_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "active",
    validate: {
      isIn: [["active", "completed"]],
    },
  },
  draft_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: "Drafts",
      key: "id",
    },
  },
});

module.exports = NavigatorDraft;
