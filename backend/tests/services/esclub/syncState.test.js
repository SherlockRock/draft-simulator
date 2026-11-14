import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sequelize = require("../../../config/database");
const { UniqueConstraintError } = require("sequelize");
const { injectReplacements } = require("sequelize/lib/utils/sql");
const {
  EsclubBudgetExhausted,
  EsclubRequestCapReached,
  EsclubSyncAbandoned,
} = require("../../../services/esclub/errors");
const S = require("../../../services/esclub/syncState");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = new Date("2026-11-14T12:00:00.000Z");
const at = (ms) => new Date(T0.getTime() + ms);
const ON = { ESCLUB_SYNC_ENABLED: "true" };
const TOUR = "tour-1";
const OTHER_TOUR = "tour-2";

// A small in-memory stand-in for the two tables. It sees the SQL as Sequelize
// renders it (replacements injected, no connection) and decides from the
// replacements, so the statements are captured and the logic is exercised
// without a database. Boundary operators are asserted on the captured SQL.
function makeDb({ usage = null, syncs = [] } = {}) {
  const db = {
    usage, // today's request_count or null
    syncs: syncs.map((s) => ({ ...s })),
    log: [], // { sql, replacements }
    insertRace: null, // function run instead of a normal insert
    nextId: 1,
  };
  const row = (o) => ({
    id: `s${db.nextId++}`,
    kind: "league",
    tournament_id: TOUR,
    stage_id: null,
    series_id: null,
    requested_by: null,
    via: "api",
    status: "succeeded",
    started_at: at(-HOUR),
    heartbeat_at: at(-HOUR),
    finished_at: at(-HOUR),
    request_count: 0,
    ...o,
  });
  db.add = (o) => {
    const r = row(o);
    db.syncs.push(r);
    return r;
  };
  db.syncs = db.syncs.map((s) => row(s));
  const running = () => db.syncs.find((s) => s.status === "running");

  db.query = async (sql, options = {}) => {
    const r = options.replacements ?? {};
    // Sequelize renders dates in the host's offset; restate them in UTC so
    // the assertions do not depend on the machine's time zone.
    const rendered = injectReplacements(sql, sequelize.dialect, r).replace(
      /'(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) ([+-]\d\d:\d\d)'/g,
      (_m, d, t, off) =>
        `'${new Date(`${d}T${t}${off}`)
          .toISOString()
          .replace("T", " ")
          .replace("Z", " +00:00")}'`,
    );
    db.log.push({ sql: rendered, replacements: r });
    const s = rendered.replace(/\s+/g, " ").trim();
    if (/^SELECT request_count FROM "EsclubDailyUsage"/.test(s)) {
      return db.usage === null ? [] : [{ request_count: db.usage }];
    }
    if (/^UPDATE "EsclubSyncs" SET status = 'failed'.*Abandoned/.test(s)) {
      const out = db.syncs.filter(
        (x) => x.status === "running" && x.heartbeat_at <= r.cutoff,
      );
      for (const x of out) {
        x.status = "failed";
        x.finished_at = x.heartbeat_at;
        x.error_class = "Abandoned";
      }
      return out.map((x) => ({ id: x.id }));
    }
    if (/^SELECT \* FROM "EsclubSyncs" WHERE status = 'running'/.test(s)) {
      return running() ? [running()] : [];
    }
    if (/^SELECT status FROM "EsclubSyncs" WHERE id =/.test(s)) {
      return db.syncs.filter((x) => x.id === r.id).map((x) => ({ status: x.status }));
    }
    if (/^SELECT \* FROM "EsclubSyncs" WHERE id =/.test(s)) {
      return db.syncs.filter((x) => x.id === r.id);
    }
    if (/^SELECT MAX\(finished_at\)/.test(s)) {
      const rows = db.syncs.filter((x) => {
        if (!x.finished_at) return false;
        if (/kind IN \('league', 'add'\)/.test(s)) {
          return (
            x.tournament_id === r.tournamentId &&
            ["league", "add"].includes(x.kind)
          );
        }
        return x.kind === "serie" && x.series_id === r.seriesId;
      });
      const latest = rows.reduce(
        (m, x) => (m === null || x.finished_at > m ? x.finished_at : m),
        null,
      );
      return [{ latest }];
    }
    if (/^SELECT started_at FROM "EsclubSyncs"/.test(s)) {
      return db.syncs
        .filter(
          (x) =>
            x.requested_by === r.userId &&
            x.kind === r.kind &&
            x.started_at > r.since,
        )
        .sort((a, b) => a.started_at - b.started_at)
        .map((x) => ({ started_at: x.started_at }));
    }
    if (/^INSERT INTO "EsclubSyncs"/.test(s)) {
      if (db.insertRace) {
        db.insertRace();
        throw new UniqueConstraintError({ message: "esclub_syncs_one_running" });
      }
      if (running()) {
        throw new UniqueConstraintError({ message: "esclub_syncs_one_running" });
      }
      const x = db.add({
        id: r.id,
        kind: r.kind,
        tournament_id: r.tournamentId,
        stage_id: r.stageId,
        series_id: r.seriesId,
        requested_by: r.userId,
        via: r.via,
        status: "running",
        started_at: r.now,
        heartbeat_at: r.now,
        finished_at: null,
        request_count: 0,
      });
      return [x];
    }
    if (/^UPDATE "EsclubSyncs" SET request_count = request_count \+ 1/.test(s)) {
      const x = db.syncs.find((y) => y.id === r.id);
      if (!x || x.status !== "running" || x.request_count >= r.cap) return [];
      x.request_count += 1;
      x.heartbeat_at = r.now;
      return [{ request_count: x.request_count }];
    }
    if (/^INSERT INTO "EsclubDailyUsage"/.test(s)) {
      const cur = db.usage;
      if (cur !== null && cur >= r.budget) return [];
      db.usage = (cur ?? 0) + 1;
      return [{ request_count: db.usage }];
    }
    if (/^UPDATE "EsclubSyncs" SET status = '[a-z]+', finished_at/.test(s)) {
      const x = db.syncs.find((y) => y.id === r.id && y.status === "running");
      if (!x) return [];
      x.status = r.status;
      x.finished_at = r.now;
      x.error_class = r.errorClass;
      x.error_message = r.errorMessage;
      x.summary = r.summary;
      return [{ id: x.id }];
    }
    throw new Error(`unexpected SQL: ${s}`);
  };
  return db;
}

