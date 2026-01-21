const express = require("express");
const router = express.Router();
const VersusDraft = require("../models/VersusDraft");
const Draft = require("../models/Draft");
const User = require("../models/User");
const { authenticate, optionalAuth } = require("../middleware/auth");
const socketService = require("../middleware/socketService");

// GET /api/versus-drafts - Get all versus drafts for current user
router.get("/", authenticate, async (req, res) => {
  try {
    const versusDrafts = await VersusDraft.findAll({
      where: { owner_id: req.user.id },
      order: [["createdAt", "DESC"]],
      include: [
        {
          model: Draft,
          as: "Drafts",
        },
      ],
    });

    res.json(versusDrafts);
  } catch (error) {
    console.error("Error fetching versus drafts:", error);
    res.status(500).json({ error: "Failed to fetch versus drafts" });
  }
});

// POST /api/versus-drafts - Create new versus draft
router.post("/", optionalAuth, async (req, res) => {
  try {
    const {
      name,
      blueTeamName,
      redTeamName,
      description,
      length,
      competitive,
      icon,
      type,
    } = req.body;

    const ownerId = req.user?.id || null;

    // Create versus draft
    const versusDraft = await VersusDraft.create({
      name,
      blueTeamName: blueTeamName || "Blue Team",
      redTeamName: redTeamName || "Red Team",
      description,
      length: length || 3,
      competitive: competitive || false,
      icon: icon || "",
      type: type || "standard",
      owner_id: ownerId,
    });

    // Create series drafts
    const draftPromises = [];
    for (let i = 0; i < versusDraft.length; i++) {
      draftPromises.push(
        Draft.create({
          name: `${name} - Game ${i + 1}`,
          type: "versus",
          versus_draft_id: versusDraft.id,
          seriesIndex: i,
          owner_id: ownerId,
          description: description || "",
        }),
      );
    }

    await Promise.all(draftPromises);

    res.status(201).json(versusDraft);
  } catch (error) {
    console.error("Error creating versus draft:", error);
    res.status(500).json({ error: "Failed to create versus draft" });
  }
});

// GET /api/versus-drafts/:id - Get versus draft with all games
router.get("/:id", optionalAuth, async (req, res) => {
  try {
    const versusDraft = await VersusDraft.findByPk(req.params.id, {
      include: [
        {
          model: Draft,
          as: "Drafts",
        },
        {
          model: User,
          as: "owner",
          attributes: ["id", "name", "email"],
        },
      ],
      order: [[{ model: Draft, as: "Drafts" }, "seriesIndex", "ASC"]],
    });

    if (!versusDraft) {
      return res.status(404).json({ error: "Versus draft not found" });
    }

    res.json(versusDraft);
  } catch (error) {
    console.error("Error fetching versus draft:", error);
    res.status(500).json({ error: "Failed to fetch versus draft" });
  }
});

// GET /api/versus-drafts/:id/drafts - Get all drafts for a versus series
router.get("/:id/drafts", optionalAuth, async (req, res) => {
  try {
    const drafts = await Draft.findAll({
      where: { versus_draft_id: req.params.id },
      order: [["seriesIndex", "ASC"]],
    });

    res.json(drafts);
  } catch (error) {
    console.error("Error fetching versus drafts:", error);
    res.status(500).json({ error: "Failed to fetch drafts" });
  }
});

// PUT /api/versus-drafts/:id - Update versus draft
router.put("/:id", authenticate, async (req, res) => {
  try {
    const versusDraft = await VersusDraft.findByPk(req.params.id);

    if (!versusDraft) {
      return res.status(404).json({ error: "Versus draft not found" });
    }

    if (versusDraft.owner_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const { name, description, competitive, icon, type, blueTeamName, redTeamName, length } = req.body;

    // Check if series has started (any picks made in first draft)
    const drafts = await versusDraft.getDrafts({ order: [['seriesIndex', 'ASC']] });
    const firstDraft = drafts[0];
    const hasStarted = firstDraft && firstDraft.picks && firstDraft.picks.some(p => p && p !== "");

    await versusDraft.update({
      ...(name && { name }),
      ...(description !== undefined && { description }),
      ...(competitive !== undefined && { competitive }),
      ...(icon !== undefined && { icon }),
      ...(blueTeamName && { blueTeamName }),
      ...(redTeamName && { redTeamName }),
      // Only allow type/length changes if series hasn't started
      ...(!hasStarted && type !== undefined && { type }),
      ...(!hasStarted && length !== undefined && { length }),
    });

    // Broadcast update to all connected participants
    socketService.emitToRoom(`versus:${versusDraft.id}`, "versusSeriesUpdate", {
      versusDraft: versusDraft.toJSON(),
    });

    res.json(versusDraft);
  } catch (error) {
    console.error("Error updating versus draft:", error);
    res.status(500).json({ error: "Failed to update versus draft" });
  }
});

// DELETE /api/versus-drafts/:id - Delete versus draft
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const versusDraft = await VersusDraft.findByPk(req.params.id);

    if (!versusDraft) {
      return res.status(404).json({ error: "Versus draft not found" });
    }

    if (versusDraft.owner_id !== req.user.id) {
      return res.status(403).json({ error: "Not authorized" });
    }

    await versusDraft.destroy();

    res.json({ message: "Versus draft deleted successfully" });
  } catch (error) {
    console.error("Error deleting versus draft:", error);
    res.status(500).json({ error: "Failed to delete versus draft" });
  }
});

module.exports = router;
