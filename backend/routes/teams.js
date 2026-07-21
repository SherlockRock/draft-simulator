const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const Team = require("../models/Team");

function isValidTeamName(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.trim().length <= 120
  );
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
      order: [["name", "ASC"]],
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
    if (!isValidTeamName(req.body.name)) {
      return res
        .status(400)
        .json({ error: "name must be a non-empty string up to 120 chars" });
    }
    result.team.name = req.body.name.trim();
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

module.exports = router;
module.exports.isValidTeamName = isValidTeamName;
module.exports.findTeamForUser = findTeamForUser;
