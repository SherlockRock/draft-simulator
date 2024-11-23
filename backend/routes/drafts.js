const express = require('express');
const router = express.Router();
const Draft = require('../models/Draft');

router.get('/', async (req, res) => {
  console.log('drafts?')
  try {
    const drafts = await Draft.findAll();
    res.json(drafts);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;