#!/usr/bin/env node
/**
 * Apply init.sql to $DATABASE_URL. Idempotent — the collector also runs this
 * at startup, so a bare `node migrate.mjs` is only needed for manual setup.
 */

import { createDb, migrate } from "./db.mjs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is required");
  process.exit(1);
}

const db = createDb(url);
try {
  await migrate(db);
  console.log("migrate: schema up to date");
} finally {
  await db.close();
}
