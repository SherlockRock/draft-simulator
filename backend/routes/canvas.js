const express = require("express");
const router = express.Router();
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
} = require("../models/Canvas.js");
const Draft = require("../models/Draft.js");
const User = require("../models/User.js");
const VersusDraft = require("../models/VersusDraft.js");
const { protect, getUserFromRequest } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const { draftHasSharedWithUser } = require("../helpers.js");

// Helper function to touch canvas updatedAt timestamp
async function touchCanvasTimestamp(canvasId) {
  const now = new Date();

  // Fetch the canvas instance and save it to trigger updatedAt
  const canvas = await Canvas.findByPk(canvasId);
  if (canvas) {
    canvas.changed("updatedAt", true);
    await canvas.save({ silent: false });
  }
}

// Get all canvases for the current user
router.get("/", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.json([]);
    }

    const canvases = await Canvas.findAll({
      include: [
        {
          model: User,
          through: {
            model: UserCanvas,
            where: { user_id: user.id },
          },
          attributes: [],
          required: true,
        },
      ],
      order: [["updatedAt", "DESC"]],
    });

    res.json(
      canvases.map((canvas) => ({
        id: canvas.id,
        name: canvas.name,
        updatedAt: canvas.updatedAt,
      }))
    );
  } catch (error) {
    console.error("Error fetching canvas list:", error);
    res.status(500).json({ error: "Failed to fetch canvas list" });
  }
});

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
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{
        model: Draft,
        attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex", "completed", "winner"]
      }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvas.id },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvas.id },
      include: [{ model: VersusDraft }],
    });

    res.json({
      name: canvas.name,
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => ({
        ...g.toJSON(),
        isInProgress: g.VersusDraft ? !g.VersusDraft.Drafts?.every((d) => d.completed) : false,
      })),
      lastViewport: {
        x: userCanvas.lastViewportX,
        y: userCanvas.lastViewportY,
        zoom: userCanvas.lastZoomLevel,
      },
      userPermissions: userCanvas.permissions,
    });
  } catch (error) {
    console.log("Error loading canvas:", error);
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
      // Update canvas timestamp
      await touchCanvasTimestamp(canvasId);

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

    // Update connections involving this draft
    const allConnections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
    });

    for (const conn of allConnections) {
      // Filter out the deleted draft from source and target arrays
      const filteredSources = (conn.source_draft_ids || []).filter(
        (src) => src.draft_id !== draftId
      );
      const filteredTargets = (conn.target_draft_ids || []).filter(
        (tgt) => tgt.draft_id !== draftId
      );

      // If either array is empty, delete the connection
      if (filteredSources.length === 0 || filteredTargets.length === 0) {
        await conn.destroy();
      } else {
        // Otherwise, update with filtered arrays
        conn.source_draft_ids = filteredSources;
        conn.target_draft_ids = filteredTargets;
        await conn.save();
      }
    }

    const affectedRows = await CanvasDraft.destroy({
      where: {
        canvas_id: canvasId,
        draft_id: draftId,
      },
    });

    if (affectedRows > 0) {
      await touchCanvasTimestamp(canvasId);

      const canvas = await Canvas.findByPk(canvasId);
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId },
        attributes: ["positionX", "positionY"],
        include: [
          { model: Draft, attributes: ["name", "id", "picks", "type"] },
        ],
        raw: true,
        nest: true,
      });
      const connections = await CanvasConnection.findAll({
        where: { canvas_id: canvasId },
        raw: true,
      });
      res
        .status(200)
        .json({ success: true, message: "Draft removed from canvas" });
      socketService.emitToRoom(canvasId, "canvasUpdate", {
        canvas: canvas.toJSON(),
        drafts: canvasDrafts,
        connections: connections,
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

router.post("/", async (req, res) => {
  try {
    const { draftId, name, description, icon } = req.body;
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Create empty canvas (no draft)
    if (!draftId) {
      const canvas = await Canvas.create({
        name: name || "New Canvas",
        description: description,
        icon: icon || "",
      });

      await UserCanvas.create({
        canvas_id: canvas.id,
        user_id: user.id,
        permissions: "admin",
      });

      return res.json({
        success: true,
        canvas: {
          id: canvas.id,
          name: canvas.name,
          description: canvas.description,
          drafts: [],
        },
      });
    }

    // Create canvas from draft (existing behavior)
    const draft = await Draft.findByPk(draftId);
    const isSharedWith = await draftHasSharedWithUser(draft, user);
    if (!draft.public && draft.owner_id !== user.id && !isSharedWith) {
      return res
        .status(403)
        .json({ error: "Not authorized to use this draft" });
    }

    const canvas = await Canvas.create({
      name: name || draft.name + " Canvas",
      description: description,
      icon: icon || "",
    });
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
        description: canvas.description,
        drafts: [draft.toJSON()],
      },
    });
  } catch (error) {
    console.error("Failed to save canvas:", error);
    res.status(500).json({ error: "Failed to save canvas" });
  }
});

