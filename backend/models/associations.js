const UserToken = require("./UserToken");
const User = require("./User");
const Draft = require("./Draft");
const DraftShare = require("./DraftShare");
const { Canvas, UserCanvas, CanvasDraft, CanvasShare, CanvasGroup } = require("./Canvas");
const VersusDraft = require("./VersusDraft");
const VersusParticipant = require("./VersusParticipant");
const NavigatorSession = require("./NavigatorSession");
const NavigatorDraft = require("./NavigatorDraft");
const NavigatorEvent = require("./NavigatorEvent");
const NavigatorSnapshot = require("./NavigatorSnapshot");
const SavedPool = require("./SavedPool");

const setupAssociations = () => {
  User.hasMany(UserToken);
  UserToken.belongsTo(User);

  User.hasMany(Draft, { foreignKey: "owner_id" });
  Draft.belongsTo(User, { as: "owner", foreignKey: "owner_id" });

  User.belongsToMany(Draft, {
    through: DraftShare,
    as: "SharedDrafts",
    foreignKey: "user_id",
    onDelete: "CASCADE",
  });
  Draft.belongsToMany(User, {
    through: DraftShare,
    as: "SharedWith",
    foreignKey: "draft_id",
    onDelete: "CASCADE",
  });

  User.belongsToMany(Canvas, {
    through: UserCanvas,
    foreignKey: "user_id",
    onDelete: "CASCADE",
  });
  Canvas.belongsToMany(User, {
    through: UserCanvas,
    foreignKey: "canvas_id",
    onDelete: "CASCADE",
  });

  // Direct UserCanvas associations (needed for queries from UserCanvas)
  UserCanvas.belongsTo(Canvas, { foreignKey: "canvas_id" });
  Canvas.hasMany(UserCanvas, { foreignKey: "canvas_id", onDelete: "CASCADE" });

  Canvas.hasMany(CanvasDraft, { foreignKey: "canvas_id", onDelete: "CASCADE" });
  CanvasDraft.belongsTo(Canvas, {
    foreignKey: "canvas_id",
    onDelete: "CASCADE",
  });

  Draft.hasMany(CanvasDraft, { foreignKey: "draft_id", onDelete: "CASCADE" });
  CanvasDraft.belongsTo(Draft, { foreignKey: "draft_id", onDelete: "CASCADE" });

  // CanvasGroup associations
  Canvas.hasMany(CanvasGroup, { foreignKey: "canvas_id", onDelete: "CASCADE" });
  CanvasGroup.belongsTo(Canvas, { foreignKey: "canvas_id", onDelete: "CASCADE" });

  CanvasGroup.belongsTo(VersusDraft, { foreignKey: "versus_draft_id" });

  CanvasGroup.hasMany(CanvasDraft, { foreignKey: "group_id", onDelete: "SET NULL" });
  CanvasDraft.belongsTo(CanvasGroup, { foreignKey: "group_id", onDelete: "SET NULL" });

  User.belongsToMany(Canvas, {
    through: CanvasShare,
    as: "SharedCanvases",
    foreignKey: "user_id",
    onDelete: "CASCADE",
  });
  Canvas.belongsToMany(User, {
    through: CanvasShare,
    as: "SharedWith",
    foreignKey: "canvas_id",
    onDelete: "CASCADE",
  });

  // Versus Draft associations
  User.hasMany(VersusDraft, { foreignKey: "owner_id" });
  VersusDraft.belongsTo(User, { as: "owner", foreignKey: "owner_id" });

  VersusDraft.hasMany(Draft, {
    as: "Drafts",
    foreignKey: "versus_draft_id",
    onDelete: "CASCADE",
  });
  Draft.belongsTo(VersusDraft, {
    foreignKey: "versus_draft_id",
    onDelete: "CASCADE",
  });

  VersusDraft.hasMany(VersusParticipant, {
    foreignKey: "versus_draft_id",
    onDelete: "CASCADE",
  });
  VersusParticipant.belongsTo(VersusDraft, {
    foreignKey: "versus_draft_id",
    onDelete: "CASCADE",
  });

  User.hasMany(VersusParticipant, { foreignKey: "user_id" });
  VersusParticipant.belongsTo(User, { foreignKey: "user_id" });

  // Navigator associations
  User.hasMany(NavigatorSession, { foreignKey: "user_id" });
  NavigatorSession.belongsTo(User, { as: "owner", foreignKey: "user_id" });

  NavigatorSession.hasMany(NavigatorDraft, { foreignKey: "session_id", onDelete: "CASCADE" });
  NavigatorDraft.belongsTo(NavigatorSession, { foreignKey: "session_id", onDelete: "CASCADE" });

  NavigatorDraft.hasMany(NavigatorEvent, { foreignKey: "navigator_draft_id", onDelete: "CASCADE" });
  NavigatorEvent.belongsTo(NavigatorDraft, { foreignKey: "navigator_draft_id", onDelete: "CASCADE" });

  NavigatorDraft.hasMany(NavigatorSnapshot, { foreignKey: "navigator_draft_id", onDelete: "CASCADE" });
  NavigatorSnapshot.belongsTo(NavigatorDraft, { foreignKey: "navigator_draft_id", onDelete: "CASCADE" });

  NavigatorDraft.belongsTo(Draft, { foreignKey: "draft_id" });

  // SavedPool associations (user-scoped Navigator pool presets)
  User.hasMany(SavedPool, { foreignKey: "owner_id", onDelete: "CASCADE" });
  SavedPool.belongsTo(User, { as: "owner", foreignKey: "owner_id" });
};

module.exports = setupAssociations;
