const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const Draft = require("../models/Draft");
const { Canvas, UserCanvas } = require("../models/Canvas");
const User = require("../models/User");
const { protect, getUserFromRequest } = require("../middleware/auth");

router.post("/:draftId/share", protect, async (req, res) => {
  try {
    const { userId, accessLevel } = req.body;
    const draft = await Draft.findByPk(req.params.draftId);

    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    if (draft.owner_id !== req.user.id) {
      return res
        .status(403)
        .json({ error: "Not authorized to share this draft" });
    }

    const userToShareWith = await User.findByPk(userId);
    if (!userToShareWith) {
      return res.status(404).json({ error: "User not found" });
    }

    await draft.addSharedWith(userToShareWith, {
      through: { access_level: accessLevel },
    });

    res.status(200).json({ message: "Draft shared successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.post("/:draftId/generate-link", protect, async (req, res) => {
  try {
    const draft = await Draft.findByPk(req.params.draftId);

    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    if (draft.owner_id !== req.user.id) {
      return res.status(403).json({
        error: "Not authorized to generate a share link for this draft",
      });
    }

    const shareToken = jwt.sign(
      { draftId: draft.id },
      process.env.SHARE_JWT_SECRET,
      { expiresIn: "1h" }
    );
    const shareLink = `${process.env.FRONTEND_ORIGIN}/share/draft?token=${shareToken}`;

    res.json({ shareLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.get("/verify-link", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      console.log("NO USER - Returning 401");
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { token } = req.query;
    if (!token) {
      console.log("NO TOKEN PROVIDED");
      return res.status(400).json({ error: "Share token is required" });
    }

    const decoded = jwt.verify(token, process.env.SHARE_JWT_SECRET);
    const draft = await Draft.findByPk(decoded.draftId);

    if (!draft) {
      console.log("DRAFT NOT FOUND for ID:", decoded.draftId);
      return res.status(404).json({ error: "Draft not found" });
    }

    const existingAccess = await User.getSharedWith({
      where: { id: user.id },
    });

    if (!existingAccess.length > 0) {
      await draft.addSharedWith(user, { through: { access_level: "viewer" } });
    }

    res.json({ success: true, draftId: draft.id });
  } catch (err) {
    console.error("SHARE VERIFICATION ERROR:", err);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Share link has expired." });
    } else if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid share link." });
    }
    res.status(500).json({ error: "Server Error" });
  }
});

// Canvas share routes
router.post("/:canvasId/share", protect, async (req, res) => {
  try {
    const { userId, accessLevel } = req.body;
    const canvas = await Canvas.findByPk(req.params.canvasId);

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    // Check if user is owner or has admin permissions
    const userCanvas = await canvas.getUsers({
      where: { id: req.user.id },
      through: { where: { permissions: "admin" } },
    });

    if (userCanvas.length === 0) {
      return res
        .status(403)
        .json({ error: "Not authorized to share this canvas" });
    }

    const userToShareWith = await User.findByPk(userId);
    if (!userToShareWith) {
      return res.status(404).json({ error: "User not found" });
    }

    await canvas.addSharedWith(userToShareWith, {
      through: { access_level: accessLevel },
    });

    res.status(200).json({ message: "Canvas shared successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.post("/:canvasId/generate-canvas-link", protect, async (req, res) => {
  try {
    const canvas = await Canvas.findByPk(req.params.canvasId);
    const { permissions } = req.body; // Get permission level from request body

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    // Check if user is owner or has admin permissions
    const userCanvas = await canvas.getUsers({
      where: { id: req.user.id },
      through: { where: { permissions: "admin" } },
    });

    if (userCanvas.length === 0) {
      return res.status(403).json({
        error: "Not authorized to generate a share link for this canvas",
      });
    }

    const validPermissions = ["view", "edit"];
    const sharePermissions = validPermissions.includes(permissions)
      ? permissions
      : "view";

    const shareToken = jwt.sign(
      { canvasId: canvas.id, permissions: sharePermissions },
      process.env.SHARE_JWT_SECRET,
      { expiresIn: "1h" }
    );
    const shareLink = `${process.env.FRONTEND_ORIGIN}/share/canvas?token=${shareToken}`;

    res.json({ shareLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.get("/verify-canvas-link", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      console.log("NO USER - Returning 401");
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { token } = req.query;
    if (!token) {
      console.log("No token provided");
      return res.status(400).json({ error: "Share token is required" });
    }

    const decoded = jwt.verify(token, process.env.SHARE_JWT_SECRET);
    const canvas = await Canvas.findByPk(decoded.canvasId);

    if (!canvas) {
      console.log("CANVAS NOT FOUND for ID:", decoded.canvasId);
      return res.status(404).json({ error: "Canvas not found" });
    }

    const sharePermissions = decoded.permissions || "view";

    const existingAccess = await UserCanvas.findOne({
      where: {
        canvas_id: canvas.id,
        user_id: user.id,
      },
    });

    if (!existingAccess) {
      await UserCanvas.create({
        canvas_id: canvas.id,
        user_id: user.id,
        permissions: sharePermissions,
      });
    } else if (
      existingAccess.permissions === "view" &&
      sharePermissions === "edit"
    ) {
      await existingAccess.update({ permissions: "edit" });
    }

    res.json({ success: true, canvasId: canvas.id });
  } catch (err) {
    console.error("CANVAS SHARE VERIFICATION ERROR:", err);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Share link has expired." });
    } else if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid share link." });
    }
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
