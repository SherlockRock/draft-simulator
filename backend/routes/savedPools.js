const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const SavedPool = require("../models/SavedPool");

const EMPTY_ROLE_POOL_MAP = {
  top: [],
  jungle: [],
  mid: [],
  adc: [],
  support: [],
};

function isValidRolePoolMap(value) {
  if (!value || typeof value !== "object") return false;
  for (const role of ["top", "jungle", "mid", "adc", "support"]) {
    if (!Array.isArray(value[role])) return false;
    if (!value[role].every((id) => typeof id === "string")) return false;
  }
  return true;
}

function isValidName(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 1 &&
    value.length <= 120
  );
}

async function findPoolForUser(poolId, userId) {
  const pool = await SavedPool.findByPk(poolId);
  if (!pool) return { status: 404, payload: { error: "Saved pool not found" } };
  if (pool.owner_id !== userId) {
    return { status: 403, payload: { error: "Not authorized" } };
  }
  return { pool };
}

router.get("/", protect, async (req, res) => {
  try {
    const pools = await SavedPool.findAll({
      where: { owner_id: req.user.id },
      order: [["updatedAt", "DESC"]],
    });
    res.json(pools);
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
    const pool = champions ?? EMPTY_ROLE_POOL_MAP;
    if (!isValidRolePoolMap(pool)) {
      return res.status(400).json({ error: "champions must be a RolePoolMap" });
    }
    const created = await SavedPool.create({
      owner_id: req.user.id,
      name: name.trim(),
      champions: pool,
    });
    res.status(201).json(created);
  } catch (error) {
    console.error("Error creating saved pool:", error);
    res.status(500).json({ error: "Failed to create saved pool" });
  }
});

router.get("/:id", protect, async (req, res) => {
  try {
    const result = await findPoolForUser(req.params.id, req.user.id);
    if (!result.pool) return res.status(result.status).json(result.payload);
    res.json(result.pool);
  } catch (error) {
    console.error("Error fetching saved pool:", error);
    res.status(500).json({ error: "Failed to fetch saved pool" });
  }
});

router.patch("/:id", protect, async (req, res) => {
  try {
    const result = await findPoolForUser(req.params.id, req.user.id);
    if (!result.pool) return res.status(result.status).json(result.payload);

    if (Object.prototype.hasOwnProperty.call(req.body, "name")) {
      if (!isValidName(req.body.name)) {
        return res
          .status(400)
          .json({ error: "name must be a non-empty string up to 120 chars" });
      }
      result.pool.name = req.body.name.trim();
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "champions")) {
      if (!isValidRolePoolMap(req.body.champions)) {
        return res
          .status(400)
          .json({ error: "champions must be a RolePoolMap" });
      }
      result.pool.champions = req.body.champions;
    }

    await result.pool.save();
    res.json(result.pool);
  } catch (error) {
    console.error("Error updating saved pool:", error);
    res.status(500).json({ error: "Failed to update saved pool" });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const result = await findPoolForUser(req.params.id, req.user.id);
    if (!result.pool) return res.status(result.status).json(result.payload);
    await result.pool.destroy();
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting saved pool:", error);
    res.status(500).json({ error: "Failed to delete saved pool" });
  }
});

module.exports = router;
