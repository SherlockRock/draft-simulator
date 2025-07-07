const { DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/database");

const Draft = sequelize.define("Draft", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    defaultValue: "New Draft",
  },
  public: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
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
