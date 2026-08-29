import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sequelize = require("../../config/database");
const { UserCanvas } = require("../../models/Canvas.js");
const {
  persistViewport,
  LOCK_TIMEOUT_MS,
  PG_LOCK_NOT_AVAILABLE,
} = require("../../services/viewportPersistence");

/**
 * The viewport write must never hold a row lock through a slow commit
 * (2026-08-28 incident: WAL fsync stalls turned one hot row into a queue
 * that ate the whole pool). Contract: one UPDATE, inside a transaction that
 * turns off synchronous commit and caps the lock wait.
 */

let t;
let queries;

beforeEach(() => {
  vi.restoreAllMocks();
  queries = [];
  t = { id: "tx" };
  vi.spyOn(sequelize, "transaction").mockImplementation(async (fn) => fn(t));
  vi.spyOn(sequelize, "query").mockImplementation(async (sql, opts) => {
    queries.push({ sql, opts });
    return [];
  });
});

const input = {
  userId: "u1",
  canvasId: "c1",
  viewport: { x: 10, y: -20, zoom: 1.5 },
};

describe("persistViewport", () => {
  it("issues SET LOCAL synchronous_commit off and lock_timeout inside the transaction, then one UPDATE", async () => {
    vi.spyOn(UserCanvas, "update").mockResolvedValue([1]);

    const result = await persistViewport(input);

    expect(result).toBe("saved");
    expect(queries.map((q) => q.sql)).toEqual([
      "SET LOCAL synchronous_commit TO off",
      `SET LOCAL lock_timeout TO '${LOCK_TIMEOUT_MS}ms'`,
    ]);
    for (const q of queries) expect(q.opts).toEqual({ transaction: t });

    expect(UserCanvas.update).toHaveBeenCalledTimes(1);
    const [values, options] = UserCanvas.update.mock.calls[0];
    expect(values).toMatchObject({
      lastViewportX: 10,
      lastViewportY: -20,
      lastZoomLevel: 1.5,
    });
    expect(values.lastAccessedAt).toBeInstanceOf(Date);
    expect(options).toEqual({
      where: { user_id: "u1", canvas_id: "c1" },
      transaction: t,
    });
  });

  it("returns no-access when the membership row does not exist (0 rows updated)", async () => {
    vi.spyOn(UserCanvas, "update").mockResolvedValue([0]);
    await expect(persistViewport(input)).resolves.toBe("no-access");
  });

  it("returns lock-timeout when Postgres reports lock_not_available (55P03)", async () => {
    const err = new Error("canceling statement due to lock timeout");
    err.original = { code: PG_LOCK_NOT_AVAILABLE };
    err.parent = err.original;
    vi.spyOn(UserCanvas, "update").mockRejectedValue(err);
    await expect(persistViewport(input)).resolves.toBe("lock-timeout");
  });

  it("rethrows any other database error", async () => {
    const err = new Error("boom");
    err.original = { code: "42P01" };
    vi.spyOn(UserCanvas, "update").mockRejectedValue(err);
    await expect(persistViewport(input)).rejects.toBe(err);
  });

  it("never issues a read before the write", async () => {
    vi.spyOn(UserCanvas, "update").mockResolvedValue([1]);
    const findOne = vi.spyOn(UserCanvas, "findOne");
    await persistViewport(input);
    expect(findOne).not.toHaveBeenCalled();
  });
});
