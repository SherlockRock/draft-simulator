import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKey, updateEnvContent, StallTracker, isGloballyStalled } from "./key-bot.mjs";

// ---- isGloballyStalled ----

const region = (pending, likelyKeyExpired) => ({ matches: { pending }, likelyKeyExpired });

test("isGloballyStalled: true only when every backlogged region is stale", () => {
  assert.equal(
    isGloballyStalled({ regions: { na1: region(100, true), kr: region(50, true) } }),
    true,
  );
  // One region still fetching → key is alive
  assert.equal(
    isGloballyStalled({ regions: { na1: region(100, true), kr: region(50, false) } }),
    false,
  );
  // Empty-backlog regions don't count either way
  assert.equal(
    isGloballyStalled({ regions: { na1: region(100, true), kr: region(0, false) } }),
    true,
  );
  // No backlog anywhere = idle, not stalled
  assert.equal(
    isGloballyStalled({ regions: { na1: region(0, false), kr: region(0, false) } }),
    false,
  );
});

// ---- extractKey ----

test("extractKey accepts a bare RGAPI key, with surrounding whitespace", () => {
  assert.equal(
    extractKey("RGAPI-12345678-abcd-ef00-1234-567890abcdef"),
    "RGAPI-12345678-abcd-ef00-1234-567890abcdef",
  );
  assert.equal(
    extractKey("  RGAPI-12345678-abcd-ef00-1234-567890abcdef\n"),
    "RGAPI-12345678-abcd-ef00-1234-567890abcdef",
  );
});

test("extractKey rejects chatter, embedded keys, and malformed keys", () => {
  assert.equal(extractKey("here is the key RGAPI-12345678-abcd-ef00-1234-567890abcdef"), null);
  assert.equal(extractKey("!status"), null);
  assert.equal(extractKey("RGAPI-short"), null);
  assert.equal(extractKey("RGAPI-has spaces inside-x"), null);
  assert.equal(extractKey(""), null);
});

// ---- updateEnvContent ----

test("updateEnvContent replaces the RIOT_API_KEY line, preserving everything else", () => {
  const before = "# secrets\nRIOT_API_KEY=RGAPI-old\nDATABASE_URL=postgresql://x\n";
  const after = updateEnvContent(before, "RGAPI-new");
  assert.equal(after, "# secrets\nRIOT_API_KEY=RGAPI-new\nDATABASE_URL=postgresql://x\n");
});

test("updateEnvContent appends the line when missing", () => {
  const after = updateEnvContent("DATABASE_URL=postgresql://x\n", "RGAPI-new");
  assert.equal(after, "DATABASE_URL=postgresql://x\nRIOT_API_KEY=RGAPI-new\n");
});

// ---- StallTracker ----

const HOUR = 3600_000;

test("StallTracker notifies on the stall rising edge only", () => {
  const t = new StallTracker({ renotifyMs: 12 * HOUR });
  assert.equal(t.update(false, 0), null);
  assert.equal(t.update(true, 1 * HOUR), "stalled");
  assert.equal(t.update(true, 1 * HOUR + 60_000), null); // no spam
});

test("StallTracker renotifies after the renotify interval while still stalled", () => {
  const t = new StallTracker({ renotifyMs: 12 * HOUR });
  t.update(true, 0);
  assert.equal(t.update(true, 11 * HOUR), null);
  assert.equal(t.update(true, 13 * HOUR), "stalled");
});

test("StallTracker emits recovery once, only if it had notified", () => {
  const t = new StallTracker({ renotifyMs: 12 * HOUR });
  t.update(true, 0);
  assert.equal(t.update(false, 2 * HOUR), "recovered");
  assert.equal(t.update(false, 3 * HOUR), null);
  // never-stalled tracker stays silent on healthy updates
  const fresh = new StallTracker({ renotifyMs: 12 * HOUR });
  assert.equal(fresh.update(false, 0), null);
});
