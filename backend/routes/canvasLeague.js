// League series onto a canvas (S3 plan D2–D5, D11). Mounted on /api/canvas
// after routes/canvas.js, which has no route with these paths. The route is
// thin: validation, access, then services/leagueCanvas/send.js does the DB
// work in one transaction. Reads the mirror only; never reaches esclub.

const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const canvasMutations = require("../services/canvasMutations");
const canvasWriteGuards = require("../services/canvasWriteGuards");
const canvasProjections = require("./canvasProjections");
const {
  respondCanvasMutationError,
} = require("../middleware/canvasMutationErrors");
const send = require("../services/leagueCanvas/send");

/**
 * POST /api/canvas/:canvasId/import/league-series
 * Body `{leagueSeriesIds: string[1..50], positionX, positionY, rowStep?}`.
 * 201 when something was created (200 otherwise) with
 * `{created: [{leagueSeriesId, groupId}], existing: [...], skipped:
 * [{leagueSeriesId, reason}]}`; one snapshot and one broadcast when created.
 */
router.post("/:canvasId/import/league-series", protect, async (req, res) => {
  const { canvasId } = req.params;
  const validated = send.validateSendBody(req.body);
  if (!validated.ok) {
    return res.status(400).json({ error: validated.error });
  }

  try {
    await canvasMutations.assertCanvasAccess({
      userId: req.user.id,
      canvasId,
      level: "edit",
    });

    const result = await send.sendLeagueSeries({
      canvasId,
      userId: req.user.id,
      ...validated.value,
    });

    if (result.created.length === 0) {
      return res.status(200).json(result);
    }

    await canvasWriteGuards.touchCanvasTimestamp(canvasId);
    const snapshot = await canvasProjections.buildCanvasSnapshot(canvasId);
    res.status(201).json(result);
    socketService.emitToRoom(canvasId, "canvasUpdate", snapshot);
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    if (error instanceof send.CanvasNotFoundError) {
      return res.status(404).json({ error: "Canvas not found" });
    }
    // The class only: an error's message or fields could carry row data.
    console.error(
      "Failed to send league series:",
      (error && error.constructor && error.constructor.name) || typeof error,
    );
    res.status(500).json({ error: "Failed to send league series" });
  }
});

module.exports = router;
