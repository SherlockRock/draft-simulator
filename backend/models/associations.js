const UserToken = require("./UserToken");
const User = require("./User");
const Draft = require("./Draft");
const DraftShare = require("./DraftShare");
const { Canvas, UserCanvas, CanvasDraft, CanvasShare, CanvasGroup } = require("./Canvas");
const VersusDraft = require("./VersusDraft");
const VersusParticipant = require("./VersusParticipant");

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
};

module.exports = setupAssociations;
