const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const UserToken = sequelize.define("UserToken", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  access: {
    type: DataTypes.STRING(1234),
    defaultValue: "",
  },
  refresh: {
    type: DataTypes.STRING(1234),
    defaultValue: "",
  },
});

module.exports = UserToken;
