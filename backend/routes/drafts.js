const express = require("express");
const router = express.Router();
const Draft = require("../models/Draft");
const { protect, getUserFromRequest } = require("../middleware/auth");
const socketService = require("../middleware/socketService");

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
    res.status(500).send("Server Error");
  }
});

router.get("/:id", async (req, res) => {
  try {
    const draft = await Draft.findByPk(req.params.id);

    if (!draft) {
      return res.status(404).send("Draft not found");
    }

    if (draft.public) {
      return res.json(draft);
    }

    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).send("Not authorized, no user found");
    }

    if (draft.owner_id === user.id) {
      return res.status(200).json(draft);
    }

    // Check if the user has been granted access
    const isSharedWith = await draft.hasSharedWith(user);
    if (isSharedWith) {
      return res.status(200).json(draft);
    }

    return res.status(403).send("Not authorized to view this draft");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server Error");
  }
});

router.post("/", protect, async (req, res) => {
  try {
    const { name } = req.body;
    const publicStatus = req.body.public;
    const draft = await Draft.create({
      owner_id: req.user.id,
      name: name,
      public: publicStatus,
    });
    res.json(draft);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const draft = await Draft.findByPk(req.params.id);
    if (draft.owner_id !== req.user.id) {
      return res.status(403).send("Not authorized to delete this draft");
    }
    await draft.destroy();
    res.json(req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.put("/:id", protect, async (req, res) => {
  try {
    const { name, public: publicStatus } = req.body;
    const draft = await Draft.findByPk(req.params.id);

    if (!draft) {
      return res.status(404).send("Draft not found");
    }

    if (draft.owner_id !== req.user.id) {
      return res.status(403).send("Not authorized to edit this draft");
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
    res.status(500).send("Server Error");
  }
});

module.exports = router;
