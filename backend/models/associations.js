const UserToken = require("./UserToken");
const User = require("./User");
const Draft = require("./Draft");
const DraftShare = require("./DraftShare");

const setupAssociations = () => {
  User.hasMany(UserToken);
  UserToken.belongsTo(User);

  User.hasMany(Draft, { foreignKey: "draft_id" });
  Draft.belongsTo(User, { as: "owner", foreignKey: "owner_id" });

  User.belongsToMany(Draft, {
    through: DraftShare,
    as: "SharedDrafts",
    foreignKey: "user_id",
  });
  Draft.belongsToMany(User, {
    through: DraftShare,
    as: "SharedWith",
    foreignKey: "draft_id",
  });
};

module.exports = setupAssociations;
