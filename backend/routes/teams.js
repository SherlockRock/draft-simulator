const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const Team = require("../models/Team");
const TeamPlayer = require("../models/TeamPlayer");
const sequelize = require("../config/database");

const VALID_REGIONS = new Set(["na1", "euw1", "eun1", "kr", "br1", "oc1"]);
const VALID_ROLES = new Set(["top", "jungle", "mid", "adc", "support"]);
const MAX_ROSTER = 10;

function isValidTeamName(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= 120
  );
}

function isValidRegion(value) {
  return typeof value === "string" && VALID_REGIONS.has(value);
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

async function findTeamForUser(teamId, userId) {
  const team = await Team.findByPk(teamId);
  if (!team) return { status: 404, payload: { error: "Team not found" } };
  if (team.owner_id !== userId) {
    return { status: 403, payload: { error: "Not authorized" } };
  }
  return { team };
}

router.get("/", protect, async (req, res) => {
  try {
    const teams = await Team.findAll({
      where: { owner_id: req.user.id },
      include: [{ model: TeamPlayer, as: "TeamPlayers" }],
      order: [
        ["name", "ASC"],
        [{ model: TeamPlayer, as: "TeamPlayers" }, "ordinal", "ASC"],
      ],
    });
    res.json(teams);
  } catch (error) {
    console.error("Error fetching teams:", error);
    res.status(500).json({ error: "Failed to fetch teams" });
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
    const created = await Team.create({
      owner_id: req.user.id,
      name: name.trim(),
    });
    res.status(201).json(created);
  } catch (error) {
    console.error("Error creating team:", error);
    res.status(500).json({ error: "Failed to create team" });
  }
});

router.patch("/:id", protect, async (req, res) => {
  try {
    const result = await findTeamForUser(req.params.id, req.user.id);
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
      result.team.name = name.trim();
    }
    if (region !== undefined) {
      if (!isValidRegion(region)) {
        return res.status(400).json({ error: "invalid region" });
      }
      result.team.region = region;
    }
    await result.team.save();
    res.json(result.team);
  } catch (error) {
    console.error("Error updating team:", error);
    res.status(500).json({ error: "Failed to update team" });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const result = await findTeamForUser(req.params.id, req.user.id);
    if (!result.team) return res.status(result.status).json(result.payload);
    await result.team.destroy();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting team:", error);
    res.status(500).json({ error: "Failed to delete team" });
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
    const result = await findTeamForUser(req.params.id, req.user.id);
    if (!result.team) return res.status(result.status).json(result.payload);

    const players = req.body?.players;
    const check = validateRosterPlayers(players);
    if (!check.ok) return res.status(400).json({ error: check.error });

    const { region } = req.body;
    if (region !== undefined && !isValidRegion(region)) {
      return res.status(400).json({ error: "invalid region" });
    }

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
      include: [{ model: TeamPlayer, as: "TeamPlayers" }],
      order: [[{ model: TeamPlayer, as: "TeamPlayers" }, "ordinal", "ASC"]],
    });
    res.json(fresh);
  } catch (error) {
    console.error("Error saving roster:", error);
    res.status(500).json({ error: "Failed to save roster" });
  }
});

module.exports = router;
module.exports.isValidTeamName = isValidTeamName;
module.exports.findTeamForUser = findTeamForUser;
module.exports.isValidRegion = isValidRegion;
module.exports.validateRosterPlayers = validateRosterPlayers;