let db;
const install = (init) => {
  db = makeDb(init);
  vi.spyOn(sequelize, "query").mockImplementation((sql, o) => db.query(sql, o));
  const transaction = vi.spyOn(sequelize, "transaction");
  transaction.mockImplementation(async (cb) => {
    const snapshot = {
      usage: db.usage,
      syncs: db.syncs.map((x) => ({ ...x })),
    };
    const t = { id: "tx" };
    try {
      const out = await cb(t);
      db.committed = (db.committed ?? 0) + 1;
      return out;
    } catch (err) {
      db.usage = snapshot.usage;
      db.syncs = snapshot.syncs;
      db.rolledBack = (db.rolledBack ?? 0) + 1;
      throw err;
    }
  });
  return db;
};
const inserts = () =>
  db.log.filter((l) => /INSERT INTO "EsclubSyncs"/.test(l.sql));
const sqlOf = (re) => db.log.find((l) => re.test(l.sql.replace(/\s+/g, " ")));

const begin = (over = {}) =>
  S.beginSync({
    kind: "league",
    tournamentId: TOUR,
    userId: "u1",
    now: T0,
    env: ON,
    ...over,
  });

afterEach(() => vi.restoreAllMocks());
beforeEach(() => install());

describe("constants and helpers", () => {
  it("exports the plan's numbers", () => {
    expect(S.STALE_MS).toBe(2 * MIN);
    expect(S.LEAGUE_COOLDOWN_MS).toBe(10 * MIN);
    expect(S.SERIE_COOLDOWN_MS).toBe(2 * MIN);
    expect(S.LEAGUE_REFRESHES_PER_HOUR).toBe(6);
    expect(S.SERIE_REFRESHES_PER_HOUR).toBe(20);
    expect(S.ADDS_PER_DAY).toBe(3);
    expect(S.BUSY_RETRY_SECONDS).toBe(60);
  });

  it("limitsFromEnv: kill switch only on exact 'true', defaults, positive ints", () => {
    expect(S.limitsFromEnv({})).toEqual({ enabled: false, budget: 2000, cap: 400 });
    expect(S.limitsFromEnv({ ESCLUB_SYNC_ENABLED: "TRUE" }).enabled).toBe(false);
    expect(S.limitsFromEnv({ ESCLUB_SYNC_ENABLED: "true" }).enabled).toBe(true);
    expect(
      S.limitsFromEnv({
        ESCLUB_DAILY_REQUEST_BUDGET: "50",
        ESCLUB_SYNC_MAX_REQUESTS: "7",
      }),
    ).toMatchObject({ budget: 50, cap: 7 });
    for (const bad of ["0", "-3", "abc", "", "1.5x"]) {
      const l = S.limitsFromEnv({
        ESCLUB_DAILY_REQUEST_BUDGET: bad,
        ESCLUB_SYNC_MAX_REQUESTS: bad,
      });
      if (bad === "1.5x") expect(l.budget).toBe(2000);
      else expect(l).toMatchObject({ budget: 2000, cap: 400 });
    }
  });

  it("utcDay is the UTC date", () => {
    expect(S.utcDay(new Date("2026-11-14T23:59:59.999Z"))).toBe("2026-11-14");
    expect(S.utcDay(new Date("2026-11-15T00:00:00.000Z"))).toBe("2026-11-15");
  });
});

