const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const VersusParticipant = sequelize.define("VersusParticipant", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  versus_draft_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: "VersusDrafts",
      key: "id",
    },
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: "Users",
      key: "id",
    },
  },
  role: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isIn: [["blue_captain", "red_captain", "spectator"]],
    },
  },
  lastSeenAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  reclaimToken: {
    type: DataTypes.STRING,
    allowNull: true,
  },
});

// Unique constraint on (versus_draft_id, role) for captain roles only
// This is enforced at the application level in the handlers

module.exports = VersusParticipant;
