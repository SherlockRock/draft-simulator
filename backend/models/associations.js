const UserToken = require("./UserToken");
const User = require("./User");

const setupAssociations = () => {
  User.hasMany(UserToken);
  UserToken.belongsTo(User);
};

module.exports = setupAssociations;
