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
      where: { owner_id: user.id, type: "standalone" },
    });
    const sharedDrafts = await user.getSharedDrafts({
      where: { type: "standalone" },
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
    const {
      name,
      public,
      canvas_id,
      positionX,
      positionY,
      picks,
      description,
    } = req.body;

    let finalName = name || "New Draft";
    let draftType = "standalone";

    if (canvas_id) {
      const canvas = await Canvas.findByPk(canvas_id);
      if (!canvas) {
        return res.status(404).json({ error: "Canvas not found" });
      }

      draftType = "canvas";
      const { generateUniqueCanvasDraftName } = require("../helpers");
      finalName = await generateUniqueCanvasDraftName(finalName, canvas_id);
    }

    const draft = await Draft.create({
      owner_id: req.user.id,
      name: finalName,
      public: public,
      picks: picks,
      type: draftType,
      description: description,
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
      canvas.updatedAt = new Date();
      await canvas.save();

      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvas_id },
        attributes: ["positionX", "positionY"],
        include: [
          { model: Draft, attributes: ["name", "id", "picks", "type"] },
        ],
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
    const { name, description, public: publicStatus, type } = req.body;
    const draft = await Draft.findByPk(req.params.id);

    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    if (draft.owner_id !== req.user.id) {
      return res
        .status(403)
        .json({ error: "Not authorized to edit this draft" });
    }

    if (type !== undefined && type !== draft.type) {
      // Only allow canvas -> standalone conversion
      if (draft.type !== "versus") {
        draft.type = type;
      }
    }

    // Handle name change for canvas drafts with uniqueness validation
    if (name && name !== draft.name && draft.type === "canvas") {
      // This is a canvas draft being renamed - need to validate uniqueness
      const canvasAssociations = await CanvasDraft.findAll({
        where: { draft_id: draft.id },
        attributes: ["canvas_id"],
      });

      if (canvasAssociations.length > 0) {
        // For canvas drafts, validate uniqueness on the first canvas it's associated with
        const firstCanvasId = canvasAssociations[0].canvas_id;
        const { generateUniqueCanvasDraftName } = require("../helpers");
        const uniqueName = await generateUniqueCanvasDraftName(
          name,
          firstCanvasId,
          draft.id
        );

        draft.name = uniqueName;
      } else {
        draft.name = name;
      }
    } else if (name && name !== draft.name) {
      draft.name = name;
    }

    if (publicStatus !== undefined) {
      draft.public = publicStatus;
    }

    if (description !== undefined) {
      draft.description = description;
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
