const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const EMPTY_ROLE_POOL_MAP = {
  top: [],
  jungle: [],
  mid: [],
  adc: [],
  support: [],
};

// The inert pool payload (design D1/§1.1). No owner or canvas column: exactly
// one parent (SavedPool entry XOR CanvasPoolPlacement) claims a row via its own
// pool_id FK, and deletion always targets THIS row — the parent link cascades.
const Pool = sequelize.define("Pool", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
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
  // Champions revision (design §4.3): bumped ONLY by gate champion ops, inside
  // their row lock. Receivers drop poolUpdate broadcasts with a stale version
  // — post-commit emits can interleave out of commit order.
  version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
});

module.exports = Pool;
