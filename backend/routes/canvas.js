const express = require("express");
const router = express.Router();
const { Canvas, UserCanvas, CanvasDraft } = require("../models/Canvas.js");
const Draft = require("../models/Draft.js");
const User = require("../models/User.js");
const { protect, getUserFromRequest } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const { draftHasSharedWithUser } = require("../helpers.js");

router.get("/:canvasId", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    const canvas = await Canvas.findOne({
      where: { id: req.params.canvasId },
    });

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    const userCanvas = await UserCanvas.findOne({
      where: {
        canvas_id: canvas.id,
        user_id: user.id,
      },
    });

    if (!userCanvas) {
      return res
        .status(403)
        .json({ error: "Not authorized to access this canvas" });
    }

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvas.id },
      attributes: ["positionX", "positionY"],
      include: [{ model: Draft, attributes: ["name", "id", "picks"] }],
      raw: true,
      nest: true,
    });

    res.json({
      name: canvas.name,
      drafts: canvasDrafts,
      lastViewport: {
        x: userCanvas.lastViewportX,
        y: userCanvas.lastViewportY,
        zoom: userCanvas.lastZoomLevel,
      },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to load canvas" });
  }
});

router.put("/:canvasId/draft/:draftId", protect, async (req, res) => {
  try {
    const { positionX, positionY } = req.body;
    const { canvasId, draftId } = req.params;

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });
    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    const [affectedRows] = await CanvasDraft.update(
      { positionX, positionY },
      {
        where: {
          canvas_id: canvasId,
          draft_id: draftId,
        },
      }
    );

    if (affectedRows > 0) {
      res.status(200).json({ success: true, message: "Position updated" });
    } else {
      res
        .status(404)
        .json({ success: false, message: "Canvas draft not found" });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to update canvas draft position" });
  }
});

router.delete("/:canvasId/draft/:draftId", protect, async (req, res) => {
  try {
    const { canvasId, draftId } = req.params;

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    const affectedRows = await CanvasDraft.destroy({
      where: {
        canvas_id: canvasId,
        draft_id: draftId,
      },
    });

    if (affectedRows > 0) {
      const canvas = await Canvas.findByPk(canvasId);
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId },
        attributes: ["positionX", "positionY"],
        include: [{ model: Draft, attributes: ["name", "id", "picks"] }],
        raw: true,
        nest: true,
      });
      res
        .status(200)
        .json({ success: true, message: "Draft removed from canvas" });
      socketService.emitToRoom(canvasId, "canvasUpdate", {
        canvas: canvas.toJSON(),
        drafts: canvasDrafts,
      });
    } else {
      res
        .status(404)
        .json({ success: false, message: "Canvas draft not found" });
    }
  } catch (error) {
    console.error("Failed to remove draft from canvas:", error);
    res.status(500).json({ error: "Failed to remove draft from canvas" });
  }
});

// router.put("/:canvasId", async (req, res) => {
//   try {
//     const canvas = await Canvas.findByPk(req.params.id);
//     if (!canvas) {
//       return res.status(404).json({ error: "Canvas not found" });
//     }

//     const user = await getUserFromRequest(req);
//     if (!user) {
//       return res.status(404).json({ error: "User not found" });
//     }

//     const { drafts, viewport, name } = req.body;
//     const userCanvas = await UserCanvas.findOne({
//       where: { canvasId: canvas.id, userId: user.id },
//     });

//     if (
//       !userCanvas ||
//       (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
//     ) {
//       return res.status(403).json({
//         error: "Forbidden: You don't have permission to edit this canvas",
//       });
//     }

//     if (name !== canvas.name) {
//       canvas.name = name;
//       await canvas.save();
//     }
//     userCanvas.lastViewportX = viewport.x;
//     userCanvas.lastViewportY = viewport.y;
//     userCanvas.lastZoomLevel = viewport.zoom;
//     userCanvas.lastAccessedAt = new Date();
//     await userCanvas.save();

//     drafts.forEach((eachDraft) => {
//       const canvasDraft = canvas.CanvasDrafts.find(
//         (cd) => cd.draftId === eachDraft.id
//       );
//       canvasDraft.positionX = eachDraft.positionX;
//       canvasDraft.positionY = eachDraft.positionY;
//       canvasDraft.save();
//       const draft = Draft.findByPk(eachDraft.id);
//       draft.picks = draft.picks;
//       draft.save();
//     });

//     res.json({
//       success: true,
//     });
//     socketService.emitToRoom(canvas.id, "canvasUpdate", canvas.toJSON());
//   } catch (error) {
//     res.status(500).json({ error: "Failed to save canvas" });
//   }
// });

router.post("/", async (req, res) => {
  try {
    const { draftId } = req.body;
    const draft = await Draft.findByPk(draftId);
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const isSharedWith = await draftHasSharedWithUser(draft, user);
    if (!draft.public && draft.owner_id !== user.id && !isSharedWith) {
      return res
        .status(403)
        .json({ error: "Not authorized to use this draft" });
    }

    const canvas = await Canvas.create({ name: draft.name + " Canvas" });
    const canvasDraft = await CanvasDraft.create({
      canvas_id: canvas.id,
      draft_id: draft.id,
    });
    const userCanvas = await UserCanvas.create({
      canvas_id: canvas.id,
      user_id: user.id,
      permissions: "admin",
    });

    res.json({
      success: true,
      canvas: {
        id: canvas.id,
        name: canvas.name,
        drafts: [draft.toJSON()],
      },
    });
  } catch (error) {
    console.error("Failed to save canvas:", error);
    res.status(500).json({ error: "Failed to save canvas" });
  }
});

