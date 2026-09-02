/**
 * Observable gauges over the Sequelize connection pool, named per the OTel
 * database semantic conventions so Grafana Cloud's DB panels read them.
 *
 * Every callback re-reads `connectionManager.pool` rather than capturing it
 * once, so pool replacement or `sequelize.close()` is tolerated — a missing
 * pool just means nothing is observed for that tick.
 */
function registerDbPoolMetrics(sequelize, meter) {
  const livePool = () => sequelize.connectionManager?.pool ?? null;

  const usage = meter.createObservableGauge("db.client.connections.usage", {
    description: "Sequelize pool connections by state",
    unit: "{connection}",
  });
  usage.addCallback((result) => {
    const pool = livePool();
    if (!pool) return;
    result.observe(pool.using, { state: "used" });
    result.observe(pool.available, { state: "idle" });
  });

  const pending = meter.createObservableGauge("db.client.connections.pending_requests", {
    description: "Acquire requests waiting for a Sequelize pool connection",
    unit: "{request}",
  });
  pending.addCallback((result) => {
    const pool = livePool();
    if (!pool) return;
    result.observe(pool.waiting);
  });

  const max = meter.createObservableGauge("db.client.connections.max", {
    description: "Configured Sequelize pool maximum",
    unit: "{connection}",
  });
  max.addCallback((result) => {
    result.observe(sequelize.options.pool.max);
  });
}

module.exports = { registerDbPoolMetrics };
