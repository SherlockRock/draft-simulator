const express = require("express");
const router = express.Router();
const { Op } = require("sequelize");
const { protect } = require("../middleware/auth");
const Team = require("../models/Team");
const TeamPlayer = require("../models/TeamPlayer");
const Tournament = require("../models/Tournament");
const UserTournament = require("../models/UserTournament");
const sequelize = require("../config/database");
const {
  TeamInvariantError,
  visibleTeamsWhere,
  canSeeTeam,
  canEditRoster,
  canArchiveTeam,
  canDeleteTeam,
  assertTeamInvariants,
} = require("../services/teamAccess");
const teamUsage = require("../services/teamUsage");
const leagueRecord = require("../services/leagueRecord");

const { isValidRegion } = require("../utils/teamRegions");
const { isPlaceholderTeamName } = require("../utils/teamPlaceholders");

const PLACEHOLDER_NAME_ERROR =
  '"Team 1" and "Team 2" are placeholders, not team names';

const VALID_ROLES = new Set(["top", "jungle", "mid", "adc", "support"]);
const MAX_ROSTER = 10;

function isValidTeamName(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= 120
  );
}

// Returns { ok: true } or { ok: false, error }. Pure — no DB.
function validateRosterPlayers(players) {
  if (!Array.isArray(players)) {
    return { ok: false, error: "players must be an array" };
  }
  if (players.length > MAX_ROSTER) {
    return { ok: false, error: `roster is capped at ${MAX_ROSTER} players` };
  }
  const seenRoles = new Set();
  for (const p of players) {
    if (!p || typeof p !== "object") {
      return { ok: false, error: "each player must be an object" };
    }
    if (p.role !== null && !VALID_ROLES.has(p.role)) {
      return { ok: false, error: "invalid role" };
    }
    if (p.role !== null) {
      if (seenRoles.has(p.role)) {
        return { ok: false, error: "duplicate role" };
      }
      seenRoles.add(p.role);
    }
    if (typeof p.gameName !== "string" || p.gameName.trim().length === 0) {
      return { ok: false, error: "gameName is required" };
    }
    if (p.gameName.trim().length > 64) {
      return { ok: false, error: "gameName too long" };
    }
    if (typeof p.tagLine !== "string" || p.tagLine.trim().length === 0) {
      return { ok: false, error: "tagLine is required" };
    }
    if (p.tagLine.trim().length > 16) {
      return { ok: false, error: "tagLine too long" };
    }
  }
  return { ok: true };
}

// Include shapes shared by every response so a mutation returns the same row
// a list does (model JSON + TeamPlayers + Tournament + canEditRoster).
const TOURNAMENT_INCLUDE = {
  model: Tournament,
  attributes: ["id", "name", "source"],
  required: false,
};
const PLAYERS_INCLUDE = { model: TeamPlayer, as: "TeamPlayers" };
const PLAYERS_ORDER = [
  { model: TeamPlayer, as: "TeamPlayers" },
  "ordinal",
  "ASC",
];

// A list row: the model's JSON, its Tournament (null for a pickup team) and
// whether this user may edit it.
function serializeTeam(team, userId) {
  const base = typeof team.toJSON === "function" ? team.toJSON() : team;
  return {
    ...base,
    Tournament: base.Tournament ?? null,
    canEditRoster: canEditRoster(team, userId),
  };
}

// Team missing OR not visible to the user -> 404 (ids don't leak existence);
// visible but not editable -> 403. Returns { team } or { status, payload }.
async function findEditableTeam(teamId, userId, include) {
  const team = await Team.findByPk(teamId, include ? { include } : undefined);
  if (!team || !(await canSeeTeam(team, userId))) {
    return { status: 404, payload: { error: "Team not found" } };
  }
  if (!canEditRoster(team, userId)) {
    return { status: 403, payload: { error: "Not authorized" } };
  }
  return { team };
}

