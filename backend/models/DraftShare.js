const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DraftShare = sequelize.define("DraftShare", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  access_level: {
    type: DataTypes.ENUM("viewer", "editor"),
    defaultValue: "viewer",
  },
});

module.exports = DraftShare;
