const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const SavedPool = require("../models/SavedPool");
const Pool = require("../models/Pool");
const sequelize = require("../config/database");
const { RolePoolMapSchema } = require("@draft-sim/shared-types");

const EMPTY_ROLE_POOL_MAP = {
  top: [], jungle: [], mid: [], adc: [], support: [],
};

function isValidName(value) {
  return (
    typeof value === "string" && value.trim().length >= 1 && value.length <= 120
  );
}

// The wire shape predates the Pools split and MUST NOT change (design §5):
// id/owner_id/createdAt from the entry, name/champions/updatedAt from the Pool
// (Pool.updatedAt is the one that moves on edit — keeps "recently edited
// first" sorting honest).
function serializeSavedPool(entry) {
  return {
    id: entry.id,
    owner_id: entry.owner_id,
    name: entry.Pool.name,
    champions: entry.Pool.champions,
    createdAt: entry.createdAt,
    updatedAt: entry.Pool.updatedAt,
  };
}

async function findEntryForUser(entryId, userId) {
  const entry = await SavedPool.findByPk(entryId, { include: [Pool] });
  if (!entry) return { status: 404, payload: { error: "Saved pool not found" } };
  if (entry.owner_id !== userId) {
    return { status: 403, payload: { error: "Not authorized" } };
  }
  return { entry };
}

router.get("/", protect, async (req, res) => {
  try {
    const entries = await SavedPool.findAll({
      where: { owner_id: req.user.id },
      include: [Pool],
      order: [[Pool, "updatedAt", "DESC"]],
    });
    res.json(entries.map(serializeSavedPool));
  } catch (error) {
    console.error("Error fetching saved pools:", error);
    res.status(500).json({ error: "Failed to fetch saved pools" });
  }
});

router.post("/", protect, async (req, res) => {
  try {
    const { name, champions } = req.body;
    if (!isValidName(name)) {
      return res
        .status(400)
        .json({ error: "name must be a non-empty string up to 120 chars" });
    }
    // Persist the parse RESULT, not the raw body — safeParse().data strips
    // unknown keys so they never ride into JSONB.
    const parsed = RolePoolMapSchema.safeParse(champions ?? EMPTY_ROLE_POOL_MAP);
    if (!parsed.success) {
      return res.status(400).json({ error: "champions must be a RolePoolMap" });
    }
    const entry = await sequelize.transaction(async (t) => {
      const pool = await Pool.create(
        { name: name.trim(), champions: parsed.data },
        { transaction: t },
      );
      const created = await SavedPool.create(
        { owner_id: req.user.id, pool_id: pool.id },
        { transaction: t },
      );
      created.Pool = pool;
      return created;
    });
    res.status(201).json(serializeSavedPool(entry));
  } catch (error) {
    console.error("Error creating saved pool:", error);
    res.status(500).json({ error: "Failed to create saved pool" });
  }
});

router.get("/:id", protect, async (req, res) => {
  try {
    const result = await findEntryForUser(req.params.id, req.user.id);
    if (!result.entry) return res.status(result.status).json(result.payload);
    res.json(serializeSavedPool(result.entry));
  } catch (error) {
    console.error("Error fetching saved pool:", error);
    res.status(500).json({ error: "Failed to fetch saved pool" });
  }
});

router.patch("/:id", protect, async (req, res) => {
  try {
    const result = await findEntryForUser(req.params.id, req.user.id);
    if (!result.entry) return res.status(result.status).json(result.payload);
    const pool = result.entry.Pool;

    if (Object.prototype.hasOwnProperty.call(req.body, "name")) {
      if (!isValidName(req.body.name)) {
        return res
          .status(400)
          .json({ error: "name must be a non-empty string up to 120 chars" });
      }
      pool.name = req.body.name.trim();
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "champions")) {
      const parsed = RolePoolMapSchema.safeParse(req.body.champions);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "champions must be a RolePoolMap" });
      }
      pool.champions = parsed.data; // parse RESULT — unknown keys stripped
      pool.changed("champions", true);
    }

    await pool.save();
    res.json(serializeSavedPool(result.entry));
  } catch (error) {
    console.error("Error updating saved pool:", error);
    res.status(500).json({ error: "Failed to update saved pool" });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const result = await findEntryForUser(req.params.id, req.user.id);
    if (!result.entry) return res.status(result.status).json(result.payload);
    // The Pool row is the unit of deletion (design §1.4): destroying it
    // cascades the entry via SavedPools.pool_id ON DELETE CASCADE.
    await result.entry.Pool.destroy();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting saved pool:", error);
    res.status(500).json({ error: "Failed to delete saved pool" });
  }
});

module.exports = router;