// Import existing standalone draft to canvas
router.post("/:canvasId/import/draft", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { draftId, positionX, positionY } = req.body;

    if (!draftId) {
      return res.status(400).json({ error: "draftId is required" });
    }

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

    const draft = await Draft.findByPk(draftId);
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    // Check user has access to the draft
    if (draft.owner_id !== req.user.id && !draft.public) {
      const isSharedWith = await draftHasSharedWithUser(draft, req.user);
      if (!isSharedWith) {
        return res.status(403).json({ error: "Not authorized to use this draft" });
      }
    }

    // Determine if draft is from versus series (locked) or standalone (editable)
    const isLocked = draft.type === "versus" || !!draft.versus_draft_id;
    const sourceType = draft.versus_draft_id ? "versus" : (draft.type || "standalone");

    const canvasDraft = await CanvasDraft.create({
      canvas_id: canvasId,
      draft_id: draftId,
      positionX: positionX ?? 50,
      positionY: positionY ?? 50,
      is_locked: isLocked,
      source_type: sourceType,
    });

    await touchCanvasTimestamp(canvasId);

    // Fetch the full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex"] }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(201).json({
      success: true,
      canvasDraft: {
        ...canvasDraft.toJSON(),
        Draft: draft.toJSON(),
      },
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
    });
  } catch (error) {
    console.error("Failed to import draft:", error);
    res.status(500).json({ error: "Failed to import draft" });
  }
});

// Import versus series as a group
router.post("/:canvasId/import/series", protect, async (req, res) => {
  const t = await Canvas.sequelize.transaction();
  try {
    const { canvasId } = req.params;
    const { versusDraftId, positionX, positionY } = req.body;

    if (!versusDraftId) {
      return res.status(400).json({ error: "versusDraftId is required" });
    }

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      await t.rollback();
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    const versusDraft = await VersusDraft.findByPk(versusDraftId, {
      include: [{ model: Draft, as: "Drafts" }],
    });

    if (!versusDraft) {
      await t.rollback();
      return res.status(404).json({ error: "Versus series not found" });
    }

    // Create the group container
    const group = await CanvasGroup.create(
      {
        canvas_id: canvasId,
        name: versusDraft.name,
        type: "series",
        positionX: positionX ?? 50,
        positionY: positionY ?? 50,
        versus_draft_id: versusDraftId,
        metadata: {
          blueTeamName: versusDraft.blueTeamName,
          redTeamName: versusDraft.redTeamName,
          length: versusDraft.length,
          competitive: versusDraft.competitive,
          seriesType: versusDraft.type,
        },
      },
      { transaction: t }
    );

    // Create CanvasDraft for each game in the series
    const drafts = versusDraft.Drafts || [];
    const sortedDrafts = [...drafts].sort((a, b) => a.seriesIndex - b.seriesIndex);

    const createdCanvasDrafts = [];
    for (let i = 0; i < sortedDrafts.length; i++) {
      const draft = sortedDrafts[i];
      const canvasDraft = await CanvasDraft.create(
        {
          canvas_id: canvasId,
          draft_id: draft.id,
          positionX: 20 + i * 380, // Horizontal layout within group
          positionY: 60,
          is_locked: true,
          group_id: group.id,
          source_type: "versus",
        },
        { transaction: t }
      );
      createdCanvasDrafts.push({
        ...canvasDraft.toJSON(),
        Draft: draft.toJSON(),
      });
    }

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch all groups for response
    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
      include: [
        {
          model: CanvasDraft,
          include: [{ model: Draft }],
        },
      ],
    });

    // Fetch full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type", "versus_draft_id", "seriesIndex"] }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(201).json({
      success: true,
      group: {
        ...group.toJSON(),
        CanvasDrafts: createdCanvasDrafts,
      },
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    await t.rollback();
    console.error("Failed to import series:", error);
    res.status(500).json({ error: "Failed to import series" });
  }
});

