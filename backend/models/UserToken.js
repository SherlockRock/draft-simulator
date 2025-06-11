const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const UserToken = sequelize.define(
  "UserToken",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      allowNull: false,
      primaryKey: false,
    },
    refresh: {
      type: DataTypes.STRING(1234),
      defaultValue: "",
    },
  },
  {
    indexes: [
      {
        unique: true,
        fields: ["user_id", "refresh"],
      },
    ],
  }
);

module.exports = UserToken;
