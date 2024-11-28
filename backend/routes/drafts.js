const express = require("express");
const router = express.Router();
const Draft = require("../models/Draft");

router.get("/", async (req, res) => {
  console.log("drafts?");
  try {
    const drafts = await Draft.findAll();
    res.json(drafts);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.get("/:id", async (req, res) => {
  console.log("get draft");
  try {
    const drafts = await Draft.findByPk(req.params.id);
    res.json(drafts);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.post("/", async (req, res) => {
  console.log("new draft");
  try {
    const draft = await Draft.create();
    res.json(draft);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

router.delete("/:id", async (req, res) => {
  console.log("delete draft");
  try {
    console.log(req.params.id);
    const draft = await Draft.findByPk(req.params.id);
    draft.destroy();
    res.json(req.params.id);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

module.exports = router;
