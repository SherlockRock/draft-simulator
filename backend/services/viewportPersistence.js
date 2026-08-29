const sequelize = require("../config/database");
const { UserCanvas } = require("../models/Canvas.js");

// Postgres SQLSTATE for "canceling statement due to lock timeout".
const PG_LOCK_NOT_AVAILABLE = "55P03";

// How long the viewport write may wait on the membership row before giving
// up. The viewport is a disposable preference: the next pan re-sends it, so
// queueing behind a stalled commit is strictly worse than dropping it.
const LOCK_TIMEOUT_MS = 2000;

function pgCode(error) {
  return error?.original?.code ?? error?.parent?.code ?? null;
}

/**
 * Persist a user's last viewport for a canvas.
 *
 * Runs as ONE UPDATE inside a transaction that (a) turns off synchronous
 * commit — losing the last ~half-second of viewport on a crash is fine, and
 * it means the row lock is released without waiting for the WAL fsync —
 * and (b) caps the lock wait, so a stalled commit elsewhere cannot queue
 * this write and, through it, exhaust the pool (2026-08-28 incident).
 *
 * @returns {Promise<"saved" | "no-access" | "lock-timeout">}
 */
async function persistViewport({ userId, canvasId, viewport }) {
  try {
    return await sequelize.transaction(async (t) => {
      await sequelize.query("SET LOCAL synchronous_commit TO off", {
        transaction: t,
      });
      await sequelize.query(`SET LOCAL lock_timeout TO '${LOCK_TIMEOUT_MS}ms'`, {
        transaction: t,
      });
      const [affected] = await UserCanvas.update(
        {
          lastViewportX: viewport.x,
          lastViewportY: viewport.y,
          lastZoomLevel: viewport.zoom,
          lastAccessedAt: new Date(),
        },
        { where: { user_id: userId, canvas_id: canvasId }, transaction: t },
      );
      return affected === 0 ? "no-access" : "saved";
    });
  } catch (error) {
    if (pgCode(error) === PG_LOCK_NOT_AVAILABLE) return "lock-timeout";
    throw error;
  }
}

module.exports = { persistViewport, LOCK_TIMEOUT_MS, PG_LOCK_NOT_AVAILABLE };
