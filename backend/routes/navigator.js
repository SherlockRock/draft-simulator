const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const NavigatorSession = require("../models/NavigatorSession");
const NavigatorDraft = require("../models/NavigatorDraft");
const NavigatorEvent = require("../models/NavigatorEvent");
const NavigatorSnapshot = require("../models/NavigatorSnapshot");

async function findSessionForUser(sessionId, userId, options = {}) {
  const session = await NavigatorSession.findByPk(sessionId, options);

  if (!session) {
    return { status: 404, payload: { error: "Navigator session not found" } };
  }

  if (session.user_id !== userId) {
    return { status: 403, payload: { error: "Not authorized" } };
  }

  return { session };
}

router.get("/", protect, async (req, res) => {
  try {
    const sessions = await NavigatorSession.findAll({
      where: { user_id: req.user.id },
      include: [
        {
          model: NavigatorDraft,
          attributes: ["id", "game_number", "status"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    res.json(sessions);
  } catch (error) {
    console.error("Error fetching navigator sessions:", error);
    res.status(500).json({ error: "Failed to fetch navigator sessions" });
  }
});

router.post("/", protect, async (req, res) => {
  try {
    const {
      name,
      our_side,
      display_pool,
      search_pool,
      opponent_pool,
      fearless,
    } = req.body;

    const session = await NavigatorSession.create({
      name,
      user_id: req.user.id,
      our_side,
      display_pool,
      search_pool: search_pool ?? display_pool,
      opponent_pool,
      fearless,
    });

    await NavigatorDraft.create({
      session_id: session.id,
      game_number: 1,
    });

    const createdSession = await NavigatorSession.findByPk(session.id, {
      include: [
        {
          model: NavigatorDraft,
          attributes: ["id", "game_number", "status"],
        },
      ],
      order: [[NavigatorDraft, "game_number", "ASC"]],
    });

    res.status(201).json(createdSession);
  } catch (error) {
    console.error("Error creating navigator session:", error);
    res.status(500).json({ error: "Failed to create navigator session" });
  }
});

router.get("/:id", protect, async (req, res) => {
  try {
    const result = await findSessionForUser(req.params.id, req.user.id, {
      include: [
        {
          model: NavigatorDraft,
          include: [NavigatorEvent, NavigatorSnapshot],
        },
      ],
      order: [
        [NavigatorDraft, "game_number", "ASC"],
        [NavigatorDraft, NavigatorEvent, "createdAt", "ASC"],
        [NavigatorDraft, NavigatorSnapshot, "createdAt", "ASC"],
      ],
    });

    if (!result.session) {
      return res.status(result.status).json(result.payload);
    }

    res.json(result.session);
  } catch (error) {
    console.error("Error fetching navigator session:", error);
    res.status(500).json({ error: "Failed to fetch navigator session" });
  }
});

router.patch("/:id", protect, async (req, res) => {
  try {
    const result = await findSessionForUser(req.params.id, req.user.id);

    if (!result.session) {
      return res.status(result.status).json(result.payload);
    }

    const allowedFields = [
      "name",
      "display_pool",
      "search_pool",
      "opponent_pool",
      "fearless",
      "status",
    ];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        result.session[field] = req.body[field];
      }
    }

    await result.session.save();

    res.json(result.session);
  } catch (error) {
    console.error("Error updating navigator session:", error);
    res.status(500).json({ error: "Failed to update navigator session" });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const result = await findSessionForUser(req.params.id, req.user.id);

    if (!result.session) {
      return res.status(result.status).json(result.payload);
    }

    await result.session.destroy();

    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting navigator session:", error);
    res.status(500).json({ error: "Failed to delete navigator session" });
  }
});

module.exports = router;