router.delete("/:canvasId", protect, async (req, res) => {
  const t = await Canvas.sequelize.transaction();
  try {
    const { canvasId } = req.params;

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!userCanvas || userCanvas.permissions !== "admin") {
      return res.status(403).json({
        error: "Forbidden: You must be an admin to delete this canvas",
      });
    }

    await CanvasDraft.destroy({
      where: { canvas_id: canvasId },
      transaction: t,
    });
    await UserCanvas.destroy({
      where: { canvas_id: canvasId },
      transaction: t,
    });

    const affectedRows = await Canvas.destroy({
      where: { id: canvasId },
      transaction: t,
    });

    if (affectedRows > 0) {
      await t.commit();
      res.status(200).json({ success: true, message: "Canvas deleted" });
    } else {
      await t.rollback();
      res.status(404).json({ success: false, message: "Canvas not found" });
    }
  } catch (error) {
    await t.rollback();
    console.error("Failed to delete canvas:", error);
    res.status(500).json({ error: "Failed to delete canvas" });
  }
});

router.patch("/:canvasId/viewport", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    const { canvasId } = req.params;
    const { x, y, zoom } = req.body;

    // Validate input
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof zoom !== "number"
    ) {
      return res.status(400).json({ error: "Invalid viewport data" });
    }

    // Find or create the UserCanvas record
    const [userCanvas] = await UserCanvas.findOrCreate({
      where: {
        canvas_id: canvasId,
        user_id: user.id,
      },
    });

    // Update viewport values
    userCanvas.lastViewportX = x;
    userCanvas.lastViewportY = y;
    userCanvas.lastZoomLevel = zoom;
    userCanvas.lastAccessedAt = new Date();
    await userCanvas.save();

    res.status(200).json({
      success: true,
      message: "Viewport updated",
      viewport: { x, y, zoom },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to update viewport" });
  }
});

router.patch("/:canvasId/name", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { name } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Invalid canvas name" });
    }

    // Check user permissions
    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    // Update canvas name
    const canvas = await Canvas.findByPk(canvasId);

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    canvas.name = name;
    await canvas.save();

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvas.id },
      attributes: ["positionX", "positionY"],
      include: [{ model: Draft, attributes: ["name", "id", "picks"] }],
      raw: true,
      nest: true,
    });

    const canvasJSON = canvas.toJSON();

    res.status(200).json({
      success: true,
      message: "Canvas name updated",
      canvas: canvasJSON,
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
    });
  } catch (error) {
    console.error("Failed to update canvas name:", error);
    res.status(500).json({ error: "Failed to update canvas name" });
  }
});

router.get("/:canvasId/users", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;

    // Check requester permissions
    const requesterUserCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!requesterUserCanvas) {
      return res
        .status(403)
        .json({ error: "Forbidden: You don't have access to this canvas" });
    }

    // Fetch users associated with the canvas
    // We use Canvas.findByPk with include User to get users and the junction table data
    const canvas = await Canvas.findByPk(canvasId, {
      include: [
        {
          model: User,
          attributes: ["id", "name", "email", "picture"],
          through: {
            attributes: ["permissions", "lastAccessedAt"],
          },
        },
      ],
    });

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    // Transform response to be cleaner
    const users = canvas.Users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture,
      permissions: user.UserCanvas.permissions,
      lastAccessedAt: user.UserCanvas.lastAccessedAt,
    }));

    res.json({ users });
  } catch (error) {
    console.error("Failed to fetch canvas users:", error);
    res.status(500).json({ error: "Failed to fetch canvas users" });
  }
});

router.put("/:canvasId/users/:userId", protect, async (req, res) => {
  try {
    const { canvasId, userId } = req.params;
    const { permissions } = req.body;

    // Check requester permissions (must be admin)
    const requesterUserCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!requesterUserCanvas || requesterUserCanvas.permissions !== "admin") {
      return res
        .status(403)
        .json({ error: "Forbidden: You must be an admin to manage users" });
    }

    // Prevent changing own permissions to non-admin if you are the only admin?
    // For now simple update.

    const [affectedRows] = await UserCanvas.update(
      { permissions },
      {
        where: {
          canvas_id: canvasId,
          user_id: userId,
        },
      }
    );

    if (affectedRows > 0) {
      res
        .status(200)
        .json({ success: true, message: "User permissions updated" });
    } else {
      res
        .status(404)
        .json({ success: false, message: "User not found on this canvas" });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to update user permissions" });
  }
});

router.delete("/:canvasId/users/:userId", protect, async (req, res) => {
  try {
    const { canvasId, userId } = req.params;

    // Check requester permissions (must be admin)
    const requesterUserCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!requesterUserCanvas || requesterUserCanvas.permissions !== "admin") {
      return res
        .status(403)
        .json({ error: "Forbidden: You must be an admin to remove users" });
    }

    // Prevent removing yourself? Or allow leaving?
    // If removing yourself, check if there are other admins?
    // For simplicity, allow removing anyone.

    const affectedRows = await UserCanvas.destroy({
      where: {
        canvas_id: canvasId,
        user_id: userId,
      },
    });

    if (affectedRows > 0) {
      res
        .status(200)
        .json({ success: true, message: "User removed from canvas" });
    } else {
      res
        .status(404)
        .json({ success: false, message: "User not found on this canvas" });
    }
  } catch (error) {
    console.error("Failed to remove user:", error);
    res.status(500).json({ error: "Failed to remove user" });
  }
});

module.exports = router;
