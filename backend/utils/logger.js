// Opt-in debug logging.
//
// In production `tracing.js` monkey-patches console.log to also util.format
// every call and emit it as an OTel log record. That made verbose debug
// logging quietly expensive: a single canvas broadcast dumped its whole
// payload, ~170 log lines, and bursts tripped Railway's 500 logs/sec replica
// cap (messages dropped, event loop stalled). Debug output now costs nothing
// unless DEBUG_LOGS is explicitly turned on.
//
// Use `debug` for anything that fires per-request, per-event or per-emit.
// Genuine lifecycle events (server start, socket connect/disconnect) stay on
// plain console.log, and errors stay on console.error — those are low-volume
// and you want them in production.
// Read the env var per call rather than at require time: this module gets
// pulled in by config/database.js, which is itself loaded early enough that
// snapshotting the flag could beat dotenv.config() and silently pin it off.
const isEnabled = () => process.env.DEBUG_LOGS === "true";

const debug = (...args) => {
  if (isEnabled()) {
    console.log(...args);
  }
};

module.exports = { debug, isEnabled };
