import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTtlCache } = require("../../services/ttlCache");

// A hand-cranked clock beats fake timers here: the cache only ever reads `now`,
// so the tests stay explicit about which instant each call happens at.
function clock(start = 0) {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
}

describe("createTtlCache", () => {
  it("returns a stored value before the TTL elapses", () => {
    const c = clock();
    const cache = createTtlCache({ ttlMs: 1000, now: c.now });
    cache.set("a", "value");
    c.advance(999);
    expect(cache.get("a")).toBe("value");
  });

  it("returns undefined once the TTL has elapsed", () => {
    const c = clock();
    const cache = createTtlCache({ ttlMs: 1000, now: c.now });
    cache.set("a", "value");
    c.advance(1000);
    expect(cache.get("a")).toBeUndefined();
  });

  it("drops an expired entry rather than merely hiding it", () => {
    const c = clock();
    const cache = createTtlCache({ ttlMs: 1000, now: c.now });
    cache.set("a", "value");
    c.advance(1000);
    cache.get("a");
    expect(cache.size).toBe(0);
  });

  it("distinguishes keys", () => {
    const cache = createTtlCache({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  it("re-setting a key restarts its TTL", () => {
    const c = clock();
    const cache = createTtlCache({ ttlMs: 1000, now: c.now });
    cache.set("a", "old");
    c.advance(900);
    cache.set("a", "new");
    c.advance(900);
    expect(cache.get("a")).toBe("new");
  });

  it("evicts the least-recently-used entry past maxEntries", () => {
    const cache = createTtlCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("a read marks an entry as recently used, sparing it from eviction", () => {
    const cache = createTtlCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("delete removes a live entry", () => {
    const cache = createTtlCache({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("clear empties the cache", () => {
    const cache = createTtlCache({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