describe("beginSync order of checks", () => {
  it("disabled beats everything and sends no query", async () => {
    db.usage = 5000;
    db.add({ status: "running", finished_at: null, heartbeat_at: T0 });
    const out = await begin({ env: {} });
    expect(out).toEqual({ off: "disabled" });
    expect(db.log).toHaveLength(0);
  });

  it("budget spent -> off budget, before the stale sweep and the lock", async () => {
    db.usage = 2000;
    db.add({ status: "running", finished_at: null, heartbeat_at: at(-10 * MIN) });
    const out = await begin();
    expect(out).toEqual({ off: "budget" });
    expect(db.log.some((l) => /Abandoned/.test(l.sql))).toBe(false);
    expect(inserts()).toHaveLength(0);
  });

  it("budget is read for today's UTC day and honours ESCLUB_DAILY_REQUEST_BUDGET", async () => {
    db.usage = 10;
    const out = await begin({ env: { ...ON, ESCLUB_DAILY_REQUEST_BUDGET: "10" } });
    expect(out).toEqual({ off: "budget" });
    expect(db.log[0].sql).toMatch(/FROM "EsclubDailyUsage" WHERE day = '2026-11-14'/);
  });

  it("1999 of 2000 still starts", async () => {
    db.usage = 1999;
    expect(await begin()).toHaveProperty("sync");
  });

  it("budget beats busy", async () => {
    db.usage = 2000;
    db.add({ status: "running", finished_at: null, heartbeat_at: T0, tournament_id: OTHER_TOUR });
    expect(await begin()).toEqual({ off: "budget" });
  });

  it("busy beats cooldown and limits, and creates no row", async () => {
    db.add({ status: "running", finished_at: null, heartbeat_at: T0, tournament_id: OTHER_TOUR });
    db.add({ kind: "league", finished_at: at(-MIN), requested_by: "u1" });
    const out = await begin();
    expect(out).toEqual({ busy: { retryAfter: 60 } });
    expect(inserts()).toHaveLength(0);
  });

  it("cooldown beats the per-user limit", async () => {
    db.add({ kind: "league", finished_at: at(-MIN), started_at: at(-2 * MIN), requested_by: "u1" });
    for (let i = 0; i < 6; i++) db.add({ kind: "league", requested_by: "u1", started_at: at(-(10 + i) * MIN), finished_at: at(-(9 + i) * MIN) });
    const out = await begin();
    expect(out).toHaveProperty("cooldown");
  });
});

