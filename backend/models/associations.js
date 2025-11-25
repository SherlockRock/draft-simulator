const UserToken = require("./UserToken");
const User = require("./User");
const Draft = require("./Draft");
const DraftShare = require("./DraftShare");
const { Canvas, UserCanvas, CanvasDraft, CanvasShare } = require("./Canvas");

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
};

module.exports = setupAssociations;
