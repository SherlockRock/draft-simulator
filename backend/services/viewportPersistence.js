const sequelize = require("../config/database");
const { UserCanvas } = require("../models/Canvas.js");

// Postgres SQLSTATE for "canceling statement due to lock timeout".
const PG_LOCK_NOT_AVAILABLE = "55P03";

// Postgres SQLSTATE for "canceling statement due to statement timeout".
const PG_QUERY_CANCELED = "57014";

// How long the viewport write may wait on the membership row before giving
// up. The viewport is a disposable preference: the next pan re-sends it, so
// queueing behind a stalled commit is strictly worse than dropping it.
const LOCK_TIMEOUT_MS = 2000;

// How long the UPDATE itself may run once it has the lock. lock_timeout only
// bounds the wait to ACQUIRE the lock; a WAL/buffer stall inside the write
// (the 2026-08-28 incident) is otherwise unbounded. Deliberately greater
// than LOCK_TIMEOUT_MS so, under pure lock contention, the lock timeout
// always fires first and the integration test stays unambiguous.
const STATEMENT_TIMEOUT_MS = 5000;

function pgCode(error) {
  return error?.original?.code ?? error?.parent?.code ?? null;
}

/**
 * Persist a user's last viewport for a canvas.
 *
 * Runs as ONE UPDATE inside a transaction that (a) turns off synchronous
 * commit — losing the last ~half-second of viewport on a crash is fine, and
 * it means the row lock is released without waiting for the WAL fsync —
 * (b) caps the lock wait, so a stalled commit elsewhere cannot queue this
 * write and, through it, exhaust the pool, and (c) caps the statement
 * itself, so a stall inside the UPDATE (WAL/buffer I/O) after the lock is
 * already held cannot run unbounded (2026-08-28 incident).
 *
 * @returns {Promise<"saved" | "no-access" | "lock-timeout">} "lock-timeout"
 *   means the write was dropped because it could not complete within its
 *   bounded wait (either acquiring the lock or running the statement).
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
      await sequelize.query(
        `SET LOCAL statement_timeout TO '${STATEMENT_TIMEOUT_MS}ms'`,
        { transaction: t },
      );
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
    const code = pgCode(error);
    if (code === PG_LOCK_NOT_AVAILABLE || code === PG_QUERY_CANCELED) {
      return "lock-timeout";
    }
    throw error;
  }
}

module.exports = {
  persistViewport,
  LOCK_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  PG_LOCK_NOT_AVAILABLE,
  PG_QUERY_CANCELED,
};