// Delete a group from canvas
router.delete("/:canvasId/group/:groupId", protect, async (req, res) => {
  const t = await Canvas.sequelize.transaction();
  try {
    const { canvasId, groupId } = req.params;

    const userCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (
      !userCanvas ||
      (userCanvas.permissions !== "edit" && userCanvas.permissions !== "admin")
    ) {
      await t.rollback();
      return res.status(403).json({
        error: "Forbidden: You don't have permission to edit this canvas",
      });
    }

    // Delete all CanvasDrafts in the group
    await CanvasDraft.destroy({
      where: { group_id: groupId, canvas_id: canvasId },
      transaction: t,
    });

    // Delete the group
    const affectedRows = await CanvasGroup.destroy({
      where: { id: groupId, canvas_id: canvasId },
      transaction: t,
    });

    if (affectedRows === 0) {
      await t.rollback();
      return res.status(404).json({ error: "Group not found" });
    }

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch updated canvas data
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["positionX", "positionY", "is_locked", "group_id", "source_type"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type"] }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(200).json({ success: true, message: "Group deleted" });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    await t.rollback();
    console.error("Failed to delete group:", error);
    res.status(500).json({ error: "Failed to delete group" });
  }
});

// Update group position
router.put("/:canvasId/group/:groupId/position", protect, async (req, res) => {
  try {
    const { canvasId, groupId } = req.params;
    const { positionX, positionY } = req.body;

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

    const [affectedRows] = await CanvasGroup.update(
      { positionX, positionY },
      { where: { id: groupId, canvas_id: canvasId } }
    );

    if (affectedRows === 0) {
      return res.status(404).json({ error: "Group not found" });
    }

    await touchCanvasTimestamp(canvasId);

    res.status(200).json({ success: true, message: "Group position updated" });

    socketService.emitToRoom(canvasId, "groupMoved", {
      groupId,
      positionX,
      positionY,
    });
  } catch (error) {
    console.error("Failed to update group position:", error);
    res.status(500).json({ error: "Failed to update group position" });
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

    await CanvasConnection.destroy({
      where: { canvas_id: canvasId },
      transaction: t,
    });
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

    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof zoom !== "number"
    ) {
      return res.status(400).json({ error: "Invalid viewport data" });
    }

    const [userCanvas] = await UserCanvas.findOrCreate({
      where: {
        canvas_id: canvasId,
        user_id: user.id,
      },
    });

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
    const { name, description, icon } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Invalid canvas name" });
    }

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

    const canvas = await Canvas.findByPk(canvasId);

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    canvas.name = name;
    if (description !== undefined) {
      canvas.description = description;
    }
    if (icon !== undefined) {
      canvas.icon = icon;
    }
    await canvas.save();

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvas.id },
      attributes: ["positionX", "positionY"],
      include: [{ model: Draft, attributes: ["name", "id", "picks", "type"] }],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvas.id },
      raw: true,
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
      connections: connections,
    });
  } catch (error) {
    console.error("Failed to update canvas name:", error);
    res.status(500).json({ error: "Failed to update canvas name" });
  }
});

router.get("/:canvasId/users", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;

    const requesterUserCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!requesterUserCanvas) {
      return res
        .status(403)
        .json({ error: "Forbidden: You don't have access to this canvas" });
    }

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

    const requesterUserCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!requesterUserCanvas || requesterUserCanvas.permissions !== "admin") {
      return res
        .status(403)
        .json({ error: "Forbidden: You must be an admin to manage users" });
    }

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

    const requesterUserCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!requesterUserCanvas || requesterUserCanvas.permissions !== "admin") {
      return res
        .status(403)
        .json({ error: "Forbidden: You must be an admin to remove users" });
    }

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

router.post("/:canvasId/connections", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { sourceDraftIds, targetDraftIds, style, vertices } = req.body;

    // Validation
    if (!Array.isArray(sourceDraftIds) || sourceDraftIds.length === 0) {
      return res.status(400).json({
        error: "At least one source is required",
      });
    }

    if (!Array.isArray(targetDraftIds) || targetDraftIds.length === 0) {
      return res.status(400).json({
        error: "At least one target is required",
      });
    }

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

    // Validate all draft IDs exist on this canvas
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["draft_id"],
    });
    const validDraftIds = new Set(canvasDrafts.map((cd) => cd.draft_id));

    for (const src of sourceDraftIds) {
      if (!validDraftIds.has(src.draftId)) {
        return res.status(400).json({
          error: `Source draft ${src.draftId} not found on canvas`,
        });
      }
    }

    for (const tgt of targetDraftIds) {
      if (!validDraftIds.has(tgt.draftId)) {
        return res.status(400).json({
          error: `Target draft ${tgt.draftId} not found on canvas`,
        });
      }
    }

    // Transform to backend format
    const sourceDraftIdsFormatted = sourceDraftIds.map((src) => ({
      draft_id: src.draftId,
      anchor_type: src.anchorType || "top",
    }));

    const targetDraftIdsFormatted = targetDraftIds.map((tgt) => ({
      draft_id: tgt.draftId,
      anchor_type: tgt.anchorType || "top",
    }));

    const connection = await CanvasConnection.create({
      canvas_id: canvasId,
      source_draft_ids: sourceDraftIdsFormatted,
      target_draft_ids: targetDraftIdsFormatted,
      vertices: vertices || [],
      style: style || "solid",
    });

    await touchCanvasTimestamp(canvasId);

    res.status(201).json({
      success: true,
      connection: connection.toJSON(),
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    socketService.emitToRoom(canvasId, "connectionCreated", {
      connection: connection.toJSON(),
      allConnections: connections,
    });
  } catch (error) {
    console.error("Failed to create connection:", error);
    res.status(500).json({ error: "Failed to create connection" });
  }
});

