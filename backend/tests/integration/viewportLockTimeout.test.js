import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const sequelize = require("../../config/database");
const User = require("../../models/User");
const { Canvas, UserCanvas } = require("../../models/Canvas.js");
const {
  persistViewport,
  LOCK_TIMEOUT_MS,
} = require("../../services/viewportPersistence");

/**
 * Regression seam for the 2026-08-28 incident: another transaction holds the
 * membership row (as a stalled commit would). The viewport write must give
 * up in ~LOCK_TIMEOUT_MS instead of queueing, and an unrelated query must
 * still get through while the row is held.
 *
 * Needs a real Postgres: RUN_DB_TESTS=1 pnpm vitest run tests/integration
 */
const run = process.env.RUN_DB_TESTS === "1" ? describe : describe.skip;

run("persistViewport under a held row lock", () => {
  const userId = randomUUID();
  const canvasId = randomUUID();

  beforeAll(async () => {
    await User.create({
      id: userId,
      name: "lock-test",
      email: `lock-test-${userId}@example.invalid`,
    });
    await Canvas.create({ id: canvasId, name: "lock-test" });
    await UserCanvas.create({ user_id: userId, canvas_id: canvasId, permissions: "admin" });
  });

  afterAll(async () => {
    await UserCanvas.destroy({ where: { canvas_id: canvasId } });
    await Canvas.destroy({ where: { id: canvasId } });
    await User.destroy({ where: { id: userId } });
    await sequelize.close();
  });

  it("returns lock-timeout in about LOCK_TIMEOUT_MS and leaves the pool usable", async () => {
    const holder = await sequelize.transaction();
    await sequelize.query(
      'SELECT 1 FROM "UserCanvases" WHERE user_id = :userId AND canvas_id = :canvasId FOR UPDATE',
      { replacements: { userId, canvasId }, transaction: holder },
    );

    try {
      const started = Date.now();
      const outcome = await persistViewport({
        userId,
        canvasId,
        viewport: { x: 1, y: 2, zoom: 1 },
      });
      const elapsed = Date.now() - started;

      expect(outcome).toBe("lock-timeout");
      expect(elapsed).toBeGreaterThanOrEqual(LOCK_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(LOCK_TIMEOUT_MS + 1500);

      // The pool is not wedged: an unrelated query completes while the row is still held.
      const [[row]] = await sequelize.query("SELECT 1 AS ok");
      expect(row.ok).toBe(1);
    } finally {
      await holder.rollback();
    }
  });

  it("saves normally once the lock is released", async () => {
    await expect(
      persistViewport({ userId, canvasId, viewport: { x: 5, y: 6, zoom: 2 } }),
    ).resolves.toBe("saved");
    const row = await UserCanvas.findOne({ where: { user_id: userId, canvas_id: canvasId } });
    expect(row.lastZoomLevel).toBe(2);
  });
});
