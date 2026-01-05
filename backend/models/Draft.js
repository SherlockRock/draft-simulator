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
    defaultValue: "standalone",
    allowNull: false,
    validate: {
      isIn: [["canvas", "standalone", "versus"]],
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
});

module.exports = Draft;
