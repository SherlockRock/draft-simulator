const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const sequelize = require("../config/database");
const Pool = require("../models/Pool");
const { CanvasPoolPlacement } = require("../models/Canvas.js");
const { assertCanvasAccess } = require("../services/canvasMutations");
const {
  respondCanvasMutationError,
} = require("../middleware/canvasMutationErrors");
const { touchCanvasTimestamp } = require("../services/canvasWriteGuards");
const { buildCanvasSnapshot } = require("./canvasProjections");
const { RolePoolMapSchema } = require("@draft-sim/shared-types");

const NOT_AUTHORIZED =
  "Forbidden: You don't have permission to edit this canvas";

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);
const isValidName = (value) =>
  typeof value === "string" && value.trim().length >= 1 && value.length <= 120;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function placementJson(placement, pool) {
  return { ...placement.toJSON(), Pool: pool.toJSON() };
}

// The annotation routes' ordering, kept deliberately: touch + snapshot BEFORE
// the response (a throw there must land in the catch while the response is
// still writable), only the bare emit after it. Inlined per-route rather
// than behind a shared helper: the repo's static canvasUpdate-payload guard
// (tests/routes/canvasSnapshotProjection.test.js) traces the emitted
// variable back to its own enclosing function's `await
// buildCanvasSnapshot(...)` and does not cross into a wrapper function.

router.post("/:canvasId/pools", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const { positionX, positionY, name, champions, sourceId } = req.body;
    if (positionX !== undefined && !isFiniteNumber(positionX)) {
      return res.status(400).json({ error: "Invalid positionX" });
    }
    if (positionY !== undefined && !isFiniteNumber(positionY)) {
      return res.status(400).json({ error: "Invalid positionY" });
    }
    if (name !== undefined && !isValidName(name)) {
      return res.status(400).json({ error: "Invalid name" });
    }
    let parsedChampions;
    if (champions !== undefined) {
      const parsed = RolePoolMapSchema.safeParse(champions);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "champions must be a RolePoolMap" });
      }
      parsedChampions = parsed.data; // parse RESULT — unknown keys stripped
    }
    // UUID-typed column: a malformed value would 500 at Postgres, not 400.
    if (sourceId !== undefined && !UUID_RE.test(String(sourceId))) {
      return res.status(400).json({ error: "Invalid sourceId" });
    }

    const findExisting = () =>
      CanvasPoolPlacement.findOne({
        where: { canvas_id: canvasId, source_id: sourceId },
        include: [{ model: Pool }],
      });

    // Sync idempotency layer 1: precheck.
    if (sourceId) {
      const existing = await findExisting();
      if (existing) {
        return res
          .status(200)
          .json({ success: true, pool: existing.toJSON() });
      }
    }

    let result;
    try {
      result = await sequelize.transaction(async (t) => {
        const created = await Pool.create(
          {
            name: name !== undefined ? name.trim() : "New Pool",
            champions: parsedChampions,
          },
          { transaction: t },
        );
        const placed = await CanvasPoolPlacement.create(
          {
            canvas_id: canvasId,
            pool_id: created.id,
            positionX: positionX ?? 50,
            positionY: positionY ?? 50,
            source_id: sourceId ?? null,
          },
          { transaction: t },
        );
        return { pool: created, placement: placed };
      });
    } catch (error) {
      // Sync idempotency layer 2: two concurrent syncs can both miss the
      // precheck; the partial unique index rejects the loser — hand it the
      // winner's row instead of a 500.
      if (sourceId && error.name === "SequelizeUniqueConstraintError") {
        const existing = await findExisting();
        if (existing) {
          return res
            .status(200)
            .json({ success: true, pool: existing.toJSON() });
        }
      }
      throw error;
    }

    await touchCanvasTimestamp(canvasId);
    const snapshot = await buildCanvasSnapshot(canvasId);
    res
      .status(201)
      .json({ success: true, pool: placementJson(result.placement, result.pool) });
    socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
  } catch (error) {
    if (respondCanvasMutationError(res, error, { NOT_AUTHORIZED })) return;
    console.error("Failed to create canvas pool:", error);
    res.status(500).json({ error: "Failed to create canvas pool" });
  }
});

router.patch("/:canvasId/pools/:placementId", protect, async (req, res) => {
  try {
    const { canvasId, placementId } = req.params;
    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const placement = await CanvasPoolPlacement.findOne({
      where: { id: placementId, canvas_id: canvasId },
      include: [{ model: Pool }],
    });
    if (!placement) {
      return res.status(404).json({ error: "Pool not found" });
    }

    const { positionX, positionY, name } = req.body;
    if (positionX !== undefined && !isFiniteNumber(positionX)) {
      return res.status(400).json({ error: "Invalid positionX" });
    }
    if (positionY !== undefined && !isFiniteNumber(positionY)) {
      return res.status(400).json({ error: "Invalid positionY" });
    }
    if (name !== undefined && !isValidName(name)) {
      return res.status(400).json({ error: "Invalid name" });
    }

    if (positionX !== undefined || positionY !== undefined) {
      await placement.update({
        ...(positionX !== undefined ? { positionX } : {}),
        ...(positionY !== undefined ? { positionY } : {}),
      });
    }
    if (name !== undefined) {
      placement.Pool.name = name.trim();
      await placement.Pool.save();
    }

    await touchCanvasTimestamp(canvasId);
    const snapshot = await buildCanvasSnapshot(canvasId);
    res
      .status(200)
      .json({ success: true, pool: placementJson(placement, placement.Pool) });
    socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
  } catch (error) {
    if (respondCanvasMutationError(res, error, { NOT_AUTHORIZED })) return;
    console.error("Failed to update canvas pool:", error);
    res.status(500).json({ error: "Failed to update canvas pool" });
  }
});

router.delete("/:canvasId/pools/:placementId", protect, async (req, res) => {
  try {
    const { canvasId, placementId } = req.params;
    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const placement = await CanvasPoolPlacement.findOne({
      where: { id: placementId, canvas_id: canvasId },
      include: [{ model: Pool }],
    });
    if (!placement) {
      return res.status(404).json({ error: "Pool not found" });
    }

    // The Pool row is the unit of deletion (design §1.4); the placement dies
    // by CASCADE.
    await placement.Pool.destroy();

    await touchCanvasTimestamp(canvasId);
    const snapshot = await buildCanvasSnapshot(canvasId);
    res.status(200).json({ success: true, message: "Pool deleted" });
    socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
  } catch (error) {
    if (respondCanvasMutationError(res, error, { NOT_AUTHORIZED })) return;
    console.error("Failed to delete canvas pool:", error);
    res.status(500).json({ error: "Failed to delete canvas pool" });
  }
});

module.exports = router;
