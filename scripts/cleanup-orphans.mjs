#!/usr/bin/env node
// scripts/cleanup-orphans.mjs
//
// Deletes database rows that no deletion path ever reclaimed:
//
//   1. Manual series  — VersusDrafts with origin 'manual' that no CanvasGroup
//      references. The group -> series FK is SET NULL, so deleting a group or
//      canvas always left the series behind.
//   2. Orphaned drafts — Drafts with no CanvasDraft card and no live series
//      that owns them. Removing a card destroyed the join row only.
//
// This is deliberately NOT a Sequelize migration. backend/Dockerfile runs
// `db:migrate` on every container boot, so a migration would delete production
// rows unattended on the next deploy. This runs by hand, dry by default.
//
// Usage:
//   pnpm cleanup:orphans                      # dry run, deletes nothing
//   pnpm cleanup:orphans --apply              # delete, in one transaction
//   pnpm cleanup:orphans --url=postgres://…   # or set DATABASE_URL
//   pnpm cleanup:orphans --apply --force      # proceed despite warnings
//   pnpm cleanup:orphans --out=/some/dir      # where the JSON export lands
//
// Get the production URL with:
//   railway variables --service Postgres --json | jq -r .DATABASE_PUBLIC_URL

import { writeFileSync, mkdirSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// pg is a backend dependency and pnpm does not hoist it to the root, so resolve
// it from backend/. Only the driver — importing backend/config/database.js
// would pick up whatever .env is lying around and drop the port, which cannot
// reach Railway's public proxy.
const require = createRequire(join(ROOT, "backend", "package.json"));
const { Client } = require("pg");

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { apply: false, force: false, url: null, out: null };

  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--force") opts.force = true;
    else if (arg.startsWith("--url=")) opts.url = arg.slice(6);
    else if (arg.startsWith("--out=")) opts.out = arg.slice(6);
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

const HELP = `
cleanup-orphans — remove orphaned manual series and unreferenced drafts

  --apply        Actually delete. Without it, nothing is written.
  --force        Proceed with --apply despite safety warnings.
  --url=URL      Postgres connection string (or set DATABASE_URL).
  --out=DIR      Directory for the JSON export (default: repo tmp/).
  -h, --help     This message.

The JSON export is written before any delete, on every run.
`.trim();

// ------------------------------------------------------------------ queries

// A manual series nothing points at. CanvasGroups is the only table that
// references VersusDrafts for canvas-authored series.
const ORPHANED_SERIES = `
  SELECT vd.*
  FROM "VersusDrafts" vd
  WHERE vd.origin = 'manual'
    AND NOT EXISTS (
      SELECT 1 FROM "CanvasGroups" cg WHERE cg.versus_draft_id = vd.id
    )
  ORDER BY vd."createdAt"
`;

// The games belonging to those series. They are removed by the
// Drafts.versus_draft_id CASCADE rather than by an explicit delete, so they are
// exported here to keep the backup complete.
const SERIES_GAMES = `
  SELECT d.*
  FROM "Drafts" d
  WHERE d.versus_draft_id = ANY($1::uuid[])
  ORDER BY d.versus_draft_id, d."seriesIndex"
`;

// Games of a doomed series that a canvas still shows. Deleting the series would
// make those cards disappear, which is a visible change rather than a cleanup.
const SERIES_GAMES_STILL_CARDED = `
  SELECT d.id, d.name, d.versus_draft_id, count(cd.*)::int AS card_count
  FROM "Drafts" d
  JOIN "CanvasDrafts" cd ON cd.draft_id = d.id
  WHERE d.versus_draft_id = ANY($1::uuid[])
  GROUP BY d.id, d.name, d.versus_draft_id
`;

// Drafts no canvas card shows and no existing series owns. A draft whose series
// still exists is that series' problem, not an orphan.
const ORPHANED_DRAFTS = `
  SELECT d.*
  FROM "Drafts" d
  WHERE NOT EXISTS (
      SELECT 1 FROM "CanvasDrafts" cd WHERE cd.draft_id = d.id
    )
    AND (
      d.versus_draft_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "VersusDrafts" vd WHERE vd.id = d.versus_draft_id
      )
    )
  ORDER BY d."createdAt"
`;

// An orphan that is public or shared is still reachable by a real person, so it
// is not safe to treat as debris.
const REACHABLE_ORPHANS = `
  SELECT d.id, d.name, d.public,
         (SELECT count(*)::int FROM "DraftShares" ds WHERE ds.draft_id = d.id)
           AS share_count
  FROM "Drafts" d
  WHERE d.id = ANY($1::uuid[])
    AND (
      d.public = true
      OR EXISTS (SELECT 1 FROM "DraftShares" ds WHERE ds.draft_id = d.id)
    )
`;

// ------------------------------------------------------------------ helpers

function countPicks(picks) {
  if (!Array.isArray(picks)) return 0;
  return picks.filter((pick) => pick !== "" && pick !== null).length;
}

function describeDraft(draft) {
  const picks = countPicks(draft.picks);
  const created = new Date(draft.createdAt).toISOString().slice(0, 10);
  return `${draft.id}  ${created}  ${picks
    .toString()
    .padStart(2)} picks  ${draft.name}`;
}

function describeSeries(series) {
  const created = new Date(series.createdAt).toISOString().slice(0, 10);
  return `${series.id}  ${created}  Bo${series.length}  ${series.name}`;
}

function printSection(title, lines) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  if (lines.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const line of lines) console.log(`  ${line}`);
}

