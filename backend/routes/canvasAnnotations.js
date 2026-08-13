const express = require("express");
const router = express.Router();
const { CanvasAnnotation } = require("../models/Canvas.js");
const { protect } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const { assertCanvasAccess } = require("../services/canvasMutations");
const {
  respondCanvasMutationError,
} = require("../middleware/canvasMutationErrors");
const {
  findGroupNotOnCanvas,
  touchCanvasTimestamp,
} = require("../services/canvasWriteGuards");
const { buildCanvasSnapshot } = require("./canvasProjections");

const NOT_AUTHORIZED =
  "Forbidden: You don't have permission to edit this canvas";

const VALID_COLORS = new Set([
  "none",
  "slate",
  "purple",
  "teal",
  "amber",
  "crimson",
  "emerald",
]);
const VALID_FONT_SIZES = new Set(["sm", "md", "lg", "xl"]);

const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 120;

const FIELD_VALIDATORS = {
  positionX: (value) => typeof value === "number" && Number.isFinite(value),
  positionY: (value) => typeof value === "number" && Number.isFinite(value),
  width: (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0,
  height: (value) =>
    typeof value === "number" && Number.isFinite(value) && value > 0,
  manualWidth: (value) =>
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value > 0),
  manualHeight: (value) =>
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value > 0),
  text: (value) => typeof value === "string",
  championIds: (value) =>
    Array.isArray(value) && value.every((id) => typeof id === "string"),
  color: (value) => VALID_COLORS.has(value),
  fontSize: (value) => VALID_FONT_SIZES.has(value),
  group_id: (value) => value === null || typeof value === "string",
};

const hasKey = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);

function collectWritableFields(body) {
  const updates = {};
  for (const [field, isValid] of Object.entries(FIELD_VALIDATORS)) {
    if (!hasKey(body, field)) continue;
    if (!isValid(body[field])) return { invalidField: field };
    updates[field] = body[field];
  }
  return { updates };
}

router.post("/:canvasId/annotations", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const { updates, invalidField } = collectWritableFields(req.body);
    if (invalidField) {
      return res.status(400).json({ error: `Invalid ${invalidField}` });
    }

    const foreignGroup = await findGroupNotOnCanvas({
      canvasId,
      groupIds: [updates.group_id],
    });
    if (foreignGroup) {
      return res
        .status(404)
        .json({ error: `Group ${foreignGroup} not found on canvas` });
    }

    const annotation = await CanvasAnnotation.create({
      canvas_id: canvasId,
      positionX: updates.positionX ?? 50,
      positionY: updates.positionY ?? 50,
      width: updates.width ?? DEFAULT_WIDTH,
      height: updates.height ?? DEFAULT_HEIGHT,
      text: updates.text ?? "",
      championIds: updates.championIds ?? [],
      color: updates.color ?? "slate",
      fontSize: updates.fontSize ?? "md",
      group_id: updates.group_id ?? null,
    });

    await touchCanvasTimestamp(canvasId);
    const snapshot = await buildCanvasSnapshot(canvasId);
    res.status(201).json({ success: true, annotation: annotation.toJSON() });
    socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
  } catch (error) {
    if (respondCanvasMutationError(res, error, { NOT_AUTHORIZED })) return;
    console.error("Failed to create annotation:", error);
    res.status(500).json({ error: "Failed to create annotation" });
  }
});

router.patch("/:canvasId/annotations/:annotationId", protect, async (req, res) => {
  try {
    const { canvasId, annotationId } = req.params;
    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const { updates, invalidField } = collectWritableFields(req.body);
    if (invalidField) {
      return res.status(400).json({ error: `Invalid ${invalidField}` });
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const foreignGroup = await findGroupNotOnCanvas({
      canvasId,
      groupIds: [updates.group_id],
    });
    if (foreignGroup) {
      return res
        .status(404)
        .json({ error: `Group ${foreignGroup} not found on canvas` });
    }

    const annotation = await CanvasAnnotation.findOne({
      where: { id: annotationId, canvas_id: canvasId },
    });
    if (!annotation) {
      return res.status(404).json({ error: "Annotation not found" });
    }

    await annotation.update(updates);
    await touchCanvasTimestamp(canvasId);
    const snapshot = await buildCanvasSnapshot(canvasId);
    res.status(200).json({ success: true, annotation: annotation.toJSON() });
    socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
  } catch (error) {
    if (respondCanvasMutationError(res, error, { NOT_AUTHORIZED })) return;
    console.error("Failed to update annotation:", error);
    res.status(500).json({ error: "Failed to update annotation" });
  }
});

router.delete("/:canvasId/annotations/:annotationId", protect, async (req, res) => {
  try {
    const { canvasId, annotationId } = req.params;
    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const annotation = await CanvasAnnotation.findOne({
      where: { id: annotationId, canvas_id: canvasId },
    });
    if (!annotation) {
      return res.status(404).json({ error: "Annotation not found" });
    }

    await annotation.destroy();
    await touchCanvasTimestamp(canvasId);
    const snapshot = await buildCanvasSnapshot(canvasId);
    res.status(200).json({ success: true, message: "Annotation deleted" });
    socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
  } catch (error) {
    if (respondCanvasMutationError(res, error, { NOT_AUTHORIZED })) return;
    console.error("Failed to delete annotation:", error);
    res.status(500).json({ error: "Failed to delete annotation" });
  }
});

router.post(
  "/:canvasId/annotations/:annotationId/copy",
  protect,
  async (req, res) => {
    try {
      const { canvasId, annotationId } = req.params;
      await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

      const { updates, invalidField } = collectWritableFields(req.body);
      if (invalidField) {
        return res.status(400).json({ error: `Invalid ${invalidField}` });
      }

      const foreignGroup = await findGroupNotOnCanvas({
        canvasId,
        groupIds: [updates.group_id],
      });
      if (foreignGroup) {
        return res
          .status(404)
          .json({ error: `Group ${foreignGroup} not found on canvas` });
      }

      const source = await CanvasAnnotation.findOne({
        where: { id: annotationId, canvas_id: canvasId },
      });
      if (!source) {
        return res.status(404).json({ error: "Annotation not found" });
      }

      const copy = await CanvasAnnotation.create({
        canvas_id: canvasId,
        text: source.text,
        championIds: [...source.championIds],
        color: source.color,
        fontSize: source.fontSize,
        width: source.width,
        height: source.height,
        manualWidth: source.manualWidth,
        manualHeight: source.manualHeight,
        positionX: updates.positionX ?? source.positionX,
        positionY: updates.positionY ?? source.positionY,
        group_id: hasKey(updates, "group_id")
          ? updates.group_id
          : (source.group_id ?? null),
      });

      await touchCanvasTimestamp(canvasId);
      const snapshot = await buildCanvasSnapshot(canvasId);
      res.status(201).json({ success: true, annotation: copy.toJSON() });
      socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
    } catch (error) {
      if (respondCanvasMutationError(res, error, { NOT_AUTHORIZED })) return;
      console.error("Failed to duplicate annotation:", error);
      res.status(500).json({ error: "Failed to duplicate annotation" });
    }
  },
);

module.exports = router;
