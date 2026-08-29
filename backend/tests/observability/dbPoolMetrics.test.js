import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerDbPoolMetrics } = require("../../observability/dbPoolMetrics");

/**
 * Pool starvation must be visible as such (2026-08-28 read as "everything
 * is slow"). Gauges follow OTel db.client.connections.* semantics.
 */
function fakeMeter() {
  const gauges = {};
  return {
    gauges,
    createObservableGauge(name, opts) {
      const g = { name, opts, callbacks: [] };
      g.addCallback = (cb) => g.callbacks.push(cb);
      gauges[name] = g;
      return g;
    },
  };
}

function observe(gauge) {
  const seen = [];
  const result = { observe: (value, attrs) => seen.push({ value, attrs }) };
  for (const cb of gauge.callbacks) cb(result);
  return seen;
}

describe("registerDbPoolMetrics", () => {
  it("reports used/idle connections, pending acquires and the max", () => {
    const sequelize = {
      options: { pool: { max: 10 } },
      connectionManager: { pool: { size: 4, available: 1, using: 3, waiting: 2 } },
    };
    const meter = fakeMeter();

    registerDbPoolMetrics(sequelize, meter);

    expect(observe(meter.gauges["db.client.connections.usage"])).toEqual([
      { value: 3, attrs: { state: "used" } },
      { value: 1, attrs: { state: "idle" } },
    ]);
    expect(observe(meter.gauges["db.client.connections.pending_requests"])).toEqual([
      { value: 2, attrs: undefined },
    ]);
    expect(observe(meter.gauges["db.client.connections.max"])).toEqual([
      { value: 10, attrs: undefined },
    ]);
  });

  it("reads the pool live, not at registration time", () => {
    const pool = { size: 0, available: 0, using: 0, waiting: 0 };
    const sequelize = { options: { pool: { max: 10 } }, connectionManager: { pool } };
    const meter = fakeMeter();
    registerDbPoolMetrics(sequelize, meter);
    pool.using = 7;
    pool.waiting = 5;
    expect(observe(meter.gauges["db.client.connections.usage"])[0].value).toBe(7);
    expect(observe(meter.gauges["db.client.connections.pending_requests"])[0].value).toBe(5);
  });

  it("is a no-op when the pool is not initialised yet", () => {
    const meter = fakeMeter();
    registerDbPoolMetrics({ options: { pool: { max: 10 } }, connectionManager: {} }, meter);
    expect(observe(meter.gauges["db.client.connections.usage"])).toEqual([]);
  });
});
