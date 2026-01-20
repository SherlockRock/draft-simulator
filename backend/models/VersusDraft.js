const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const crypto = require("crypto");

const VersusDraft = sequelize.define("VersusDraft", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  blueTeamName: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "Blue Team",
  },
  redTeamName: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "Red Team",
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  length: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 3,
    validate: {
      isIn: [[1, 3, 5, 7]],
    },
  },
  competitive: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  icon: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "",
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: "standard",
    validate: {
      isIn: [["standard", "fearless", "ironman"]],
    },
  },
  shareLink: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
    defaultValue: () => crypto.randomBytes(16).toString("hex"),
  },
  owner_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
});

module.exports = VersusDraft;
