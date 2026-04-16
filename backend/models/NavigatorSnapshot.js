const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const NavigatorSnapshot = sequelize.define("NavigatorSnapshot", {
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
  after_event_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: "NavigatorEvents",
      key: "id",
    },
  },
  pruned_tree: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  scenarios: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  compute_meta: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
});

module.exports = NavigatorSnapshot;