function writeExport(payload, outDir) {
  const dir = outDir ? resolve(outDir) : join(ROOT, "tmp");
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `orphan-cleanup-${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

// -------------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP);
    return;
  }

  const url = opts.url || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "No database URL. Pass --url=… or set DATABASE_URL.\n" +
        "  railway variables --service Postgres --json | jq -r .DATABASE_PUBLIC_URL",
    );
  }

  // Railway's proxy requires TLS but presents a self-signed chain.
  const client = new Client({
    connectionString: url,
    ssl: /\brlwy\.net\b|\brailway\.app\b/.test(url)
      ? { rejectUnauthorized: false }
      : false,
  });
  await client.connect();

  try {
    const { host, port, database } = client.connectionParameters;
    console.log(`Connected to ${database} at ${host}:${port}`);
    console.log(opts.apply ? "Mode: APPLY (will delete)" : "Mode: dry run");

    const series = (await client.query(ORPHANED_SERIES)).rows;
    const seriesIds = series.map((row) => row.id);

    const games = seriesIds.length
      ? (await client.query(SERIES_GAMES, [seriesIds])).rows
      : [];
    const cardedGames = seriesIds.length
      ? (await client.query(SERIES_GAMES_STILL_CARDED, [seriesIds])).rows
      : [];

    const drafts = (await client.query(ORPHANED_DRAFTS)).rows;
    const draftIds = drafts.map((row) => row.id);
    const reachable = draftIds.length
      ? (await client.query(REACHABLE_ORPHANS, [draftIds])).rows
      : [];

    printSection(
      `Orphaned manual series (${series.length})`,
      series.map(describeSeries),
    );
    printSection(
      `Their games, removed by cascade (${games.length})`,
      games.map(describeDraft),
    );
    printSection(
      `Orphaned drafts (${drafts.length})`,
      drafts.map(describeDraft),
    );

    const warnings = [];
    if (cardedGames.length > 0) {
      warnings.push(
        `${cardedGames.length} game(s) of a doomed series are still shown on a canvas. ` +
          "Deleting the series removes those cards:\n" +
          cardedGames
            .map((g) => `      ${g.id}  ${g.card_count} card(s)  ${g.name}`)
            .join("\n"),
      );
    }
    if (reachable.length > 0) {
      warnings.push(
        `${reachable.length} orphaned draft(s) are still reachable by a person ` +
          "(public or shared):\n" +
          reachable
            .map(
              (d) =>
                `      ${d.id}  public=${d.public}  shares=${d.share_count}  ${d.name}`,
            )
            .join("\n"),
      );
    }

    if (warnings.length > 0) {
      console.log("\nWARNINGS");
      console.log("--------");
      for (const warning of warnings) console.log(`  ! ${warning}`);
    }

    const totalDeletes = series.length + drafts.length;
    console.log(
      `\nTotals: ${series.length} series (+${games.length} games by cascade), ` +
        `${drafts.length} drafts. ${totalDeletes} explicit deletes.`,
    );

    // Always export, including on --apply. This is what makes a mistaken run
    // recoverable, so it happens before anything is deleted.
    const exportPath = writeExport(
      {
        exportedAt: new Date().toISOString(),
        database: `${host}:${port}/${database}`,
        applied: opts.apply,
        orphanedSeries: series,
        seriesGames: games,
        orphanedDrafts: drafts,
        warnings: { cardedGames, reachableDrafts: reachable },
      },
      opts.out,
    );
    console.log(`\nExport written to ${exportPath}`);

    if (!opts.apply) {
      console.log("\nDry run — nothing deleted. Re-run with --apply.");
      return;
    }

    if (warnings.length > 0 && !opts.force) {
      console.log(
        "\nRefusing to apply while warnings stand. Review the export, then " +
          "re-run with --force if this is what you want.",
      );
      process.exitCode = 1;
      return;
    }

    if (totalDeletes === 0) {
      console.log("\nNothing to delete.");
      return;
    }

    await client.query("BEGIN");
    try {
      const deletedSeries = seriesIds.length
        ? (
            await client.query(
              'DELETE FROM "VersusDrafts" WHERE id = ANY($1::uuid[])',
              [seriesIds],
            )
          ).rowCount
        : 0;
      const deletedDrafts = draftIds.length
        ? (
            await client.query(
              'DELETE FROM "Drafts" WHERE id = ANY($1::uuid[])',
              [draftIds],
            )
          ).rowCount
        : 0;

      // The counts must match what the dry run promised. Anything else means
      // the data moved under us and the transaction should not stand.
      if (deletedSeries !== series.length || deletedDrafts !== drafts.length) {
        throw new Error(
          `Deleted ${deletedSeries}/${series.length} series and ` +
            `${deletedDrafts}/${drafts.length} drafts — expected an exact match.`,
        );
      }

      await client.query("COMMIT");
      console.log(
        `\nDeleted ${deletedSeries} series and ${deletedDrafts} drafts. Committed.`,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("\nRolled back — nothing was deleted.");
      throw error;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