// Invariants on the row as it will be written (defaults applied). The team
// must have been loaded with its Tournament.
function assertRowInvariants(team) {
  assertTeamInvariants(
    {
      source: team.source,
      owner_id: team.owner_id,
      tournament_id: team.tournament_id ?? null,
    },
    team.Tournament ?? null,
  );
}

function sendError(res, error, label, fallback) {
  if (error instanceof TeamInvariantError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error(label, error);
  return res.status(500).json({ error: fallback });
}

// Picker scope (Q2): owned pickup teams that aren't archived, plus the teams of
// tournaments the user added and hasn't archived. ANDed with visibleTeamsWhere
// so nothing outside the user's own right can appear. The tournament ids come
// from a small first query rather than a raw SQL subquery literal.
router.get("/", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const memberships = await UserTournament.findAll({
      where: { user_id: userId, archived_at: null },
      attributes: ["tournament_id"],
    });
    const tournamentIds = memberships.map((row) => row.tournament_id);
    const scope = [
      { tournament_id: null, owner_id: userId, archived_at: null },
    ];
    if (tournamentIds.length > 0) {
      scope.push({ tournament_id: { [Op.in]: tournamentIds } });
    }
    const teams = await Team.findAll({
      where: { [Op.and]: [visibleTeamsWhere(userId), { [Op.or]: scope }] },
      include: [PLAYERS_INCLUDE, TOURNAMENT_INCLUDE],
      order: [["name", "ASC"], PLAYERS_ORDER],
    });
    res.json(teams.map((team) => serializeTeam(team, userId)));
  } catch (error) {
    sendError(res, error, "Error fetching teams:", "Failed to fetch teams");
  }
});

// The Teams page (D1, D2). Scope: visibleTeamsWhere AND (my own teams of any
// tournament, archived or not; OR the teams of every tournament I have a
// UserTournaments row for, archived or not). Nothing here is wider than what
// the user sees in their own right today. Declared before any /:id route.
router.get("/manage", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const memberships = await UserTournament.findAll({
      where: { user_id: userId },
      include: [
        {
          model: Tournament,
          attributes: ["id", "name", "source", "region"],
          required: true,
        },
      ],
      order: [[Tournament, "name", "ASC"]],
    });
    const tournamentIds = memberships.map((row) => row.tournament_id);
    const scope = [{ owner_id: userId }];
    if (tournamentIds.length > 0) {
      scope.push({ tournament_id: { [Op.in]: tournamentIds } });
    }
    const teams = await Team.findAll({
      where: { [Op.and]: [visibleTeamsWhere(userId), { [Op.or]: scope }] },
      include: [PLAYERS_INCLUDE, TOURNAMENT_INCLUDE],
      order: [["name", "ASC"], PLAYERS_ORDER],
    });
    // Ids come only from the rows above, which are already visible to the user.
    const useCounts = await teamUsage.teamUseCounts(
      teams.map((team) => team.id),
      userId,
    );
    const leagueRecords = await leagueRecord.teamLeagueRecords(teams.map((team) => team.id));
    res.json({
      tournaments: memberships.map((row) => ({
        id: row.Tournament.id,
        name: row.Tournament.name,
        source: row.Tournament.source,
        region: row.Tournament.region,
        archived_at: row.archived_at ?? null,
      })),
      teams: teams.map((team) => ({
        ...serializeTeam(team, userId),
        leagueRecord: leagueRecords[team.id] ?? null,
        useCounts: useCounts[team.id] ?? {
          official: 0,
          scrim: 0,
          scratch: 0,
          total: 0,
        },
        canArchive: canArchiveTeam(team, userId),
        canDelete: canDeleteTeam(team, userId),
      })),
    });
  } catch (error) {
    sendError(res, error, "Error fetching teams:", "Failed to fetch teams");
  }
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BULK_ACTIONS = new Set(["archive", "restore", "delete"]);
const MAX_BULK_IDS = 200;

