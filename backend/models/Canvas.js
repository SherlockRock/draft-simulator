const { DataTypes } = require("sequelize");
const User = require("./User");
const Draft = require("./Draft");
const sequelize = require("../config/database");

const Canvas = sequelize.define("Canvas", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    defaultValue: "New Draft",
  },
});

const UserCanvas = sequelize.define("UserCanvas", {
  user_id: {
    type: DataTypes.UUID,
    references: { model: User, key: "id" },
  },
  canvas_id: {
    type: DataTypes.UUID,
    references: { model: Canvas, key: "id" },
  },
  lastViewportX: { type: DataTypes.FLOAT, defaultValue: 0 },
  lastViewportY: { type: DataTypes.FLOAT, defaultValue: 0 },
  lastZoomLevel: { type: DataTypes.FLOAT, defaultValue: 1 },
  lastAccessedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  permissions: {
    type: DataTypes.ENUM("view", "edit", "admin"),
    defaultValue: "view",
  },
});

const CanvasDraft = sequelize.define("CanvasDraft", {
  draft_id: {
    type: DataTypes.UUID,
    references: { model: Draft, key: "id" },
  },
  canvas_id: {
    type: DataTypes.UUID,
    references: { model: Canvas, key: "id" },
  },
  positionX: { type: DataTypes.FLOAT, defaultValue: 50 },
  positionY: { type: DataTypes.FLOAT, defaultValue: 50 },
});

const CanvasShare = sequelize.define("CanvasShare", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  access_level: {
    type: DataTypes.ENUM("viewer", "editor"),
    defaultValue: "viewer",
  },
});

module.exports = { Canvas, UserCanvas, CanvasDraft, CanvasShare };
