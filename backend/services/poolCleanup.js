const Pool = require("../models/Pool");
const SavedPool = require("../models/SavedPool");
const { CanvasPoolPlacement } = require("../models/Canvas");

// The Pool row is the unit of deletion (design §1.4): FKs cascade pool →
// parent, never parent → pool, so bulk parent deletes must destroy the
// claimed Pool rows FIRST or they orphan. Callers: canvas DELETE route,
// users.js clearCanvasContents, users.js DELETE /me.
async function destroyPoolsForCanvas(canvasId, transaction) {
  const placements = await CanvasPoolPlacement.findAll({
    where: { canvas_id: canvasId },
    attributes: ["pool_id"],
    transaction,
  });
  if (placements.length === 0) return;
  await Pool.destroy({
    where: { id: placements.map((p) => p.pool_id) },
    transaction,
  });
}

async function destroyPoolsForSavedEntries(userId, transaction) {
  const entries = await SavedPool.findAll({
    where: { owner_id: userId },
    attributes: ["pool_id"],
    transaction,
  });
  if (entries.length === 0) return;
  await Pool.destroy({
    where: { id: entries.map((e) => e.pool_id) },
    transaction,
  });
}

module.exports = { destroyPoolsForCanvas, destroyPoolsForSavedEntries };
