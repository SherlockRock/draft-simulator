/**
 * Sync state for the esclub league mirror (S2 D3, D4, D15): the cross-process
 * lock (the one `running` row), stale-lock takeover, cooldowns, per-user
 * limits, the per-sync request cap and the daily request budget.
 *
 * Everything lives in the database (EsclubSyncs, EsclubDailyUsage) so limits
 * hold across restarts and instances. Time comes from an injected `now`, the
 * environment from an injected `env`. A refused press creates no row.
 */

const crypto = require("node:crypto");
const { QueryTypes, UniqueConstraintError } = require("sequelize");
const sequelize = require("../../config/database");
const {
  EsclubBudgetExhausted,
  EsclubRequestCapReached,
  EsclubSyncAbandoned,
} = require("./errors");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const STALE_MS = 2 * MINUTE;
const LEAGUE_COOLDOWN_MS = 10 * MINUTE;
const SERIE_COOLDOWN_MS = 2 * MINUTE;
const LEAGUE_REFRESHES_PER_HOUR = 6;
const SERIE_REFRESHES_PER_HOUR = 20;
const ADDS_PER_DAY = 3;
const BUSY_RETRY_SECONDS = 60;

const DEFAULT_BUDGET = 2000;
const DEFAULT_CAP = 400;
const ERROR_MESSAGE_MAX = 500;

const select = (sql, replacements, transaction) =>
  sequelize.query(sql, {
    type: QueryTypes.SELECT,
    replacements,
    ...(transaction ? { transaction } : {}),
  });

/** A positive integer from an env string, else the fallback. */
function positiveInt(raw, fallback) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

/**
 * Kill switch, daily budget and per-sync cap from the environment.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ enabled: boolean, budget: number, cap: number }}
 */
function limitsFromEnv(env = process.env) {
  return {
    enabled: env.ESCLUB_SYNC_ENABLED === "true",
    budget: positiveInt(env.ESCLUB_DAILY_REQUEST_BUDGET, DEFAULT_BUDGET),
    cap: positiveInt(env.ESCLUB_SYNC_MAX_REQUESTS, DEFAULT_CAP),
  };
}

/**
 * The UTC date of a moment, "YYYY-MM-DD".
 * @param {Date} now
 * @returns {string}
 */
function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

/**
 * Fail running rows whose heartbeat is stale. The boundary is inclusive: a
 * heartbeat exactly STALE_MS old is stale, one a second younger is not.
 * @param {Date} now
 * @returns {Promise<number>} how many rows were marked failed
 */
async function markStale(now) {
  return sweepStale(now);
}

async function sweepStale(now, transaction) {
  const rows = await select(
    `UPDATE "EsclubSyncs"
        SET status = 'failed', finished_at = heartbeat_at, error_class = 'Abandoned',
            error_message = 'no heartbeat for 2 minutes', "updatedAt" = :now
      WHERE status = 'running' AND heartbeat_at <= :cutoff
      RETURNING id`,
    { now, cutoff: new Date(now.getTime() - STALE_MS) },
    transaction,
  );
  return rows.length;
}

async function readRunning(transaction) {
  const rows = await select(
    `SELECT * FROM "EsclubSyncs" WHERE status = 'running' LIMIT 1`,
    {},
    transaction,
  );
  return rows[0] ?? null;
}

/** What a press does when a sync is running: join it or be told it is busy. */
function answerForRunning(running, { kind, tournamentId, seriesId }) {
  // A press with no tournament yet (an add) is never "the same": it must not
  // join a running add, whose row has no tournament either.
  const same =
    tournamentId != null &&
    running.tournament_id === tournamentId &&
    (running.kind === "league" ||
      running.kind === "add" ||
      (kind === "serie" &&
        running.kind === "serie" &&
        running.series_id === seriesId));
  return same
    ? { joined: running }
    : { busy: { retryAfter: BUSY_RETRY_SECONDS } };
}

/** The end of the cooldown for this press, or null when none applies. */
async function cooldownEnd({ kind, tournamentId, seriesId }, transaction) {
  let rows;
  let ms;
  if (kind === "league") {
    ms = LEAGUE_COOLDOWN_MS;
    rows = await select(
      `SELECT MAX(finished_at) AS latest FROM "EsclubSyncs"
        WHERE tournament_id = :tournamentId AND kind IN ('league', 'add')
          AND finished_at IS NOT NULL`,
      { tournamentId },
      transaction,
    );
  } else if (kind === "serie") {
    ms = SERIE_COOLDOWN_MS;
    rows = await select(
      `SELECT MAX(finished_at) AS latest FROM "EsclubSyncs"
        WHERE kind = 'serie' AND series_id = :seriesId
          AND finished_at IS NOT NULL`,
      { seriesId },
      transaction,
    );
  } else {
    return null;
  }
  const latest = rows[0]?.latest;
  if (!latest) return null;
  return new Date(new Date(latest).getTime() + ms);
}

