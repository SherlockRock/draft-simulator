const express = require("express");
const router = express.Router();
const User = require("../models/User");

// router.get("/", async (req, res) => {
//   console.log("drafts?");
//   try {
//     const drafts = await Draft.findAll();
//     res.json(drafts);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Server Error");
//   }
// });

router.get("/", async (req, res) => {
  const token = req.cookies.paseto;
  if (!token) {
    return res.status(401).send("Unauthorized");
  }
  try {
    const user = await User.findByPk(req.params.id);
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// router.post("/", async (req, res) => {
//   console.log("new draft");
//   try {
//     const draft = await Draft.create();
//     res.json(draft);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Server Error");
//   }
// });

// router.delete("/:id", async (req, res) => {
//   console.log("delete draft");
//   try {
//     console.log(req.params.id);
//     const draft = await Draft.findByPk(req.params.id);
//     draft.destroy();
//     res.json(req.params.id);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Server Error");
//   }
// });

module.exports = router;
