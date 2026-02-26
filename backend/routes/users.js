const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { Canvas, UserCanvas, CanvasDraft, CanvasGroup, CanvasConnection } = require("../models/Canvas");
const Draft = require("../models/Draft");
const VersusDraft = require("../models/VersusDraft");
const VersusParticipant = require("../models/VersusParticipant");
const UserToken = require("../models/UserToken");

router.get("/", async (req, res) => {
  const token = req.cookies.paseto;
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const user = await User.findByPk(req.params.id);
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server Error" });
  }
});

router.get("/me/export", protect, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user basic info
    const user = {
      name: req.user.name,
      email: req.user.email,
      picture: req.user.picture,
      createdAt: req.user.createdAt,
    };

    // Get canvases where user has admin permissions (owner)
    const userCanvases = await UserCanvas.findAll({
      where: { user_id: userId, permissions: "admin" },
      include: [{
        model: Canvas,
        include: [
          { model: CanvasDraft, include: [{ model: Draft }] },
          { model: CanvasGroup },
        ],
      }],
    });

    const canvases = userCanvases.map((uc) => ({
      id: uc.Canvas.id,
      name: uc.Canvas.name,
      description: uc.Canvas.description,
      icon: uc.Canvas.icon,
      createdAt: uc.Canvas.createdAt,
      drafts: uc.Canvas.CanvasDrafts.map((cd) => ({
        id: cd.Draft.id,
        name: cd.Draft.name,
        picks: cd.Draft.picks,
        positionX: cd.positionX,
        positionY: cd.positionY,
      })),
      groups: uc.Canvas.CanvasGroups.map((g) => ({
        id: g.id,
        name: g.name,
        type: g.type,
        positionX: g.positionX,
        positionY: g.positionY,
      })),
    }));

    // Get versus series owned by user
    const versusSeries = await VersusDraft.findAll({
      where: { owner_id: userId },
      include: [
        { model: Draft, as: "Drafts" },
        { model: VersusParticipant },
      ],
    });

    const series = versusSeries.map((vs) => ({
      id: vs.id,
      seriesLength: vs.series_length,
      draftType: vs.draft_type,
      blueTeamName: vs.blue_team_name,
      redTeamName: vs.red_team_name,
      status: vs.status,
      createdAt: vs.createdAt,
      drafts: vs.Drafts.map((d) => ({
        id: d.id,
        name: d.name,
        picks: d.picks,
        gameNumber: d.game_number,
        winner: d.winner,
      })),
    }));

    res.json({
      exportedAt: new Date().toISOString(),
      user,
      canvases,
      versusSeries: series,
    });
  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Failed to export data" });
  }
});

router.delete("/me", protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const { confirmEmail } = req.body;

    // Validate email confirmation
    if (!confirmEmail || confirmEmail !== req.user.email) {
      return res.status(400).json({ error: "Email confirmation does not match" });
    }

    // 1. Get canvases where user is admin (owner)
    const ownedCanvases = await UserCanvas.findAll({
      where: { user_id: userId, permissions: "admin" },
    });
    const ownedCanvasIds = ownedCanvases.map((uc) => uc.canvas_id);

    // 2. For each owned canvas, find drafts that are ONLY on that canvas
    for (const canvasId of ownedCanvasIds) {
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId },
      });

      for (const cd of canvasDrafts) {
        // Check if this draft exists on any OTHER canvas not owned by user
        const otherCanvasLinks = await CanvasDraft.findAll({
          where: { draft_id: cd.draft_id },
        });

        const isSharedElsewhere = otherCanvasLinks.some(
          (link) => !ownedCanvasIds.includes(link.canvas_id)
        );

        if (!isSharedElsewhere) {
          // Safe to delete the draft
          await Draft.destroy({ where: { id: cd.draft_id } });
        }
      }

      // Delete all UserCanvas entries for this canvas (including shared users)
      await UserCanvas.destroy({ where: { canvas_id: canvasId } });

      // Delete all connections on this canvas
      await CanvasConnection.destroy({ where: { canvas_id: canvasId } });

      // Delete the canvas (cascades to CanvasDraft, CanvasGroup, etc.)
      await Canvas.destroy({ where: { id: canvasId } });
    }

    // 3. Anonymize versus series (set owner_id to null)
    await VersusDraft.update(
      { owner_id: null },
      { where: { owner_id: userId } }
    );

    // 4. Delete user tokens
    await UserToken.destroy({ where: { UserId: userId } });

    // 5. Delete UserCanvas entries (for shared canvases user doesn't own)
    await UserCanvas.destroy({ where: { user_id: userId } });

    // 6. Delete user
    await req.user.destroy();

    // 7. Clear cookies
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });
    res.clearCookie("accessToken", {
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });

    res.json({ success: true, message: "Account deleted" });
  } catch (error) {
    console.error("Delete account error:", error);
    res.status(500).json({ error: "Failed to delete account" });
  }
});

module.exports = router;