router.patch(
  "/:canvasId/connections/:connectionId",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId } = req.params;
      const { addSource, addTarget } = req.body;

      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: canvasId, user_id: req.user.id },
      });

      if (
        !userCanvas ||
        (userCanvas.permissions !== "edit" &&
          userCanvas.permissions !== "admin")
      ) {
        return res.status(403).json({
          error: "Forbidden: You don't have permission to edit this canvas",
        });
      }

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      // Validate draft exists on canvas
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId },
        attributes: ["draft_id"],
      });
      const validDraftIds = new Set(canvasDrafts.map((cd) => cd.draft_id));

      if (addSource) {
        if (!validDraftIds.has(addSource.draftId)) {
          return res.status(400).json({
            error: `Draft ${addSource.draftId} not found on canvas`,
          });
        }

        const newSource = {
          draft_id: addSource.draftId,
          anchor_type: addSource.anchorType || "top",
        };

        // Check if already exists
        const exists = connection.source_draft_ids.some(
          (src) => src.draft_id === newSource.draft_id
        );

        if (!exists) {
          connection.source_draft_ids = [
            ...connection.source_draft_ids,
            newSource,
          ];
          connection.changed("source_draft_ids", true);
        }
      }

      if (addTarget) {
        if (!validDraftIds.has(addTarget.draftId)) {
          return res.status(400).json({
            error: `Draft ${addTarget.draftId} not found on canvas`,
          });
        }

        const newTarget = {
          draft_id: addTarget.draftId,
          anchor_type: addTarget.anchorType || "top",
        };

        // Check if already exists
        const exists = connection.target_draft_ids.some(
          (tgt) => tgt.draft_id === newTarget.draft_id
        );

        if (!exists) {
          connection.target_draft_ids = [
            ...connection.target_draft_ids,
            newTarget,
          ];
          connection.changed("target_draft_ids", true);
        }
      }

      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(200).json({
        success: true,
        connection: connection.toJSON(),
      });

      const connections = await CanvasConnection.findAll({
        where: { canvas_id: canvasId },
        raw: true,
      });

      socketService.emitToRoom(canvasId, "connectionUpdated", {
        connection: connection.toJSON(),
        allConnections: connections,
      });
    } catch (error) {
      console.error("Failed to update connection:", error);
      res.status(500).json({ error: "Failed to update connection" });
    }
  }
);

router.delete(
  "/:canvasId/connections/:connectionId",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId } = req.params;

      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: canvasId, user_id: req.user.id },
      });

      if (
        !userCanvas ||
        (userCanvas.permissions !== "edit" &&
          userCanvas.permissions !== "admin")
      ) {
        return res.status(403).json({
          error: "Forbidden: You don't have permission to edit this canvas",
        });
      }

      const affectedRows = await CanvasConnection.destroy({
        where: {
          id: connectionId,
          canvas_id: canvasId,
        },
      });

      if (affectedRows > 0) {
        await touchCanvasTimestamp(canvasId);

        res.status(200).json({
          success: true,
          message: "Connection deleted",
        });

        const connections = await CanvasConnection.findAll({
          where: { canvas_id: canvasId },
          raw: true,
        });

        socketService.emitToRoom(canvasId, "connectionDeleted", {
          connectionId,
          allConnections: connections,
        });
      } else {
        res.status(404).json({
          success: false,
          message: "Connection not found",
        });
      }
    } catch (error) {
      console.error("Failed to delete connection:", error);
      res.status(500).json({ error: "Failed to delete connection" });
    }
  }
);

// Vertex Management Endpoints

