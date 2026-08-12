const { Canvas, CanvasGroup } = require("../models/Canvas");

/**
 * A canvas item's `group_id` is a container reference, and until step 4 nothing
 * validated it on any path: a crafted id could park an item in another canvas's
 * Group — or a deleted one — where it renders on neither canvas.
 *
 * One helper rather than a check per route, because the write paths
 * (`PUT /draft-positions`, `PUT /draft/:draftId`, `POST /draft/:draftId/copy`,
 * and every annotation route) drifting apart is the failure mode this whole
 * area keeps reproducing.
 *
 * ⚠️ **This is containment, NOT authorization.** The Canvas Mutation Gate
 * answers "may this actor change this canvas"; this answers "does this id
 * belong to this canvas". Neither substitutes for the other, and an annotation
 * `group_id` must be fed in on EVERY write path or the hole reopens for a new
 * item type (design §3).
 *
 * Returns the first id that is not on the canvas, or null. Non-strings (an
 * explicit `null` to ungroup, an absent key) are ignored, and an empty set
 * costs no query. Pass `known` when the caller already holds the canvas's
 * Groups — the batch endpoint locks them and must not re-read.
 */
async function findGroupNotOnCanvas({ canvasId, groupIds, transaction, known }) {
  const wanted = [
    ...new Set(groupIds.filter((groupId) => typeof groupId === "string")),
  ];
  if (wanted.length === 0) return null;
  const onCanvas =
    known ??
    new Set(
      (
        await CanvasGroup.findAll({
          where: { canvas_id: canvasId, id: wanted },
          attributes: ["id"],
          transaction,
        })
      ).map((row) => row.id),
    );
  return wanted.find((groupId) => !onCanvas.has(groupId)) ?? null;
}

/**
 * Bump a Canvas's `updatedAt` so the activity feed and the canvas list order
 * reflect a write to something the Canvas row itself does not hold.
 *
 * `transaction` is optional: `canvas.js` calls this after its transaction has
 * committed, `users.js` calls it inside one. The two used to be separate
 * copies with different signatures.
 */
async function touchCanvasTimestamp(canvasId, transaction) {
  const canvas = await Canvas.findByPk(canvasId, { transaction });
  if (!canvas) return null;
  canvas.changed("updatedAt", true);
  await canvas.save({ transaction, silent: false });
  return canvas;
}

module.exports = { findGroupNotOnCanvas, touchCanvasTimestamp };