describe("stale lock", () => {
  const stale = (hbMs) =>
    db.add({ status: "running", finished_at: null, heartbeat_at: at(hbMs), tournament_id: OTHER_TOUR });

  it("heartbeat 1:59 old is not stale: busy, row untouched", async () => {
    const r = stale(-(2 * MIN - 1000));
    expect(await begin()).toEqual({ busy: { retryAfter: 60 } });
    expect(r.status).toBe("running");
  });

  it("heartbeat exactly 2:00 old is stale (rule: heartbeat_at <= now - 2 min)", async () => {
    const r = stale(-2 * MIN);
    const out = await begin();
    expect(out).toHaveProperty("sync");
    expect(r.status).toBe("failed");
    expect(r.error_class).toBe("Abandoned");
  });

  it("the sweep SQL states the rule, the message and the outcome", async () => {
    stale(-3 * MIN);
    await begin();
    const l = sqlOf(/^UPDATE "EsclubSyncs" SET status = 'failed'.*Abandoned/);
    const s = l.sql.replace(/\s+/g, " ");
    expect(s).toMatch(/error_class = 'Abandoned'/);
    expect(s).toMatch(/error_message = 'no heartbeat for 2 minutes'/);
    expect(s).toMatch(/finished_at = heartbeat_at/);
    expect(s).toMatch(/WHERE status = 'running' AND heartbeat_at <= '2026-11-14 11:58:00\.000 \+00:00'/);
    expect(s).toMatch(/RETURNING id/);
  });

  it("markStale returns the count", async () => {
    stale(-5 * MIN);
    expect(await S.markStale(T0)).toBe(1);
    expect(await S.markStale(T0)).toBe(0);
  });
});

describe("joining and busy", () => {
  const running = (o) =>
    db.add({ status: "running", finished_at: null, heartbeat_at: T0, ...o });

  it("league press joins the same tournament's running league sync", async () => {
    const r = running({ kind: "league" });
    expect(await begin()).toEqual({ joined: r });
    expect(inserts()).toHaveLength(0);
  });

  it("any press joins a running add of the same tournament", async () => {
    const r = running({ kind: "add" });
    expect(await begin({ kind: "serie", seriesId: "x" })).toEqual({ joined: r });
  });

  it("an add press (no tournament yet) never joins a running add: busy", async () => {
    running({ kind: "add", tournament_id: null });
    expect(await begin({ kind: "add", tournamentId: null })).toEqual({ busy: { retryAfter: 60 } });
    expect(inserts()).toHaveLength(0);
  });

  it("serie press joins a running league sync of the same tournament", async () => {
    const r = running({ kind: "league" });
    expect(await begin({ kind: "serie", seriesId: "x" })).toEqual({ joined: r });
  });

  it("serie press joins the running sync of that series only", async () => {
    const r = running({ kind: "serie", series_id: "A" });
    expect(await begin({ kind: "serie", seriesId: "A" })).toEqual({ joined: r });
    expect(await begin({ kind: "serie", seriesId: "B" })).toEqual({ busy: { retryAfter: 60 } });
  });

  it("league press while a serie sync of the same tournament runs is busy", async () => {
    running({ kind: "serie", series_id: "A" });
    expect(await begin()).toEqual({ busy: { retryAfter: 60 } });
  });

  it("another tournament running is busy for every kind", async () => {
    running({ kind: "league", tournament_id: OTHER_TOUR });
    for (const kind of ["league", "add", "serie"]) {
      expect(await begin({ kind, seriesId: "A" })).toEqual({ busy: { retryAfter: 60 } });
    }
    expect(inserts()).toHaveLength(0);
  });

  it("joins and busy skip the cooldown and limit queries (nothing counted)", async () => {
    running({ kind: "league" });
    await begin();
    expect(db.log.some((l) => /MAX\(finished_at\)|SELECT started_at/.test(l.sql))).toBe(false);
  });
});

describe("league cooldown", () => {
  const finishedAgo = (ms, kind = "league") =>
    db.add({ kind, finished_at: at(-ms), started_at: at(-ms - MIN), requested_by: "other" });

  it("9:59 after finishing -> cooldown with the right availableAt", async () => {
    const f = finishedAgo(10 * MIN - 1000);
    const out = await begin();
    expect(out).toEqual({ cooldown: { availableAt: new Date(f.finished_at.getTime() + 10 * MIN) } });
    expect(inserts()).toHaveLength(0);
  });

  it("10:00 after finishing -> sync", async () => {
    finishedAgo(10 * MIN);
    expect(await begin()).toHaveProperty("sync");
  });

  it("an add counts for the league cooldown, and a failed row too", async () => {
    const f = finishedAgo(MIN, "add");
    f.status = "failed";
    expect(await begin()).toHaveProperty("cooldown");
  });

  it("another tournament's sync and a serie sync do not", async () => {
    db.add({ kind: "league", tournament_id: OTHER_TOUR, finished_at: at(-MIN) });
    finishedAgo(MIN, "serie");
    expect(await begin()).toHaveProperty("sync");
  });

  it("the query takes the latest finished_at of this tournament's league and add rows", async () => {
    await begin();
    const s = sqlOf(/MAX\(finished_at\)/).sql.replace(/\s+/g, " ");
    expect(s).toMatch(/FROM "EsclubSyncs" WHERE tournament_id = 'tour-1' AND kind IN \('league', 'add'\) AND finished_at IS NOT NULL/);
  });

  it("an add has no cooldown", async () => {
    finishedAgo(MIN);
    expect(await begin({ kind: "add" })).toHaveProperty("sync");
  });
});