/**
 * The per-user limit for a press: { limit, windowMs } or null (no limit).
 */
function limitFor(kind) {
  if (kind === "league") {
    return { limit: LEAGUE_REFRESHES_PER_HOUR, windowMs: HOUR };
  }
  if (kind === "serie") {
    return { limit: SERIE_REFRESHES_PER_HOUR, windowMs: HOUR };
  }
  if (kind === "add") return { limit: ADDS_PER_DAY, windowMs: 24 * HOUR };
  return null;
}

/** Seconds until the user is under the limit again, or null if they are. */
async function limitRetryAfter({ kind, userId, now }, transaction) {
  const rule = limitFor(kind);
  if (!rule) return null;
  const rows = await select(
    `SELECT started_at FROM "EsclubSyncs"
      WHERE requested_by = :userId AND kind = :kind AND started_at > :since
      ORDER BY started_at ASC`,
    { userId, kind, since: new Date(now.getTime() - rule.windowMs) },
    transaction,
  );
  if (rows.length < rule.limit) return null;
  // The start that must leave the window for the count to drop below the
  // limit (the oldest one when exactly at the limit).
  const blocking = new Date(rows[rows.length - rule.limit].started_at);
  const ms = blocking.getTime() + rule.windowMs - now.getTime();
  return Math.max(1, Math.ceil(ms / SECOND));
}

/**
 * Decide what a press does and, when it starts a sync, take the lock. Checks
 * run in this order and a refusal creates no row: kill switch, daily budget,
 * stale sweep, running sync (join or busy), cooldown, per-user limit, insert.
 * The CLI (via "cli") skips the cooldown and the limits. All database checks
 * and the insert hold the same transaction-scoped advisory lock.
 *
 * @param {object} args
 * @param {"add" | "league" | "serie"} args.kind
 * @param {string} args.tournamentId
 * @param {string | null} [args.stageId]
 * @param {string | null} [args.seriesId]
 * @param {string | null} [args.userId]
 * @param {"api" | "cli"} [args.via]
 * @param {Date} args.now
 * @param {Record<string, string | undefined>} [args.env]
 * @returns {Promise<
 *   | { sync: object }
 *   | { joined: object }
 *   | { busy: { retryAfter: number } }
 *   | { cooldown: { availableAt: Date } }
 *   | { limited: { retryAfter: number } }
 *   | { off: "disabled" | "budget" }
 * >}
 */
async function beginSync({
  kind,
  tournamentId,
  stageId = null,
  seriesId = null,
  userId = null,
  via = "api",
  now,
  env = process.env,
}) {
  // Per-user limits key on requested_by; an api press without a user would
  // match none of them.
  if (via === "api" && !userId) {
    throw new Error("beginSync: an api press needs a userId");
  }
  const { enabled, budget } = limitsFromEnv(env);
  if (!enabled) return { off: "disabled" };

  const press = { kind, tournamentId, seriesId };
  try {
    return await sequelize.transaction(async (transaction) => {
      await select("SELECT pg_advisory_xact_lock(1464025932, 2)", {}, transaction);
      const { used } = await readUsage(now, transaction);
      if (used >= budget) return { off: "budget" };
      await sweepStale(now, transaction);
      const running = await readRunning(transaction);
      if (running) return answerForRunning(running, press);
      if (via === "api") {
        const end = await cooldownEnd(press, transaction);
        if (end && end.getTime() > now.getTime()) {
          return { cooldown: { availableAt: end } };
        }
        const retryAfter = await limitRetryAfter({ kind, userId, now }, transaction);
        if (retryAfter !== null) return { limited: { retryAfter } };
      }
      const rows = await select(
        `INSERT INTO "EsclubSyncs"
           (id, kind, tournament_id, stage_id, series_id, requested_by, via,
            status, started_at, heartbeat_at, request_count,
            "createdAt", "updatedAt")
         VALUES
           (:id, :kind, :tournamentId, :stageId, :seriesId, :userId, :via,
            'running', :now, :now, 0, :now, :now)
         RETURNING *`,
        {
          id: crypto.randomUUID(),
          kind,
          tournamentId,
          stageId,
          seriesId,
          userId,
          via,
          now,
        },
        transaction,
      );
      return { sync: rows[0] };
    });
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    // The partial unique index remains a backstop for other writers. Read
    // only after the failed transaction has rolled back.
    const winner = await readRunning();
    if (!winner) return { busy: { retryAfter: BUSY_RETRY_SECONDS } };
    return answerForRunning(winner, press);
  }
}