// Create a new vertex on a connection
router.post(
  "/:canvasId/connections/:connectionId/vertices",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId } = req.params;
      const { x, y, insertAfterIndex } = req.body;

      if (typeof x !== "number" || typeof y !== "number") {
        return res.status(400).json({
          error: "Invalid vertex coordinates",
        });
      }

      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: canvasId, user_id: req.user.id },
      });

      if (
        !userCanvas ||
        (userCanvas.permissions !== "edit" &&
          userCanvas.permissions !== "admin")
      ) {
        return res.status(403).json({
          error: "Forbidden: You don't have permission to edit this canvas",
        });
      }

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      // Generate unique ID for the new vertex
      const { v4: uuidv4 } = require("uuid");
      const newVertex = {
        id: uuidv4(),
        x,
        y,
      };

      // Insert vertex at specified index or append to end
      const vertices = [...(connection.vertices || [])];
      if (typeof insertAfterIndex === "number" && insertAfterIndex >= 0) {
        vertices.splice(insertAfterIndex + 1, 0, newVertex);
      } else {
        vertices.push(newVertex);
      }

      connection.vertices = vertices;
      connection.changed("vertices", true);
      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(201).json({
        success: true,
        vertex: newVertex,
        connection: connection.toJSON(),
      });

      const connections = await CanvasConnection.findAll({
        where: { canvas_id: canvasId },
        raw: true,
      });

      socketService.emitToRoom(canvasId, "vertexCreated", {
        connectionId: connection.id,
        vertex: newVertex,
        allConnections: connections,
      });
    } catch (error) {
      console.error("Failed to create vertex:", error);
      res.status(500).json({ error: "Failed to create vertex" });
    }
  }
);

// Update a vertex position (for dragging)
router.put(
  "/:canvasId/connections/:connectionId/vertices/:vertexId",
  protect,
  async (req, res) => {
    try {
      console.log("Updating vertex position");
      const { canvasId, connectionId, vertexId } = req.params;
      const { x, y } = req.body;

      if (typeof x !== "number" || typeof y !== "number") {
        return res.status(400).json({
          error: "Invalid vertex coordinates",
        });
      }

      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: canvasId, user_id: req.user.id },
      });

      if (
        !userCanvas ||
        (userCanvas.permissions !== "edit" &&
          userCanvas.permissions !== "admin")
      ) {
        return res.status(403).json({
          error: "Forbidden: You don't have permission to edit this canvas",
        });
      }

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      const vertices = connection.vertices || [];
      const vertexIndex = vertices.findIndex((v) => v.id === vertexId);

      if (vertexIndex === -1) {
        return res.status(404).json({
          error: "Vertex not found",
        });
      }

      vertices[vertexIndex].x = x;
      vertices[vertexIndex].y = y;

      connection.vertices = vertices;
      connection.changed("vertices", true);
      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(200).json({
        success: true,
        vertex: vertices[vertexIndex],
      });

      socketService.emitToRoom(canvasId, "vertexUpdated", {
        connectionId: connection.id,
        vertexId: vertices[vertexIndex].id,
        x: vertices[vertexIndex].x,
        y: vertices[vertexIndex].y,
      });
    } catch (error) {
      console.error("Failed to update vertex:", error);
      res.status(500).json({ error: "Failed to update vertex" });
    }
  }
);

// Delete a vertex and auto-reconnect
router.delete(
  "/:canvasId/connections/:connectionId/vertices/:vertexId",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId, vertexId } = req.params;

      const userCanvas = await UserCanvas.findOne({
        where: { canvas_id: canvasId, user_id: req.user.id },
      });

      if (
        !userCanvas ||
        (userCanvas.permissions !== "edit" &&
          userCanvas.permissions !== "admin")
      ) {
        return res.status(403).json({
          error: "Forbidden: You don't have permission to edit this canvas",
        });
      }

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      const vertices = connection.vertices || [];
      const filteredVertices = vertices.filter((v) => v.id !== vertexId);

      if (filteredVertices.length === vertices.length) {
        return res.status(404).json({
          error: "Vertex not found",
        });
      }

      connection.vertices = filteredVertices;
      connection.changed("vertices", true);
      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(200).json({
        success: true,
        message: "Vertex deleted",
        connection: connection.toJSON(),
      });

      socketService.emitToRoom(canvasId, "vertexDeleted", {
        connectionId: connection.id,
        vertexId,
      });
    } catch (error) {
      console.error("Failed to delete vertex:", error);
      res.status(500).json({ error: "Failed to delete vertex" });
    }
  }
);

module.exports = router;