describe("serie cooldown", () => {
  it("2 minutes from that series' last serie sync: 1:59 cooldown, 2:00 sync", async () => {
    const f = db.add({ kind: "serie", series_id: "A", finished_at: at(-(2 * MIN - 1000)), requested_by: "other" });
    const out = await begin({ kind: "serie", seriesId: "A" });
    expect(out).toEqual({ cooldown: { availableAt: new Date(f.finished_at.getTime() + 2 * MIN) } });
    f.finished_at = at(-2 * MIN);
    expect(await begin({ kind: "serie", seriesId: "A" })).toHaveProperty("sync");
  });

  it("is independent of the league cooldown, both ways", async () => {
    db.add({ kind: "league", finished_at: at(-MIN) });
    expect(await begin({ kind: "serie", seriesId: "A" })).toHaveProperty("sync");
    db.syncs.length = 0;
    db.add({ kind: "serie", series_id: "A", finished_at: at(-MIN) });
    expect(await begin()).toHaveProperty("sync");
  });

  it("another series is not cooled down; the query is pinned to the series", async () => {
    db.add({ kind: "serie", series_id: "A", finished_at: at(-MIN) });
    expect(await begin({ kind: "serie", seriesId: "B" })).toHaveProperty("sync");
    const s = sqlOf(/MAX\(finished_at\)/).sql.replace(/\s+/g, " ");
    expect(s).toMatch(/WHERE kind = 'serie' AND series_id = 'B' AND finished_at IS NOT NULL/);
  });
});

describe("per-user limits", () => {
  const starts = (n, kind, agoMs = (i) => (i + 1) * 5 * MIN, user = "u1") => {
    for (let i = 0; i < n; i++) {
      db.add({
        kind,
        requested_by: user,
        tournament_id: OTHER_TOUR + i,
        series_id: `z${i}`,
        started_at: at(-agoMs(i)),
        finished_at: at(-agoMs(i) + 1000),
      });
    }
  };

  it("6 league syncs in the last hour: the 7th is limited, retryAfter to the oldest leaving", async () => {
    // started 5, 10, ... 30 min ago; oldest is 30 min ago -> frees in 30 min
    starts(6, "league");
    const out = await begin();
    expect(out).toEqual({ limited: { retryAfter: 30 * 60 } });
    expect(inserts()).toHaveLength(0);
  });

  it("5 do not limit", async () => {
    starts(5, "league");
    expect(await begin()).toHaveProperty("sync");
  });

  it("a start older than an hour is not counted; retryAfter rounds up and is at least 1", async () => {
    starts(5, "league");
    db.add({ kind: "league", requested_by: "u1", tournament_id: "old", started_at: at(-HOUR), finished_at: at(-HOUR + 1000) });
    expect(await begin()).toHaveProperty("sync");
    db.syncs.length = 0;
    starts(6, "league", (i) => HOUR - 1500 + i * 10); // oldest leaves in 1.5 s
    expect(await begin()).toEqual({ limited: { retryAfter: 2 } });
  });

  it("another user's syncs and other kinds are not counted", async () => {
    starts(6, "league", undefined, "someone-else");
    starts(6, "serie");
    starts(6, "add");
    expect(await begin()).toHaveProperty("sync");
  });

  it("the league limit query: this user, kind league, started in the last hour, oldest first", async () => {
    starts(6, "league");
    await begin();
    const s = sqlOf(/^SELECT started_at/).sql.replace(/\s+/g, " ");
    expect(s).toMatch(/WHERE requested_by = 'u1' AND kind = 'league' AND started_at > '2026-11-14 11:00:00\.000 \+00:00' ORDER BY started_at ASC/);
  });

  it("serie limit is 20 an hour", async () => {
    starts(19, "serie", (i) => (i + 1) * 2 * MIN);
    expect(await begin({ kind: "serie", seriesId: "new" })).toHaveProperty("sync");
    db.syncs.length = 0;
    starts(20, "serie", (i) => (i + 1) * 2 * MIN); // oldest 40 min ago
    expect(await begin({ kind: "serie", seriesId: "new" })).toEqual({ limited: { retryAfter: 20 * 60 } });
    expect(sqlOf(/^SELECT started_at/).sql).toMatch(/kind = 'serie'/);
  });

  it("add limit is 3 in 24 hours", async () => {
    starts(2, "add", (i) => (i + 1) * HOUR);
    expect(await begin({ kind: "add" })).toHaveProperty("sync");
    db.syncs.length = 0;
    starts(3, "add", (i) => (i + 1) * 6 * HOUR); // oldest 18 h ago
    expect(await begin({ kind: "add" })).toEqual({ limited: { retryAfter: 6 * 3600 } });
    const s = sqlOf(/^SELECT started_at/).sql;
    expect(s).toMatch(/kind = 'add'/);
    expect(s).toMatch(/started_at > '2026-11-13 12:00:00\.000 \+00:00'/);
  });

  it("an add 24 h and 1 s ago does not count", async () => {
    starts(2, "add", (i) => (i + 1) * HOUR);
    db.add({ kind: "add", requested_by: "u1", tournament_id: "x", started_at: at(-24 * HOUR), finished_at: at(-24 * HOUR + 1) });
    expect(await begin({ kind: "add" })).toHaveProperty("sync");
  });
});