// Returns { ok: true, action, ids } (ids de-duplicated, order kept) or
// { ok: false, error }. Pure — no DB. Malformed ids never reach the UUID column.
function validateBulkBody(body) {
  const action = body?.action;
  const ids = body?.ids;
  if (typeof action !== "string" || !BULK_ACTIONS.has(action)) {
    return { ok: false, error: "action must be archive, restore or delete" };
  }
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BULK_IDS) {
    return {
      ok: false,
      error: `ids must be an array of 1 to ${MAX_BULK_IDS} team ids`,
    };
  }
  if (!ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
    return { ok: false, error: "ids must be team id strings" };
  }
  return { ok: true, action, ids: [...new Set(ids)] };
}

// Archive, restore or delete pickup teams, all or nothing (D5). Any id that is
// missing or not visible -> 404 for the whole batch (nothing about which);
// any visible id the user may not archive/delete -> 403; only then one
// transaction. Declared before any /:id route. Delete relies on the database
// (TeamPlayers ON DELETE CASCADE, CanvasGroups team ids ON DELETE SET NULL),
// exactly as DELETE /:id does.
router.post("/bulk", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const parsed = validateBulkBody(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { action, ids } = parsed;

    const teams = await Team.findAll({ where: { id: ids } });
    if (teams.length !== ids.length) {
      return res.status(404).json({ error: "Team not found" });
    }
    for (const team of teams) {
      if (!(await canSeeTeam(team, userId))) {
        return res.status(404).json({ error: "Team not found" });
      }
    }
    const allowed = action === "delete" ? canDeleteTeam : canArchiveTeam;
    if (!teams.every((team) => allowed(team, userId))) {
      return res.status(403).json({ error: "Not authorized" });
    }

    await sequelize.transaction(async (transaction) => {
      if (action === "delete") {
        await Team.destroy({ where: { id: ids }, transaction });
      } else if (action === "archive") {
        // Don't re-stamp teams that are already archived.
        await Team.update(
          { archived_at: new Date() },
          { where: { id: ids, archived_at: null }, transaction },
        );
      } else {
        await Team.update(
          { archived_at: null },
          { where: { id: ids }, transaction },
        );
      }
    });
    res.json({ action, ids });
  } catch (error) {
    sendError(res, error, "Error in bulk team action:", "Failed to update teams");
  }
});

// Archive or restore a league for the caller only (D6): sets archived_at on
// the caller's own UserTournaments row. Never creates a row, never touches
// Tournaments, and 404s when the caller has no row (so it never says whether a
// tournament exists).
router.put("/tournaments/:id/archive", protect, async (req, res) => {
  try {
    const archived = req.body?.archived;
    if (typeof archived !== "boolean") {
      return res.status(400).json({ error: "archived must be a boolean" });
    }
    const tournamentId = req.params.id;
    if (!UUID_PATTERN.test(tournamentId)) {
      return res.status(404).json({ error: "Tournament not found" });
    }
    const archivedAt = archived ? new Date() : null;
    const [affected] = await UserTournament.update(
      { archived_at: archivedAt },
      { where: { user_id: req.user.id, tournament_id: tournamentId } },
    );
    if (affected === 0) {
      return res.status(404).json({ error: "Tournament not found" });
    }
    res.json({ tournament_id: tournamentId, archived_at: archivedAt });
  } catch (error) {
    sendError(
      res,
      error,
      "Error archiving tournament:",
      "Failed to archive tournament",
    );
  }
});

