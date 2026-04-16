const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const NavigatorEvent = sequelize.define("NavigatorEvent", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  navigator_draft_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: "NavigatorDrafts",
      key: "id",
    },
  },
  event_type: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isIn: [["ban", "pick", "what_if_pick", "what_if_ban", "engine_result"]],
    },
  },
  slot: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  side: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isIn: [["blue", "red"]],
    },
  },
  champion_id: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  user_injected: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
});

module.exports = NavigatorEvent;