describe("the CLI", () => {
  it("skips cooldown and limits", async () => {
    db.add({ kind: "league", finished_at: at(-MIN) });
    for (let i = 0; i < 8; i++) db.add({ kind: "league", requested_by: null, started_at: at(-(i + 1) * MIN), finished_at: at(-(i + 1) * MIN) });
    const out = await begin({ via: "cli", userId: null });
    expect(out).toHaveProperty("sync");
    expect(out.sync).toMatchObject({ via: "cli", requested_by: null });
    expect(db.log.some((l) => /MAX\(finished_at\)|SELECT started_at/.test(l.sql))).toBe(false);
  });

  it("still obeys disabled, budget and busy, and joins", async () => {
    expect(await begin({ via: "cli", env: {} })).toEqual({ off: "disabled" });
    db.usage = 2000;
    expect(await begin({ via: "cli" })).toEqual({ off: "budget" });
    db.usage = 0;
    const r = db.add({ status: "running", finished_at: null, heartbeat_at: T0, tournament_id: OTHER_TOUR });
    expect(await begin({ via: "cli" })).toEqual({ busy: { retryAfter: 60 } });
    r.tournament_id = TOUR;
    expect(await begin({ via: "cli" })).toEqual({ joined: r });
  });
});

describe("creating the row", () => {
  it("inserts a running row with the given ids and zero requests", async () => {
    const out = await begin({ kind: "serie", seriesId: "A", stageId: "st", userId: "u9" });
    expect(out.sync).toMatchObject({
      kind: "serie", tournament_id: TOUR, stage_id: "st", series_id: "A",
      requested_by: "u9", via: "api", status: "running",
      started_at: T0, heartbeat_at: T0, request_count: 0,
    });
    expect(inserts()).toHaveLength(1);
    const s = inserts()[0].sql.replace(/\s+/g, " ");
    expect(s).toMatch(/'running'/);
    expect(s).toMatch(/RETURNING \*/);
  });

  it("a unique violation (another process won) re-reads the running row and joins", async () => {
    let winner;
    db.insertRace = () => {
      winner = db.add({ kind: "league", status: "running", finished_at: null, heartbeat_at: T0 });
    };
    expect(await begin()).toEqual({ joined: winner });
  });

  it("a unique violation against a different tournament is busy", async () => {
    db.insertRace = () => {
      db.add({ kind: "league", tournament_id: OTHER_TOUR, status: "running", finished_at: null, heartbeat_at: T0 });
    };
    expect(await begin()).toEqual({ busy: { retryAfter: 60 } });
  });

  it("a unique violation whose winner is already gone is busy (try again)", async () => {
    db.insertRace = () => {};
    expect(await begin()).toEqual({ busy: { retryAfter: 60 } });
  });

  it("other insert errors propagate", async () => {
    sequelize.query.mockImplementation(async (sql, o) => {
      if (/INSERT INTO "EsclubSyncs"/.test(sql)) throw new Error("boom");
      return db.query(sql, o);
    });
    await expect(begin()).rejects.toThrow("boom");
  });
});

