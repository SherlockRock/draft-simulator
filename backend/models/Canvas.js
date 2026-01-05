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

const CanvasConnection = sequelize.define("CanvasConnection", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  canvas_id: {
    type: DataTypes.UUID,
    references: { model: Canvas, key: "id" },
  },
  source_draft_ids: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
    comment: "Array of {draft_id: UUID, anchor_type: AnchorType}",
  },
  target_draft_ids: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
    comment: "Array of {draft_id: UUID, anchor_type: AnchorType}",
  },
  vertices: {
    type: DataTypes.JSON,
    allowNull: false,
    defaultValue: [],
    comment: "Array of {id: UUID, x: number, y: number}",
  },
  style: {
    type: DataTypes.ENUM("solid", "dashed", "dotted"),
    defaultValue: "solid",
  },
});

module.exports = {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasShare,
  CanvasConnection,
};