/**
 * Count one request, before it is sent: the sync's cap and today's budget in
 * one transaction. Passed to the client as its awaited onRequest.
 *
 * @param {string} syncId
 * @param {{ budget: number, cap: number, now: Date }} limits
 * @returns {Promise<{ used: number, syncCount: number }>}
 * @throws {EsclubRequestCapReached} the sync is at its cap
 * @throws {EsclubBudgetExhausted} the day's budget is spent (the cap
 *   increment is rolled back with it)
 */
async function countRequest(syncId, { budget, cap, now }) {
  return sequelize.transaction(async (transaction) => {
    const capped = await select(
      `UPDATE "EsclubSyncs"
          SET request_count = request_count + 1, heartbeat_at = :now,
              "updatedAt" = :now
        WHERE id = :id AND status = 'running' AND request_count < :cap
        RETURNING request_count`,
      { id: syncId, now, cap },
      transaction,
    );
    if (capped.length === 0) {
      const rows = await select(
        `SELECT status FROM "EsclubSyncs" WHERE id = :id`,
        { id: syncId },
        transaction,
      );
      if (rows[0]?.status !== "running") {
        // Taken over as stale (or gone): another sync may be running now.
        throw new EsclubSyncAbandoned(`sync ${syncId} is no longer running`);
      }
      throw new EsclubRequestCapReached(`sync reached its cap of ${cap}`);
    }
    const day = await select(
      `INSERT INTO "EsclubDailyUsage" (day, request_count, "createdAt", "updatedAt")
       VALUES (:day, 1, :now, :now)
       ON CONFLICT (day) DO UPDATE
         SET request_count = "EsclubDailyUsage".request_count + 1,
             "updatedAt" = :now
         WHERE "EsclubDailyUsage".request_count < :budget
       RETURNING request_count`,
      { day: utcDay(now), now, budget },
      transaction,
    );
    if (day.length === 0) {
      throw new EsclubBudgetExhausted(`daily budget of ${budget} spent`);
    }
    return { used: day[0].request_count, syncCount: capped[0].request_count };
  });
}

/**
 * Close a sync. Only a row still 'running' is updated, so an abandoned row
 * is never resurrected.
 *
 * @param {string} syncId
 * @param {object} result
 * @param {"succeeded" | "failed"} result.status
 * @param {Error | null} [result.error]
 * @param {object | null} [result.summary] counts only
 * @param {Date} result.now
 * @returns {Promise<boolean>} whether a row was updated
 */
async function finishSync(
  syncId,
  { status, error = null, summary = null, now },
) {
  const rows = await select(
    `UPDATE "EsclubSyncs"
        SET status = :status, finished_at = :now, error_class = :errorClass,
            error_message = :errorMessage, summary = CAST(:summary AS jsonb),
            "updatedAt" = :now
      WHERE id = :id AND status = 'running'
      RETURNING id`,
    {
      id: syncId,
      status,
      now,
      errorClass: error?.name ?? null,
      errorMessage: error
        ? String(error.message ?? "").slice(0, ERROR_MESSAGE_MAX)
        : null,
      summary: summary === null ? null : JSON.stringify(summary),
    },
  );
  return rows.length > 0;
}

/**
 * @param {string} id
 * @returns {Promise<object | null>}
 */
async function getSync(id) {
  const rows = await select(
    `SELECT * FROM "EsclubSyncs" WHERE id = :id`,
    { id },
  );
  return rows[0] ?? null;
}

async function readUsage(now, transaction) {
  const day = utcDay(now);
  const rows = await select(
    `SELECT request_count FROM "EsclubDailyUsage" WHERE day = :day`,
    { day },
    transaction,
  );
  return { day, used: rows[0]?.request_count ?? 0 };
}

/**
 * Today's (UTC) request count against the budget.
 * @param {{ now: Date, env?: Record<string, string | undefined> }} args
 * @returns {Promise<{ day: string, used: number, budget: number }>}
 */
async function usageToday({ now, env = process.env }) {
  const { day, used } = await readUsage(now);
  return { day, used, budget: limitsFromEnv(env).budget };
}

/**
 * When a press of this kind will next be allowed, for the read API ("available
 * in 7 min"); null when no cooldown is running.
 * @param {{ kind: string, tournamentId: string, seriesId?: string | null, now: Date }} args
 * @returns {Promise<Date | null>}
 */
async function nextAvailableAt({ kind, tournamentId, seriesId = null, now }) {
  const end = await cooldownEnd({ kind, tournamentId, seriesId });
  return end && end.getTime() > now.getTime() ? end : null;
}

module.exports = {
  STALE_MS,
  LEAGUE_COOLDOWN_MS,
  SERIE_COOLDOWN_MS,
  LEAGUE_REFRESHES_PER_HOUR,
  SERIE_REFRESHES_PER_HOUR,
  ADDS_PER_DAY,
  BUSY_RETRY_SECONDS,
  limitsFromEnv,
  utcDay,
  markStale,
  beginSync,
  countRequest,
  finishSync,
  getSync,
  usageToday,
  nextAvailableAt,
};
