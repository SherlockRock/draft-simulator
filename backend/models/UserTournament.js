const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const UserTournament = sequelize.define("UserTournament", {
  user_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    allowNull: false,
    references: { model: "Users", key: "id" },
  },
  tournament_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    allowNull: false,
    references: { model: "Tournaments", key: "id" },
  },
  archived_at: { type: DataTypes.DATE, allowNull: true },
});

module.exports = UserTournament;
