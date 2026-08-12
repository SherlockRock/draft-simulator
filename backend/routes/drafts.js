const express = require("express");
const router = express.Router();
// Shared types available after pnpm install:
// const { DraftSchema } = require("@draft-sim/shared-types");
// Usage: const result = DraftSchema.safeParse(req.body);
const Draft = require("../models/Draft");
const { buildCanvasSnapshot } = require("./canvasProjections");
const VersusDraft = require("../models/VersusDraft");
const { CanvasDraft, Canvas, UserCanvas } = require("../models/Canvas.js");
const { protect, getUserFromRequest } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const {
  assertCanvasAccess,
  checkCanvasAccess,
} = require("../services/canvasMutations");
const {
  respondCanvasMutationError,
} = require("../middleware/canvasMutationErrors");
const { draftHasSharedWithUser } = require("../helpers.js");
const User = require("../models/User.js");

// Get user's drafts with optional type filter
router.get("/", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.json([]);
    }

    const { type } = req.query;

    let whereClause = { owner_id: user.id };
    if (type) {
      whereClause.type = type;
    }

    const drafts = await Draft.findAll({
      where: whereClause,
      order: [["updatedAt", "DESC"]],
    });

    res.json(drafts);
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

    // Check if draft is locked in any canvas
    const canvasDraft = await CanvasDraft.findOne({
      where: { draft_id: draft.id },
      attributes: ["is_locked"],
    });
    const is_locked = canvasDraft?.is_locked ?? false;

    const draftWithLock = { ...draft.toJSON(), is_locked };

    if (draft.public) {
      return res.json(draftWithLock);
    }

    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    if (draft.owner_id === user.id) {
      return res.status(200).json(draftWithLock);
    }

    const isSharedWith = await draftHasSharedWithUser(draft, user);
    if (isSharedWith) {
      return res.status(200).json(draftWithLock);
    }

    // Check canvas-based access if canvas_id is provided
    const { canvas_id } = req.query;
    if (canvas_id) {
      // Verify draft is actually on this canvas
      const canvasDraftAssoc = await CanvasDraft.findOne({
        where: { draft_id: draft.id, canvas_id },
      });
      if (canvasDraftAssoc) {
        // Check user has at least view permission on this canvas
        const userCanvas = await UserCanvas.findOne({
          where: { canvas_id, user_id: user.id },
        });
        if (userCanvas) {
          return res.status(200).json(draftWithLock);
        }
      }
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
      icon,
      group_id,
    } = req.body;

    let finalName = name || "New Draft";
    let draftType = "canvas";

    if (canvas_id) {
      const canvas = await Canvas.findByPk(canvas_id);
      if (!canvas) {
        return res.status(404).json({ error: "Canvas not found" });
      }

      await assertCanvasAccess({
        userId: req.user.id,
        canvasId: canvas_id,
        level: "edit",
      });

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
      icon: icon || "",
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
        group_id: group_id || null,
      });
      canvas.updatedAt = new Date();
      await canvas.save();

      socketService.emitToRoom(
        canvas_id,
        "canvasUpdate",
        await buildCanvasSnapshot(canvas_id),
      );
    }

    res.json(draft);
  } catch (err) {
    if (
      respondCanvasMutationError(res, err, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
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
    const { name, description, public: publicStatus, icon } = req.body;
    // The canvas this edit is happening on, when there is one. Hoisted because
    // both the authorization check and the name-uniqueness check need it.
    const { canvas_id } = req.query;
    const draft = await Draft.findByPk(req.params.id);

    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    // Check authorization: owner OR canvas editor
    let authorized = draft.owner_id === req.user.id;

    if (!authorized) {
      // Check canvas-based edit access if canvas_id is provided
      if (canvas_id) {
        // Verify draft is actually on this canvas
        const canvasDraftAssoc = await CanvasDraft.findOne({
          where: { draft_id: draft.id, canvas_id },
        });
        if (canvasDraftAssoc) {
          authorized = Boolean(
            await checkCanvasAccess({
              userId: req.user.id,
              canvasId: canvas_id,
            }),
          );
        }
      }
    }

    if (!authorized) {
      return res
        .status(403)
        .json({ error: "Not authorized to edit this draft" });
    }

    const originalName = draft.name;
    const willChangePublic =
      publicStatus !== undefined && publicStatus !== draft.public;
    const willChangeDescription =
      description !== undefined && description !== draft.description;
    const willChangeIcon = icon !== undefined && icon !== draft.icon;

    // Handle name change for canvas drafts with uniqueness validation
    if (name && name !== draft.name && draft.type === "canvas") {
      // This is a canvas draft being renamed - need to validate uniqueness
      const canvasAssociations = await CanvasDraft.findAll({
        where: { draft_id: draft.id },
        attributes: ["canvas_id"],
      });

      if (canvasAssociations.length > 0) {
        // De-duplicate against the canvas the edit is actually happening on. A
        // draft can sit on several canvases (copy-to-canvas, JSON import), and
        // this used to always take canvasAssociations[0] — so renaming on
        // canvas B was validated against canvas A, which both invented "(2)"
        // suffixes for names that were free on B and let real duplicates
        // through on B. Falls back to the first association when the request
        // carries no canvas_id, or names a canvas this draft is not on.
        const targetCanvasId =
          canvasAssociations.find((assoc) => assoc.canvas_id === canvas_id)
            ?.canvas_id ?? canvasAssociations[0].canvas_id;
        const { generateUniqueCanvasDraftName } = require("../helpers");
        draft.name = await generateUniqueCanvasDraftName(
          name,
          targetCanvasId,
          draft.id,
        );
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

    if (icon !== undefined) {
      draft.icon = icon;
    }

    await draft.save();

    // Resolve the canvas-room broadcast (if any) BEFORE sending the response:
    // a DB failure in buildCanvasSnapshot must produce a clean 500, not throw
    // ERR_HTTP_HEADERS_SENT out of an already-sent response (Express 4 does
    // not catch that, and the process has no unhandledRejection handler — it
    // would crash the backend).
    let canvasBroadcast = null;
    if (canvas_id) {
      const canvas = await Canvas.findByPk(canvas_id);
      if (canvas) {
        const isRenameOnlyCanvasUpdate =
          draft.type === "canvas" &&
          draft.name !== originalName &&
          !willChangePublic &&
          !willChangeDescription &&
          !willChangeIcon;

        canvasBroadcast = isRenameOnlyCanvasUpdate
          ? {
              event: "draftNameUpdated",
              payload: { draftId: draft.id, name: draft.name },
            }
          : {
              event: "canvasUpdate",
              payload: await buildCanvasSnapshot(canvas_id),
            };
      }
    }

    res.json(draft);
    socketService.emitToRoom(draft.id, "draftUpdate", draft.toJSON());
    if (canvasBroadcast) {
      socketService.emitToRoom(
        canvas_id,
        canvasBroadcast.event,
        canvasBroadcast.payload,
      );
    }
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

// POST /api/drafts/:id/complete - Mark draft as complete with winner (for versus drafts)
router.post("/:id/complete", protect, async (req, res) => {
  try {
    const { winner } = req.body;

    const draft = await Draft.findByPk(req.params.id);

    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    await draft.update({
      completed: true,
      winner: winner || null,
    });

    // Update parent VersusDraft so it appears in recent activity
    if (draft.versus_draft_id) {
      const versusDraft = await VersusDraft.findByPk(draft.versus_draft_id);
      if (versusDraft) {
        versusDraft.changed("updatedAt", true);
        await versusDraft.save();
      }
    }

    res.json(draft);
  } catch (error) {
    console.error("Error completing draft:", error);
    res.status(500).json({ error: "Failed to complete draft" });
  }
});

module.exports = router;
