const express = require("express");
const router = express.Router();
const Draft = require("../models/Draft");
const { CanvasDraft, Canvas, UserCanvas } = require("../models/Canvas.js");
const { protect, getUserFromRequest } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const { draftHasSharedWithUser } = require("../helpers.js");
const User = require("../models/User.js");

router.get("/dropdown", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.json([]);
    }

    const ownedDrafts = await Draft.findAll({
      where: { owner_id: user.id },
    });
    const sharedDrafts = await user.getSharedDrafts({
      joinTableAttributes: [],
    });
    const allDrafts = [...ownedDrafts, ...sharedDrafts];
    const uniqueDrafts = Array.from(
      new Map(allDrafts.map((draft) => [draft.id, draft])).values()
    );

    res.json(uniqueDrafts.map((draft) => ({ id: draft.id, name: draft.name })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const draft = await Draft.findByPk(req.params.id);
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    if (draft.public) {
      return res.json(draft);
    }

    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    if (draft.owner_id === user.id) {
      return res.status(200).json(draft);
    }

    const isSharedWith = await draftHasSharedWithUser(draft, user);
    if (isSharedWith) {
      return res.status(200).json(draft);
    }

    return res.status(403).json({ error: "Not authorized to view this draft" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server Error" });
  }
});

router.post("/", protect, async (req, res) => {
  try {
    const { name, public, canvas_id, positionX, positionY, picks } = req.body;
    const draft = await Draft.create({
      owner_id: req.user.id,
      name: name,
      public: public,
      picks: picks,
    });

    if (canvas_id) {
      const canvas = await Canvas.findByPk(canvas_id);
      if (!canvas) {
        return res.status(404).json({ error: "Canvas not found" });
      }
      const canvasDraft = await CanvasDraft.create({
        canvas_id,
        draft_id: draft.id,
        positionX: positionX || 50,
        positionY: positionY || 50,
      });
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvas_id },
        attributes: ["positionX", "positionY"],
        include: [{ model: Draft, attributes: ["name", "id", "picks"] }],
        raw: true,
        nest: true,
      });
      socketService.emitToRoom(canvas_id, "canvasUpdate", {
        canvas: canvas.toJSON(),
        drafts: canvasDrafts,
      });
    }

    res.json(draft);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const draft = await Draft.findByPk(req.params.id);
    if (draft.owner_id !== req.user.id) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this draft" });
    }
    await draft.destroy();
    res.json(req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.put("/:id", protect, async (req, res) => {
  try {
    const { name, public: publicStatus } = req.body;
    const draft = await Draft.findByPk(req.params.id);

    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    if (draft.owner_id !== req.user.id) {
      return res
        .status(403)
        .json({ error: "Not authorized to edit this draft" });
    }

    if (name) {
      draft.name = name;
    }

    if (publicStatus !== undefined) {
      draft.public = publicStatus;
    }

    await draft.save();
    res.json(draft);
    socketService.emitToRoom(draft.id, "draftUpdate", draft.toJSON());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.get("/:draftId/canvases", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    const draft = await Draft.findByPk(req.params.draftId);
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    const canvasDrafts = await CanvasDraft.findAll({
      where: { draft_id: draft.id },
      include: [
        {
          model: Canvas,
          attributes: ["name", "id", "createdAt"],
          include: [
            {
              model: User,
              where: { id: user.id },
              attributes: [],
              through: {
                attributes: ["permissions"],
              },
              required: true,
            },
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const canvases = canvasDrafts.map((cd) => ({
      id: cd.Canvas.id,
      name: cd.Canvas.name,
      createdAt: cd.Canvas.createdAt,
      permissions: cd.Canvas.Users.UserCanvas.permissions,
    }));

    res.json({ canvases });
  } catch (error) {
    console.error("Failed to fetch user canvases:", error);
    res.status(500).json({ error: "Failed to fetch canvases" });
  }
});

module.exports = router;
