const { DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

const Draft = sequelize.define("Draft", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  picks: {
    type: DataTypes.ARRAY(Sequelize.TEXT),
    defaultValue: [
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ],
  },
});

module.exports = Draft;