describe("countRequest", () => {
  const running = (o) => db.add({ status: "running", finished_at: null, heartbeat_at: at(-MIN), request_count: 0, ...o });

  it("bumps the sync count and heartbeat, and today's usage, in one transaction", async () => {
    const r = running();
    db.usage = 4;
    const out = await S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 });
    expect(out).toEqual({ used: 5, syncCount: 1 });
    expect(r.heartbeat_at).toEqual(T0);
    expect(db.committed).toBe(1);
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);
  });

  it("creates today's usage row on the first request of the day", async () => {
    const r = running();
    expect(await S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 })).toEqual({ used: 1, syncCount: 1 });
  });

  it("refuses at the cap with EsclubRequestCapReached and touches nothing", async () => {
    const r = running({ request_count: 400 });
    db.usage = 7;
    await expect(S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 })).rejects.toBeInstanceOf(EsclubRequestCapReached);
    expect(db.usage).toBe(7);
    expect(r.request_count).toBe(400);
    expect(db.log.some((l) => /"EsclubDailyUsage"/.test(l.sql))).toBe(false);
  });

  it("the 400th request passes, the 401st does not", async () => {
    const r = running({ request_count: 399 });
    await S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 });
    await expect(S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 })).rejects.toBeInstanceOf(EsclubRequestCapReached);
  });

  it("refuses at the budget with EsclubBudgetExhausted and rolls the cap increment back", async () => {
    const r = running({ request_count: 3 });
    db.usage = 2000;
    await expect(S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 })).rejects.toBeInstanceOf(EsclubBudgetExhausted);
    expect(db.syncs.find((x) => x.id === r.id).request_count).toBe(3);
    expect(db.usage).toBe(2000);
    expect(db.rolledBack).toBe(1);
    expect(db.committed).toBeUndefined();
  });

  it("passes the transaction to both statements", async () => {
    const r = running();
    await S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 });
    const calls = sequelize.query.mock.calls;
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c[1].transaction).toEqual({ id: "tx" });
  });

  it("the cap update SQL", async () => {
    const r = running();
    await S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 });
    const s = db.log[0].sql.replace(/\s+/g, " ");
    expect(s).toMatch(/^UPDATE "EsclubSyncs" SET request_count = request_count \+ 1, heartbeat_at = '2026-11-14 12:00:00\.000 \+00:00', "updatedAt" = '2026-11-14 12:00:00\.000 \+00:00' WHERE id = 's1' AND status = 'running' AND request_count < 400 RETURNING request_count/);
  });

  it("the budget upsert SQL", async () => {
    const r = running();
    await S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 });
    const s = db.log[1].sql.replace(/\s+/g, " ");
    expect(s).toMatch(/^INSERT INTO "EsclubDailyUsage" \(day, request_count, "createdAt", "updatedAt"\) VALUES \('2026-11-14', 1, '2026-11-14 12:00:00\.000 \+00:00', '2026-11-14 12:00:00\.000 \+00:00'\)/);
    expect(s).toMatch(/ON CONFLICT \(day\) DO UPDATE SET request_count = "EsclubDailyUsage"\.request_count \+ 1, "updatedAt" = '2026-11-14 12:00:00\.000 \+00:00' WHERE "EsclubDailyUsage"\.request_count < 2000 RETURNING request_count/);
  });
});

describe("Task 5 review fixes", () => {
  it("countRequest refuses a sync that is no longer running (taken over as stale) and spends no budget", async () => {
    const r = db.add({ status: "failed", finished_at: T0, heartbeat_at: at(-3 * MIN), request_count: 5 });
    db.usage = 7;
    await expect(S.countRequest(r.id, { budget: 2000, cap: 400, now: T0 })).rejects.toBeInstanceOf(EsclubSyncAbandoned);
    expect(db.usage).toBe(7);
    expect(r.request_count).toBe(5);
    const s = db.log[0].sql.replace(/\s+/g, " ");
    expect(s).toMatch(/WHERE id = 's1' AND status = 'running' AND request_count < 400/);
  });
  it("a stale sweep dates the abandoned row at its last heartbeat, not at the sweep", async () => {
    const r = db.add({ status: "running", finished_at: null, heartbeat_at: at(-3 * MIN), tournament_id: OTHER_TOUR });
    await S.markStale(T0);
    expect(r.finished_at).toEqual(at(-3 * MIN));
    const s = sqlOf(/^UPDATE "EsclubSyncs" SET status = 'failed'.*Abandoned/).sql.replace(/\s+/g, " ");
    expect(s).toMatch(/finished_at = heartbeat_at/);
  });
  it("an api press without a user is refused (per-user limits need one)", async () => {
    await expect(S.beginSync({ kind: "league", tournamentId: OTHER_TOUR, userId: null, via: "api", now: T0, env: { ESCLUB_SYNC_ENABLED: "true" } })).rejects.toThrow(/userId/);
  });
});

