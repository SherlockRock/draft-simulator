const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Pure parent link (design §1.2): entry = (owner, pool). Payload lives on the
// Pools row; UNIQUE pool_id is the no-aliasing invariant (D1) at the DB.
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
  pool_id: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
    references: { model: "Pools", key: "id" },
  },
});

module.exports = SavedPool;
