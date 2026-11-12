const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const { TEAM_REGIONS } = require("../utils/teamRegions");

const TEAM_SOURCES = ["manual", "esclub"];

// owner_id is null for imported (esclub) teams; the cross-row rules (esclub
// teams have no owner, a manual team never sits in an esclub tournament) are
// enforced by assertTeamInvariants and a DB CHECK, not by this model.
const Team = sequelize.define("Team", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  owner_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "Users", key: "id" },
  },
  name: {
    type: DataTypes.STRING(120),
    allowNull: false,
    validate: { notEmpty: true, len: [1, 120] },
  },
  region: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: "na1",
    validate: { isIn: [TEAM_REGIONS] },
  },
  // Null for pickup teams; set for a team that belongs to a tournament.
  tournament_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: "Tournaments", key: "id" },
  },
  source: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: "manual",
    validate: { isIn: [TEAM_SOURCES] },
  },
  // esclub id_team_roster / id_team_organisation.
  external_id: { type: DataTypes.STRING(64), allowNull: true },
  external_org_id: { type: DataTypes.STRING(64), allowNull: true },
  acronym: { type: DataTypes.STRING(16), allowNull: true },
  // { primary, secondary }
  colors: { type: DataTypes.JSONB, allowNull: true },
  // Pickup teams only (global archive).
  archived_at: { type: DataTypes.DATE, allowNull: true },
});

module.exports = Team;
