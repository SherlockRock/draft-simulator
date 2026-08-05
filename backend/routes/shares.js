const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { Canvas, UserCanvas } = require("../models/Canvas");
const User = require("../models/User");
const { protect, getUserFromRequest } = require("../middleware/auth");

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
      { expiresIn: "7d" },
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
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: "Share token is required" });
    }

    // Expiry gates handing out NEW access, so an expired token still has to be
    // read: someone who already has access should be let through on it.
    let decoded;
    let expired = false;
    try {
      decoded = jwt.verify(token, process.env.SHARE_JWT_SECRET);
    } catch (err) {
      if (err.name !== "TokenExpiredError") {
        return res.status(400).json({ error: "Invalid share link." });
      }
      expired = true;
      decoded = jwt.verify(token, process.env.SHARE_JWT_SECRET, {
        ignoreExpiration: true,
      });
    }

    const canvas = await Canvas.findByPk(decoded.canvasId);

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    const sharePermissions = decoded.permissions || "view";

    const existingAccess = await UserCanvas.findOne({
      where: {
        canvas_id: canvas.id,
        user_id: user.id,
      },
    });

    if (existingAccess) {
      if (
        !expired &&
        existingAccess.permissions === "view" &&
        sharePermissions === "edit"
      ) {
        await existingAccess.update({ permissions: "edit" });
      }
      return res.json({ success: true, canvasId: canvas.id });
    }

    if (expired) {
      return res.status(410).json({ error: "Share link has expired." });
    }

    await UserCanvas.create({
      canvas_id: canvas.id,
      user_id: user.id,
      permissions: sharePermissions,
    });

    res.json({ success: true, canvasId: canvas.id });
  } catch (err) {
    console.error("CANVAS SHARE VERIFICATION ERROR:", err);
    res.status(500).json({ error: "Server Error" });
  }
});

module.exports = router;
