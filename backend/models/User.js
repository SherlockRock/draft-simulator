const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const User = sequelize.define("User", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    defaultValue: "",
  },
  email: {
    type: DataTypes.STRING,
    defaultValue: "",
  },
  picture: {
    type: DataTypes.STRING,
    defaultValue: "",
  },
  display_name: {
    type: DataTypes.STRING,
    defaultValue: null,
    allowNull: true,
  },
  keyboard_controls: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
});

module.exports = User;
