const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const Draft = require("../models/Draft");
const User = require("../models/User");
const { protect, getUserFromRequest } = require("../middleware/auth");

router.post("/:draftId/share", protect, async (req, res) => {
  try {
    const { userId, accessLevel } = req.body;
    const draft = await Draft.findByPk(req.params.draftId);

    if (!draft) {
      return res.status(404).send("Draft not found");
    }

    if (draft.owner_id !== req.user.id) {
      return res.status(403).send("Not authorized to share this draft");
    }

    const userToShareWith = await User.findByPk(userId);
    if (!userToShareWith) {
      return res.status(404).send("User not found");
    }

    await draft.addSharedWith(userToShareWith, { through: { access_level: accessLevel } });

    res.status(200).send("Draft shared successfully");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.post("/:draftId/generate-link", protect, async (req, res) => {
  try {
    const draft = await Draft.findByPk(req.params.draftId);

    if (!draft) {
      return res.status(404).send("Draft not found");
    }

    if (draft.owner_id !== req.user.id) {
      return res.status(403).send("Not authorized to generate a share link for this draft");
    }

    const shareToken = jwt.sign({ draftId: draft.id }, process.env.SHARE_JWT_SECRET, { expiresIn: '1h' });
    const shareLink = `${process.env.FRONTEND_ORIGIN}/share?token=${shareToken}`;

    res.json({ shareLink });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.get("/verify-link", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.redirect(process.env.FRONTEND_ORIGIN);
    }

    const { token } = req.query;
    if (!token) {
      return res.status(400).send("Share token is required");
    }

    const decoded = jwt.verify(token, process.env.SHARE_JWT_SECRET);
    const draft = await Draft.findByPk(decoded.draftId);

    if (!draft) {
      return res.status(404).send("Draft not found");
    }

    // Add user to the draft's shared list
    await draft.addSharedWith(user, { through: { access_level: 'viewer' } });

    res.redirect(`${process.env.FRONTEND_ORIGIN}/${draft.id}`);
  } catch (err) {
    console.error(err);
    if (err.name === 'TokenExpiredError') {
      return res.status(401).send("Share link has expired.");
    } else if (err.name === 'JsonWebTokenError') {
      return res.status(401).send("Invalid share link.");
    }
    res.status(500).send("Server Error");
  }
});

module.exports = router;
