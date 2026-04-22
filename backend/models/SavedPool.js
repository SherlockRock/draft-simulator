const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const EMPTY_ROLE_POOL_MAP = {
  top: [],
  jungle: [],
  mid: [],
  adc: [],
  support: [],
};

const SavedPool = sequelize.define("SavedPool", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  owner_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: "Users", key: "id" },
  },
  name: {
    type: DataTypes.STRING(120),
    allowNull: false,
    validate: {
      notEmpty: true,
      len: [1, 120],
    },
  },
  champions: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: EMPTY_ROLE_POOL_MAP,
  },
});

module.exports = SavedPool;