router.post("/", protect, async (req, res) => {
  try {
    const { name } = req.body;
    if (!isValidTeamName(name)) {
      return res
        .status(400)
        .json({ error: "name must be a non-empty string up to 120 chars" });
    }
    if (isPlaceholderTeamName(name)) {
      return res.status(400).json({ error: PLACEHOLDER_NAME_ERROR });
    }
    const values = {
      owner_id: req.user.id,
      name: name.trim(),
      source: "manual",
      tournament_id: null,
    };
    assertTeamInvariants(values, null);
    const created = await Team.create(values);
    res.status(201).json({
      ...serializeTeam(created, req.user.id),
      Tournament: null,
      canEditRoster: true,
    });
  } catch (error) {
    sendError(res, error, "Error creating team:", "Failed to create team");
  }
});

router.patch("/:id", protect, async (req, res) => {
  try {
    const result = await findEditableTeam(req.params.id, req.user.id, [
      TOURNAMENT_INCLUDE,
    ]);
    if (!result.team) return res.status(result.status).json(result.payload);

    const { name, region } = req.body;
    if (name === undefined && region === undefined) {
      return res
        .status(400)
        .json({ error: "provide at least one of name or region" });
    }
    if (name !== undefined) {
      if (!isValidTeamName(name)) {
        return res
          .status(400)
          .json({ error: "name must be a non-empty string up to 120 chars" });
      }
      if (isPlaceholderTeamName(name)) {
        return res.status(400).json({ error: PLACEHOLDER_NAME_ERROR });
      }
      result.team.name = name.trim();
    }
    if (region !== undefined) {
      if (!isValidRegion(region)) {
        return res.status(400).json({ error: "invalid region" });
      }
      result.team.region = region;
    }
    assertRowInvariants(result.team);
    await result.team.save();
    res.json(serializeTeam(result.team, req.user.id));
  } catch (error) {
    sendError(res, error, "Error updating team:", "Failed to update team");
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const result = await findEditableTeam(req.params.id, req.user.id);
    if (!result.team) return res.status(result.status).json(result.payload);
    await result.team.destroy();
    res.json({ success: true });
  } catch (error) {
    sendError(res, error, "Error deleting team:", "Failed to delete team");
  }
});

// Whole-roster replace, region-atomic. Body: { region?, players: [{ role,
// gameName, tagLine }] } — players in display order (slots first, then bench).
// `ordinal` is assigned server-side by array index, never trusted from the
// client, so UNIQUE(team_id, ordinal) can't be violated. Region (if present)
// saves in the SAME transaction as the roster, so there is no partial-write
// window.
router.put("/:id/roster", protect, async (req, res) => {
  try {
    const result = await findEditableTeam(req.params.id, req.user.id, [
      TOURNAMENT_INCLUDE,
    ]);
    if (!result.team) return res.status(result.status).json(result.payload);

    const players = req.body?.players;
    const check = validateRosterPlayers(players);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const { region } = req.body;
    if (region !== undefined && !isValidRegion(region)) {
      return res.status(400).json({ error: "invalid region" });
    }
    if (region !== undefined) assertRowInvariants(result.team);

    await sequelize.transaction(async (tx) => {
      if (region !== undefined) {
        result.team.region = region;
        await result.team.save({ transaction: tx });
      }
      await TeamPlayer.destroy({
        where: { team_id: result.team.id },
        transaction: tx,
      });
      if (players.length > 0) {
        await TeamPlayer.bulkCreate(
          players.map((p, i) => ({
            team_id: result.team.id,
            role: p.role ?? null,
            gameName: p.gameName.trim(),
            tagLine: p.tagLine.trim(),
            ordinal: i,
          })),
          { transaction: tx },
        );
      }
    });

    const fresh = await Team.findByPk(result.team.id, {
      include: [PLAYERS_INCLUDE, TOURNAMENT_INCLUDE],
      order: [PLAYERS_ORDER],
    });
    res.json(serializeTeam(fresh, req.user.id));
  } catch (error) {
    sendError(res, error, "Error saving roster:", "Failed to save roster");
  }
});

module.exports = router;
module.exports.isValidTeamName = isValidTeamName;
module.exports.isValidRegion = isValidRegion;
module.exports.validateRosterPlayers = validateRosterPlayers;
