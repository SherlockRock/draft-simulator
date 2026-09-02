import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The 2026-08-28 incident ran on Sequelize's implicit defaults (max 5,
 * acquire 60 s). The pool must be explicit, env-tunable, and default to
 * values that fail fast.
 */
function freshDatabase() {
  const p = require.resolve("../../config/database");
  delete require.cache[p];
  return require("../../config/database");
}

const saved = {};
beforeEach(() => {
  for (const k of ["DB_POOL_MAX", "DB_POOL_ACQUIRE_MS", "DB_POOL_IDLE_MS"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("database pool config", () => {
  it("defaults to max 10, acquire 15 s, idle 10 s, min 0", () => {
    const sequelize = freshDatabase();
    expect(sequelize.options.pool).toMatchObject({
      max: 10,
      min: 0,
      acquire: 15000,
      idle: 10000,
    });
  });

  it("reads overrides from the environment", () => {
    process.env.DB_POOL_MAX = "3";
    process.env.DB_POOL_ACQUIRE_MS = "2500";
    process.env.DB_POOL_IDLE_MS = "500";
    const sequelize = freshDatabase();
    expect(sequelize.options.pool).toMatchObject({ max: 3, acquire: 2500, idle: 500 });
  });
});
