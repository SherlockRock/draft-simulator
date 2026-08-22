import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboard } from "./dashboard.mjs";

const region = (over = {}) => ({
  summoners: 27000,
  summonersErrored: 3,
  matches: { pending: 4000, fetched: 1200, skipped: 40, failed: 2 },
  fetchedLast24h: 1200,
  fetchedLastHour: 700,
  patchMix: [
    { patch: "16.15", count: 400 },
    { patch: "16.16", count: 800 },
  ],
  likelyKeyExpired: false,
  ...over,
});

const status = (overrides = {}) => ({
  generatedAt: "2026-08-22T22:30:00.000Z",
  regions: {
    na1: region(),
    euw1: region({ matches: { pending: 900, fetched: 300, skipped: 8, failed: 0 } }),
    kr: region(overrides.kr ?? {}),
  },
});

// Strip ANSI escapes so assertions read the visible text.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("renderDashboard shows every region with its counts and rates", () => {
  const out = plain(renderDashboard(status(), { now: Date.parse("2026-08-22T22:30:05Z") }));
  for (const name of ["na1", "euw1", "kr"]) assert.ok(out.includes(name), `missing ${name}`);
  assert.match(out, /4[,.]?000/); // na1 pending
  assert.match(out, /700\/h/); // hourly rate
  assert.match(out, /16\.16/); // patch mix
  assert.ok(out.includes("FIRST PICK"), "missing title");
});

test("renderDashboard shows a healthy key state and totals", () => {
  const out = plain(renderDashboard(status(), { now: Date.now() }));
  assert.match(out, /KEY OK/);
  assert.match(out, /2[,.]?700/); // total fetched 1200+300+1200
});

test("renderDashboard flags a stalled region loudly", () => {
  const out = plain(
    renderDashboard(status({ kr: { likelyKeyExpired: true } }), { now: Date.now() }),
  );
  assert.match(out, /KEY EXPIRED|STALLED/);
});
