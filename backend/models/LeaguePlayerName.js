const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Private, tournament-scoped linked Riot names; never included by API queries.
const LeaguePlayerName = sequelize.define("LeaguePlayerName", {
  tournament_id: {
    type: DataTypes.UUID, allowNull: false, primaryKey: true,
    references: { model: "Tournaments", key: "id" }, onDelete: "CASCADE",
  },
  player_key: { type: DataTypes.TEXT, allowNull: false, primaryKey: true },
  game_name: { type: DataTypes.STRING(64), allowNull: true },
  tag_line: { type: DataTypes.STRING(16), allowNull: true },
  checked_at: { type: DataTypes.DATE, allowNull: false },
}, {
  tableName: "LeaguePlayerNames",
  validate: {
    namePair() {
      if ((this.game_name === null) !== (this.tag_line === null)) {
        throw new Error("linked name must have both game_name and tag_line or neither");
      }
    },
  },
});

module.exports = LeaguePlayerName;
