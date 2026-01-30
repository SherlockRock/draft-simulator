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
  type: {
    type: DataTypes.STRING,
    defaultValue: "canvas",
    allowNull: false,
    validate: {
      isIn: [["canvas", "versus"]],
    },
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "",
  },
  icon: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: "",
  },
  // Future: Folder support per canvas
  // parent_folder_id: {
  //   type: DataTypes.UUID,
  //   allowNull: true,
  //   references: { model: 'Folders', key: 'id' },
  // },
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
  versus_draft_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: "VersusDrafts",
      key: "id",
    },
  },
  seriesIndex: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  completed: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  winner: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: {
      isIn: [["blue", "red", null]],
    },
  },
});

module.exports = Draft;
