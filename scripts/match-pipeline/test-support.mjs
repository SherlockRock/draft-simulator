/**
 * Shared test plumbing: throwaway Postgres databases on the dev machine's
 * local server, peer-auth over the unix socket. Never points at forge.
 */

import pg from "pg";
import { createDb, migrate } from "./db.mjs";

const SOCKET = "/var/run/postgresql";
const ADMIN_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? `postgresql://rsmith@/postgres?host=${SOCKET}`;

export async function makeTestDb(name) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const db = createDb(`postgresql://rsmith@/${name}?host=${SOCKET}`);
  await migrate(db);
  return db;
}

export const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