describe("finishSync", () => {
  const running = () => db.add({ status: "running", finished_at: null, heartbeat_at: T0 });

  it("marks a running row succeeded with the summary", async () => {
    const r = running();
    const ok = await S.finishSync(r.id, { status: "succeeded", summary: { series: 3 }, now: at(MIN) });
    expect(ok).toBe(true);
    expect(r).toMatchObject({ status: "succeeded", finished_at: at(MIN), error_class: null, error_message: null });
    expect(r.summary).toBe(JSON.stringify({ series: 3 }));
  });

  it("records the error class and a message cut to 500 chars", async () => {
    const r = running();
    class EsclubUnavailable extends Error {
      constructor(m) { super(m); this.name = "EsclubUnavailable"; }
    }
    await S.finishSync(r.id, { status: "failed", error: new EsclubUnavailable("x".repeat(900)), now: at(MIN) });
    expect(r.status).toBe("failed");
    expect(r.error_class).toBe("EsclubUnavailable");
    expect(r.error_message).toHaveLength(500);
    expect(r.summary).toBeNull();
  });

  it("returns false and changes nothing for a row that is not running", async () => {
    const r = running();
    r.status = "failed";
    r.error_class = "Abandoned";
    const ok = await S.finishSync(r.id, { status: "succeeded", now: at(MIN) });
    expect(ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.error_class).toBe("Abandoned");
  });

  it("the update is guarded by status = 'running'", async () => {
    const r = running();
    await S.finishSync(r.id, { status: "succeeded", now: at(MIN) });
    const s = db.log[0].sql.replace(/\s+/g, " ");
    expect(s).toMatch(/^UPDATE "EsclubSyncs" SET status = 'succeeded', finished_at = '2026-11-14 12:01:00\.000 \+00:00'/);
    expect(s).toMatch(/WHERE id = 's1' AND status = 'running' RETURNING id/);
  });
});

describe("getSync, usageToday, nextAvailableAt", () => {
  it("getSync returns the row or null", async () => {
    const r = db.add({});
    expect(await S.getSync(r.id)).toEqual(r);
    expect(await S.getSync("nope")).toBeNull();
  });

  it("usageToday reports the day, the count and the budget", async () => {
    db.usage = 12;
    expect(await S.usageToday({ now: T0, env: { ESCLUB_DAILY_REQUEST_BUDGET: "30" } })).toEqual({ day: "2026-11-14", used: 12, budget: 30 });
    db.usage = null;
    expect(await S.usageToday({ now: T0, env: {} })).toEqual({ day: "2026-11-14", used: 0, budget: 2000 });
  });

  it("nextAvailableAt: league and serie cooldown ends, null when over or for adds", async () => {
    const f = db.add({ kind: "league", finished_at: at(-3 * MIN) });
    expect(await S.nextAvailableAt({ kind: "league", tournamentId: TOUR, now: T0 })).toEqual(new Date(f.finished_at.getTime() + 10 * MIN));
    expect(await S.nextAvailableAt({ kind: "league", tournamentId: OTHER_TOUR, now: T0 })).toBeNull();
    expect(await S.nextAvailableAt({ kind: "serie", tournamentId: TOUR, seriesId: "A", now: T0 })).toBeNull();
    db.add({ kind: "serie", series_id: "A", finished_at: at(-30 * 1000) });
    expect(await S.nextAvailableAt({ kind: "serie", tournamentId: TOUR, seriesId: "A", now: T0 })).toEqual(at(90 * 1000));
    expect(await S.nextAvailableAt({ kind: "add", tournamentId: TOUR, now: T0 })).toBeNull();
    f.finished_at = at(-10 * MIN);
    expect(await S.nextAvailableAt({ kind: "league", tournamentId: TOUR, now: T0 })).toBeNull();
  });
});
