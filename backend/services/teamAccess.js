const { Op } = require("sequelize");
const { Canvas, UserCanvas, CanvasGroup } = require("../models/Canvas");

// One module for who may see, link and edit a Team (teams-rework design,
// decisions 6-10; T1 plan Task 5). Routes must not filter by owner_id
// themselves. Every function accepts plain objects
// ({ id, source, owner_id, tournament_id }) as well as model instances.

/**
 * Thrown by assertTeamInvariants. Routes map it to 400. `code` is stable:
 * UNKNOWN_SOURCE, ESCLUB_TEAM_HAS_OWNER, ESCLUB_TEAM_NEEDS_ESCLUB_TOURNAMENT,
 * MANUAL_TEAM_NEEDS_MANUAL_TOURNAMENT, TOURNAMENT_MISMATCH.
 */
class TeamInvariantError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TeamInvariantError";
    this.code = code;
    this.status = 400;
  }
}

// "Own right": an imported (esclub) team is visible to any signed-in user; any
// other team to its owner. Manual-tournament teams (D4) are owner-only, which
// falls out of owner_id.
//
// visibleTeamsWhere (SQL) and seesInOwnRight (JS) MUST agree: they are the two
// spellings of this one rule, and the Task 6 matrix checks them against each
// other. Change both or neither.
function seesInOwnRight(team, userId) {
  if (!userId) return false;
  return team.source === "esclub" || team.owner_id === userId;
}

/** Sequelize `where` for the teams a user can see in their own right. */
function visibleTeamsWhere(userId) {
  if (!userId) return { id: null };
  return { [Op.or]: [{ source: "esclub" }, { owner_id: userId }] };
}

/**
 * Read access: own right, or the team is linked to a group on a canvas the
 * user is a member of (decision 6). Grants read only. Anonymous callers get
 * false; public-share reads are the canvas payload's business.
 */
async function canSeeTeam(team, userId, { transaction } = {}) {
  if (!userId) return false;
  if (seesInOwnRight(team, userId)) return true;
  const linked = await CanvasGroup.findOne({
    attributes: ["id"],
    where: { [Op.or]: [{ team1_id: team.id }, { team2_id: team.id }] },
    include: [
      {
        model: Canvas,
        required: true,
        attributes: [],
        include: [
          {
            model: UserCanvas,
            required: true,
            attributes: [],
            where: { user_id: userId },
          },
        ],
      },
    ],
    // findOne adds LIMIT 1; with a nested hasMany include (Canvas -> UserCanvas)
    // Sequelize would wrap CanvasGroup in a LIMIT subquery selecting only "id",
    // and the outer join would reference a column it lacks (invalid SQL).
    // subQuery: false keeps one flat inner-join query with LIMIT 1 at the end.
    subQuery: false,
    transaction,
  });
  return linked !== null && linked !== undefined;
}

/** Link onto a group: own right only (fix 4); never canvas-derived. */
function canLinkTeam(team, userId) {
  return seesInOwnRight(team, userId);
}

/** Roster and team edits: the owner of a manual team; never an esclub team. */
function canEditRoster(team, userId) {
  return Boolean(userId) && team.source === "manual" && team.owner_id === userId;
}

/**
 * Cross-row rules checked before any Team write (D3). `tournament` is the
 * Tournament the team points at (null/undefined for a pickup team).
 */
function assertTeamInvariants(team, tournament) {
  const fail = (code, message) => {
    throw new TeamInvariantError(message, code);
  };
  if (team.source !== "esclub" && team.source !== "manual") {
    fail("UNKNOWN_SOURCE", `Unknown team source: ${team.source}`);
  }
  if (team.source === "esclub" && team.owner_id !== null && team.owner_id !== undefined) {
    fail("ESCLUB_TEAM_HAS_OWNER", "An esclub team cannot have an owner");
  }
  const hasTournamentId = team.tournament_id !== null && team.tournament_id !== undefined;
  const hasTournament = tournament !== null && tournament !== undefined;
  if (hasTournamentId !== hasTournament || (hasTournament && tournament.id !== team.tournament_id)) {
    fail("TOURNAMENT_MISMATCH", "team.tournament_id does not match the tournament given");
  }
  if (team.source === "esclub" && (!hasTournament || tournament.source !== "esclub")) {
    fail("ESCLUB_TEAM_NEEDS_ESCLUB_TOURNAMENT", "An esclub team must belong to an esclub tournament");
  }
  if (team.source === "manual" && hasTournament && tournament.source !== "manual") {
    fail("MANUAL_TEAM_NEEDS_MANUAL_TOURNAMENT", "A manual team cannot belong to a non-manual tournament");
  }
}

module.exports = {
  TeamInvariantError,
  visibleTeamsWhere,
  canSeeTeam,
  canLinkTeam,
  canEditRoster,
  assertTeamInvariants,
};
