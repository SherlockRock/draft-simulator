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
  cardLayout: {
    type: DataTypes.ENUM("vertical", "horizontal", "wide", "wide-draft-order", "compact", "draft-order"),
    allowNull: false,
    defaultValue: "wide",
  },
});

const UserCanvas = sequelize.define("UserCanvas", {
  user_id: {
    type: DataTypes.UUID,
    primaryKey: true,
    references: { model: User, key: "id" },
  },
  canvas_id: {
    type: DataTypes.UUID,
    primaryKey: true,
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
  is_locked: { type: DataTypes.BOOLEAN, defaultValue: false },
  group_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "CanvasGroups", key: "id" },
  },
  source_type: {
    type: DataTypes.ENUM("canvas", "versus"),
    defaultValue: "canvas",
  },
  // Display-only labels for this card on this canvas. Deliberately NOT on
  // Draft: live series cards point at the VersusDraft's own Draft rows, and
  // CanvasDraft is a plain join table, so a per-Draft field would mutate the
  // live versus game and leak across every canvas showing that draft.
  team1Name: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
  team2Name: { type: DataTypes.STRING, allowNull: true, defaultValue: null },
}, {
  indexes: [
    {
      unique: true,
      fields: ['draft_id', 'canvas_id'],
      name: 'unique_draft_canvas'
    }
  ]
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

const CanvasGroup = sequelize.define("CanvasGroup", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  canvas_id: {
    type: DataTypes.UUID,
    references: { model: Canvas, key: "id" },
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM("series", "custom"),
    defaultValue: "series",
  },
  positionX: { type: DataTypes.FLOAT, defaultValue: 50 },
  positionY: { type: DataTypes.FLOAT, defaultValue: 50 },
  width: { type: DataTypes.FLOAT, allowNull: true },
  height: { type: DataTypes.FLOAT, allowNull: true },
  versus_draft_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  team1_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "Teams", key: "id" },
  },
  team2_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "Teams", key: "id" },
  },
  parent_group_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "CanvasGroups", key: "id" },
  },
  metadata: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
});

const CanvasAnnotation = sequelize.define("CanvasAnnotation", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  canvas_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: Canvas, key: "id" },
  },
  // Container membership. Nullable = loose on the canvas. The FK's onDelete is
  // declared EXPLICITLY in associations.js: Sequelize's default is NO ACTION,
  // which would make deleting a Group that holds a note a 500.
  group_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "CanvasGroups", key: "id" },
  },
  // Container-relative when group_id is set, absolute world otherwise —
  // exactly like a Card (ADR-0006).
  positionX: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 50 },
  positionY: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 50 },
  // STORED, never derived by the layout engine (design D5). Snapped only at
  // render inside a grid (D5a), so the stored value survives a round trip
  // through a grid Group untouched.
  width: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 380 },
  height: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 120 },
  // The hand-set floor auto-fit may never go below (design D7), null until the
  // user drags a resize handle. Separate columns because `width`/`height` are
  // the RENDERED size and auto-fit writes `height` — conflating the two makes
  // the floor ratchet and a grown note can never shrink again.
  manualWidth: { type: DataTypes.FLOAT, allowNull: true, defaultValue: null },
  manualHeight: { type: DataTypes.FLOAT, allowNull: true, defaultValue: null },
  // The `id` this row had in the export it was imported from, null for a row
  // created on this canvas. Import dedupes on (canvas_id, source_id) — it can
  // NOT dedupe on `id`, which is a global PK: reusing an export's id across two
  // destination canvases is a unique violation (design D15, Task 9).
  source_id: { type: DataTypes.UUID, allowNull: true, defaultValue: null },
  text: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  championIds: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
    comment: "Canonical champion ids, in strip order. Append/remove only (D3).",
  },
  color: {
    type: DataTypes.ENUM(
      "none",
      "slate",
      "purple",
      "teal",
      "amber",
      "crimson",
      "emerald",
    ),
    allowNull: false,
    defaultValue: "slate",
  },
  fontSize: {
    type: DataTypes.ENUM("sm", "md", "lg", "xl"),
    allowNull: false,
    defaultValue: "md",
  },
});

module.exports = {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasShare,
  CanvasConnection,
  CanvasGroup,
  CanvasAnnotation,
};
