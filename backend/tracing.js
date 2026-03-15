// Load .env before checking OTel config (--require runs before dotenv in index.js)
require("dotenv").config();

const { env } = require("node:process");

// Only initialize OTel when endpoint is configured (production/staging)
if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const util = require("node:util");
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
  const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
  const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
  const { BatchLogRecordProcessor, LoggerProvider } = require("@opentelemetry/sdk-logs");
  const { logs } = require("@opentelemetry/api-logs");
  const { resourceFromAttributes } = require("@opentelemetry/resources");

  const serviceName = env.OTEL_SERVICE_NAME || "firstpick-backend";
  const resource = resourceFromAttributes({ "service.name": serviceName });

  // --- Traces ---
  const traceExporter = new OTLPTraceExporter();

  // --- Metrics ---
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 30000,
  });

  // --- Logs ---
  const logExporter = new OTLPLogExporter();
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor(logExporter)],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  // --- Console Patch ---
  const logger = loggerProvider.getLogger("console");
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args) => {
    logger.emit({ body: util.format(...args), severityText: "INFO" });
    originalLog.apply(console, args);
  };

  console.error = (...args) => {
    logger.emit({ body: util.format(...args), severityText: "ERROR" });
    originalError.apply(console, args);
  };

  console.warn = (...args) => {
    logger.emit({ body: util.format(...args), severityText: "WARN" });
    originalWarn.apply(console, args);
  };

  // --- SDK Init ---
  const sdk = new NodeSDK({
    serviceName,
    traceExporter,
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable fs instrumentation (noisy, low value)
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // Disable DNS (noisy)
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();

  // Graceful shutdown — flush telemetry without calling process.exit(),
  // so other shutdown handlers (Express, DB) can complete
  const shutdown = () => {
    sdk.shutdown()
      .then(() => loggerProvider.shutdown())
      .catch((err) => {
        originalError("OTel shutdown error:", err);
      });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  originalLog(`OpenTelemetry initialized for service: ${serviceName}`);

  // --- Socket.IO Metrics ---
  const { metrics } = require("@opentelemetry/api");
  const meter = metrics.getMeter("socketio");

  const socketConnections = meter.createUpDownCounter("socketio.connections", {
    description: "Active Socket.IO connections",
  });

  const socketEvents = meter.createCounter("socketio.events", {
    description: "Socket.IO events processed",
  });

  const socketEventDuration = meter.createHistogram("socketio.event.duration", {
    description: "Socket.IO event handler duration in ms",
    unit: "ms",
  });

  // Export for use in index.js
  module.exports = {
    socketConnections,
    socketEvents,
    socketEventDuration,
  };
}

// When OTel is not enabled, export empty object
if (!module.exports.socketConnections) {
  module.exports = {};
}
