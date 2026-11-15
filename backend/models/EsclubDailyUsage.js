const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Requests sent to esclub per UTC day (S2 D3 budget).
const EsclubDailyUsage = sequelize.define(
  "EsclubDailyUsage",
  {
    day: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      primaryKey: true,
    },
    request_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
  },
  { tableName: "EsclubDailyUsage", freezeTableName: true },
);

module.exports = EsclubDailyUsage;
