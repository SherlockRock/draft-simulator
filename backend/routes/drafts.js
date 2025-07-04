const express = require("express");
const router = express.Router();
const Draft = require("../models/Draft");

router.get("/dropdown", async (req, res) => {
  try {
    console.log("Fetching all drafts");
    const drafts = await Draft.findAll();
    res.json(drafts.map((draft) => draft.id));
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.get("/", async (req, res) => {
  try {
    console.log("Fetching all drafts");
    const drafts = await Draft.findAll();
    res.json(drafts[0]);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.get("/:id", async (req, res) => {
  try {
    console.log(`Fetching draft with ID: ${req.params.id}`);
    const draft = await Draft.findByPk(req.params.id);
    res.json(draft);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.post("/", async (req, res) => {
  try {
    const draft = await Draft.create();
    res.json(draft);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const draft = await Draft.findByPk(req.params.id);
    draft.destroy();
    res.json(req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
