const express = require("express");
const router = express.Router();
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { Canvas, UserCanvas, CanvasDraft, CanvasGroup, CanvasConnection } = require("../models/Canvas");
const Draft = require("../models/Draft");
const VersusDraft = require("../models/VersusDraft");
const VersusParticipant = require("../models/VersusParticipant");

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

module.exports = router;
