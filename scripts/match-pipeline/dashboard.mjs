#!/usr/bin/env node
/**
 * Console dashboard for forge's physical monitor. Runs on tty1 via
 * firstpick-dashboard.service (no X server) and redraws every 5s:
 * per-region counts, hourly rate with a per-day projection, backlog bars,
 * patch mix, and a loud key-state banner.
 *
 * renderDashboard is pure; the tty loop lives at the bottom.
 */

import { createDb } from "./db.mjs";
import { collectStatus } from "./status.mjs";

const ESC = "\x1b[";
const bold = (s) => `${ESC}1m${s}${ESC}0m`;
const dim = (s) => `${ESC}2m${s}${ESC}0m`;
const green = (s) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s) => `${ESC}33m${s}${ESC}0m`;
const red = (s) => `${ESC}1;31m${s}${ESC}0m`;
const cyan = (s) => `${ESC}36m${s}${ESC}0m`;

const n = (x) => x.toLocaleString("en-US");

const bar = (value, max, width) => {
  const filled = max > 0 ? Math.round((Math.min(value, max) / max) * width) : 0;
  return "█".repeat(filled) + dim("░".repeat(width - filled));
};

export function renderDashboard(status, { now, width = 80 }) {
  const lines = [];
  const rule = dim("─".repeat(width));
  const regions = Object.entries(status.regions);
  const stalled = regions.some(([, r]) => r.likelyKeyExpired && r.matches.pending > 0);

  const clock = new Date(now).toLocaleString("en-US", { hour12: false });
  lines.push("");
  lines.push(`  ${bold(cyan("FIRST PICK"))} ${bold("· match collector")}  ${dim(clock)}`);
  lines.push(`  ${rule}`);

  const totals = { pending: 0, fetched: 0, skipped: 0, failed: 0, hour: 0, day: 0 };
  const maxPending = Math.max(1, ...regions.map(([, r]) => r.matches.pending));

  for (const [name, r] of regions) {
    const m = r.matches;
    totals.pending += m.pending;
    totals.fetched += m.fetched;
    totals.skipped += m.skipped;
    totals.failed += m.failed;
    totals.hour += r.fetchedLastHour;
    totals.day += r.fetchedLast24h;

    const state = r.likelyKeyExpired && m.pending > 0 ? red("⚠ STALLED") : green("● live");
    lines.push(
      `  ${bold(name.padEnd(5))} ${state}  ` +
        `fetched ${bold(n(m.fetched).padStart(9))}   ` +
        `${cyan(`${n(r.fetchedLastHour)}/h`)} ${dim(`(~${n(r.fetchedLastHour * 24)}/day)`)}`,
    );
    lines.push(
      `        backlog ${bar(m.pending, maxPending, 28)} ${n(m.pending).padStart(7)}   ` +
        dim(`skipped ${n(m.skipped)} · failed ${n(m.failed)} · summoners ${n(r.summoners)}`),
    );
    const patches = r.patchMix
      .slice(-4)
      .map((p) => `${p.patch}×${n(p.count)}`)
      .join("  ");
    lines.push(`        ${dim(`patches: ${patches || "(none yet)"}`)}`);
    lines.push("");
  }

  lines.push(`  ${rule}`);
  lines.push(
    `  ${bold("TOTAL")} fetched ${bold(n(totals.fetched).padStart(9))}   ` +
      `${cyan(`${n(totals.hour)}/h`)}  ${dim(`last 24h ${n(totals.day)}`)}   ` +
      `backlog ${n(totals.pending)}`,
  );
  lines.push("");
  lines.push(
    stalled
      ? `  ${red("■ KEY EXPIRED — reply to the Discord ping with a fresh RGAPI key")}`
      : `  ${green("■ KEY OK")} ${dim("— collectors running")}`,
  );
  lines.push("");
  return lines.join("\n");
}

if (process.argv[1]?.endsWith("dashboard.mjs")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("dashboard: DATABASE_URL is required");
    process.exit(1);
  }
  const regions = (process.env.COLLECTOR_REGIONS ?? "na1,euw1,kr").split(",").map((r) => r.trim());
  const db = createDb(url);
  const HIDE_CURSOR = `${ESC}?25l`;
  const CLEAR = `${ESC}2J${ESC}H`;

  const draw = async () => {
    try {
      const status = await collectStatus(db, { regions });
      process.stdout.write(CLEAR + HIDE_CURSOR + renderDashboard(status, { now: Date.now() }));
    } catch (err) {
      process.stdout.write(CLEAR + `dashboard: ${err.message}\n`);
    }
  };
  draw();
  setInterval(draw, 5000);
}
