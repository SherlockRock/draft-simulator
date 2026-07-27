import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const log = require("../../utils/logger");

// The gate is the whole point of this module: debug output has to stay off
// unless someone opts in, or the production log firehose comes straight back.
describe("logger", () => {
  let spy;
  const original = process.env.DEBUG_LOGS;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    if (original === undefined) {
      delete process.env.DEBUG_LOGS;
    } else {
      process.env.DEBUG_LOGS = original;
    }
  });

  it("stays silent when DEBUG_LOGS is unset", () => {
    delete process.env.DEBUG_LOGS;
    log.debug("noisy", { payload: "large" });
    expect(spy).not.toHaveBeenCalled();
    expect(log.isEnabled()).toBe(false);
  });

  it("stays silent for any value other than the string 'true'", () => {
    for (const value of ["1", "yes", "false", ""]) {
      process.env.DEBUG_LOGS = value;
      log.debug("noisy");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits when DEBUG_LOGS is 'true'", () => {
    process.env.DEBUG_LOGS = "true";
    log.debug("visible", 42);
    expect(spy).toHaveBeenCalledWith("visible", 42);
    expect(log.isEnabled()).toBe(true);
  });

  // Reading the flag lazily is what lets config/database.js require this
  // module before dotenv has populated the environment.
  it("picks up a flag set after the module was required", () => {
    delete process.env.DEBUG_LOGS;
    expect(log.isEnabled()).toBe(false);
    process.env.DEBUG_LOGS = "true";
    expect(log.isEnabled()).toBe(true);
  });
});
