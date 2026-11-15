import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sequelize = require("../../../config/database");
const setupAssociations = require("../../../models/associations");
const store = require("../../../services/esclub/mirrorStore");
const { EsclubSyncAbandoned } = require("../../../services/esclub/errors");

// setupAssociations throws when run twice.
let associated = false;
const ensureAssociations = () => {
  if (associated) return;
  setupAssociations();
  associated = true;
};

const T0 = new Date("2026-11-14T12:00:00.000Z");
const TX = { id: "fake-transaction" };
const TOUR = { id: "00000000-0000-4000-8000-000000000001", region: "na1", source: "esclub" };
const STAGE = { id: "00000000-0000-4000-8000-000000000002", external_id: "stage-ext" };
const TEAM_A = "00000000-0000-4000-8000-00000000000a";
const TEAM_B = "00000000-0000-4000-8000-00000000000b";

afterEach(() => vi.restoreAllMocks());

// Statements with bind parameters arrive as { query, bind }; inline the values.
function renderSql(sql) {
  if (typeof sql === "string") return sql;
  const lit = (v) =>
    v === null || v === undefined ? "NULL"
      : v instanceof Date ? `'${v.toISOString()}'`
      : typeof v === "string" ? `'${v}'`
      : typeof v === "object" ? `'${JSON.stringify(v)}'`
      : String(v);
  return sql.query.replace(/\$(\d+)/g, (_m, n) => lit(sql.bind[Number(n) - 1]));
}

/**
 * Renders Sequelize's real SQL with `query` stubbed. `answer(sql)` returns
 * the rows for a SELECT (default none). Inserts and updates answer the way
 * the postgres dialect does for the bits Sequelize reads back.
 */
function captureSql(answer = () => []) {
  ensureAssociations();
  const calls = [];
  const spy = vi.spyOn(sequelize, "query").mockImplementation(async (rawSql, options = {}) => {
    const sql = renderSql(rawSql);
    calls.push({ sql, options });
    if (/^\s*SELECT/i.test(sql)) {
      const rows = answer(sql);
      // With `query` stubbed the dialect never builds instances; do it here for non-raw reads.
      const built = options.model && !options.raw ? rows.map((r) => options.model.build(r, { isNewRecord: false, raw: true })) : rows;
      return options.plain ? (built[0] ?? null) : built;
    }
    if (options.instance) return [options.instance, 1];
    return [[], 1];
  });
  return { calls, spy, sqls: () => calls.map((c) => c.sql) };
}

describe("loadTournamentWithStages", () => {
  it("is two flat queries, the stages in creation order, no subquery", async () => {
    const cap = captureSql((sql) =>
      sql.includes('FROM "Tournaments"')
        ? [{ id: TOUR.id, name: "League", source: "esclub", external_id: "season", region: "na1" }]
        : [{ id: "s1", external_id: "e1", name: "Stage 1" }, { id: "s2", external_id: "e2", name: "Stage 2" }],
    );
    const t = await store.loadTournamentWithStages(TOUR.id, TX);
    expect(cap.calls).toHaveLength(2);
    const [tq, sq] = cap.sqls();
    expect(tq).toMatch(/FROM "Tournaments" AS "Tournament"/);
    expect(tq).toContain(`"Tournament"."id" = '${TOUR.id}'`);
    expect(sq).toMatch(/FROM "LeagueStages" AS "LeagueStage"/);
    expect(sq).toContain(`"tournament_id" = '${TOUR.id}'`);
    expect(sq).toMatch(/ORDER BY "LeagueStage"\."createdAt" ASC/);
    for (const sql of cap.sqls()) {
      expect(sql).not.toMatch(/FROM \(SELECT/);
      expect(sql).not.toMatch(/JOIN/);
    }
    expect(cap.calls.every((c) => c.options.transaction?.id === TX.id)).toBe(true);
    expect(t.stages.map((s) => s.external_id)).toEqual(["e1", "e2"]);
    expect(t.region).toBe("na1");
  });

  it("is null for a missing tournament and asks no second question", async () => {
    const cap = captureSql(() => []);
    expect(await store.loadTournamentWithStages(TOUR.id)).toBeNull();
    expect(cap.calls).toHaveLength(1);
  });
});

describe("loadSeriesByExternalIds", () => {
  it("asks nothing for no ids", async () => {
    const cap = captureSql();
    const m = await store.loadSeriesByExternalIds([]);
    expect(m.size).toBe(0);
    expect(cap.calls).toHaveLength(0);
  });

  it("is one series query and one games query, no join, no limit", async () => {
    const cap = captureSql((sql) =>
      sql.includes('FROM "LeagueSeries"')
        ? [{ id: "ser-1", external_id: "x1", complete: false, team1_id: TEAM_A, team2_id: TEAM_B }]
        : [
            { series_id: "ser-1", external_match_id: "m1", number: 0, complete: true, winner: "blue", blue_side_team: 1, participants: {} },
            { series_id: "ser-1", external_match_id: "m2", number: 1, complete: false, winner: null, blue_side_team: 2, participants: {} },
          ],
    );
    const m = await store.loadSeriesByExternalIds(["x1", "x2"], TX);
    const [sq, gq] = cap.sqls();
    expect(sq).toMatch(/FROM "LeagueSeries" AS "LeagueSeries"/);
    expect(sq).toContain(`"external_id" IN ('x1', 'x2')`);
    expect(gq).toMatch(/FROM "LeagueGames" AS "LeagueGame"/);
    expect(gq).toContain(`"series_id" IN ('ser-1')`);
    for (const sql of cap.sqls()) {
      expect(sql).not.toMatch(/JOIN/);
      expect(sql).not.toMatch(/FROM \(SELECT/);
      expect(sql).not.toMatch(/LIMIT/);
    }
    expect([...m.keys()]).toEqual(["x1"]);
    expect(m.get("x1").games.map((g) => [g.external_match_id, g.complete])).toEqual([["m1", true], ["m2", false]]);
  });

  it("does not ask for games when no series is mirrored", async () => {
    const cap = captureSql(() => []);
    const m = await store.loadSeriesByExternalIds(["x1"]);
    expect(m.size).toBe(0);
    expect(cap.calls).toHaveLength(1);
  });
});

describe("loadSeriesForRefresh", () => {
  it("joins stage, tournament and both teams in one flat query (belongsTo only: no LIMIT subquery)", async () => {
    const cap = captureSql((sql) =>
      sql.includes('FROM "LeagueSeries"')
        ? [{
            id: "ser-1", external_id: "x1", tournament_id: TOUR.id, stage_id: STAGE.id, team1_id: TEAM_A, team2_id: null,
            "Stage.id": STAGE.id, "Stage.external_id": "stage-ext",
          }]
        : [],
    );
    await store.loadSeriesForRefresh("ser-1", TX).catch(() => {});
    const sql = cap.sqls()[0];
    expect(sql).toMatch(/FROM "LeagueSeries" AS "LeagueSeries"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "LeagueStages" AS "Stage"/);
    expect(sql).toMatch(/INNER JOIN "Tournaments" AS "Tournament"|LEFT OUTER JOIN "Tournaments" AS "Tournament"/);
    expect(sql).toMatch(/JOIN "Teams" AS "Team1"/);
    expect(sql).toMatch(/JOIN "Teams" AS "Team2"/);
    expect(sql).not.toMatch(/FROM \(SELECT/);
    expect(sql).toContain(`"LeagueSeries"."id" = 'ser-1'`);
  });

  it("is null when there is no such series", async () => {
    captureSql(() => []);
    expect(await store.loadSeriesForRefresh("missing")).toBeNull();
  });
});

describe("loadTeamsByExternalIds", () => {
  it("is pinned to the tournament", async () => {
    const cap = captureSql(() => [{ id: TEAM_A, external_id: "r1", name: "A" }]);
    const m = await store.loadTeamsByExternalIds(TOUR.id, ["r1", "r2"], TX);
    expect(cap.sqls()[0]).toContain(`"tournament_id" = '${TOUR.id}'`);
    expect(cap.sqls()[0]).toContain(`"external_id" IN ('r1', 'r2')`);
    expect(m.get("r1").id).toBe(TEAM_A);
  });
  it("asks nothing for no ids", async () => {
    const cap = captureSql();
    expect((await store.loadTeamsByExternalIds(TOUR.id, [])).size).toBe(0);
    expect(cap.calls).toHaveLength(0);
  });
});

describe("upsertStageTeams", () => {
  const refs = [
    { externalId: "r1", externalOrgId: "o1", name: "  Alpha  ", acronym: "ALP", palette: { primary: "#111111", secondary: "#222222" } },
    { externalId: "r2", externalOrgId: "o2", name: "Beta", acronym: null, palette: null },
  ];

  it("runs in one transaction it opens, inserts the missing and updates the known by (tournament_id, external_id)", async () => {
    ensureAssociations();
    const txSpy = vi.spyOn(sequelize, "transaction").mockImplementation(async (cb) => cb(TX));
    const cap = captureSql((sql) =>
      sql.includes('FROM "Teams"')
        ? [{ id: TEAM_A, external_id: "r1", name: "Old", tournament_id: TOUR.id, source: "esclub", owner_id: null, region: "na1" }]
        : [],
    );
    const result = await store.upsertStageTeams(TOUR, refs);
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(cap.calls.every((c) => c.options.transaction?.id === TX.id)).toBe(true);
    const sqls = cap.sqls();
    expect(sqls[0]).toMatch(/FROM "Teams" AS "Team"/);
    expect(sqls[0]).toContain(`"tournament_id" = '${TOUR.id}'`);
    expect(sqls[0]).toContain(`"external_id" IN ('r1', 'r2')`);
    const update = sqls.find((s) => /^UPDATE "Teams"/.test(s));
    expect(update).toMatch(/"name"='Alpha'/);
    expect(update).toContain(`WHERE "id" = '${TEAM_A}'`);
    const inserts = sqls.filter((s) => /^INSERT INTO "Teams"/.test(s));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("'Beta'");
    expect(inserts[0]).toContain("'esclub'");
    expect([...result.keys()]).toEqual(["r1", "r2"]);
  });

  it("joins the caller's transaction and opens none", async () => {
    const txSpy = vi.spyOn(sequelize, "transaction");
    const cap = captureSql(() => []);
    await store.upsertStageTeams(TOUR, refs, TX);
    expect(txSpy).not.toHaveBeenCalled();
    expect(cap.calls.every((c) => c.options.transaction?.id === TX.id)).toBe(true);
  });

  it("writes nothing for a tournament that is not an esclub one (invariants)", async () => {
    const cap = captureSql(() => []);
    await expect(store.upsertStageTeams({ ...TOUR, source: "manual" }, refs, TX)).rejects.toThrow();
    expect(cap.calls).toHaveLength(0);
  });

  it("asks nothing for no refs", async () => {
    const cap = captureSql();
    expect((await store.upsertStageTeams(TOUR, [], TX)).size).toBe(0);
    expect(cap.calls).toHaveLength(0);
  });
});

describe("seriesAttributes (the rules of a series row)", () => {
  const serie = {
    externalId: "x1", parentType: "Group", number: 3, esclubStatus: "Finished", status: "finished",
    bestOf: 3, draftType: null, startsAt: "2026-10-26T01:00:00.000Z",
  };
  const base = { tournamentId: TOUR.id, stageId: STAGE.id, serie, team1Id: TEAM_A, team2Id: TEAM_B, complete: false, now: T0 };

  it("sets both teams only when both are known", () => {
    expect(store.seriesAttributes(null, base)).toMatchObject({ team1_id: TEAM_A, team2_id: TEAM_B });
    expect(store.seriesAttributes(null, { ...base, team2Id: null })).toMatchObject({ team1_id: null, team2_id: null });
    expect(store.seriesAttributes(null, { ...base, team1Id: null, team2Id: null })).toMatchObject({ team1_id: null, team2_id: null });
  });

  it("never changes teams once set", () => {
    const existing = { team1_id: TEAM_B, team2_id: TEAM_A, draft_type: null, complete: false, finished_at: null };
    expect(store.seriesAttributes(existing, base)).toMatchObject({ team1_id: TEAM_B, team2_id: TEAM_A });
    expect(store.seriesAttributes(existing, { ...base, team1Id: null, team2Id: null })).toMatchObject({ team1_id: TEAM_B, team2_id: TEAM_A });
  });

  it("fills missing teams of an existing series", () => {
    const existing = { team1_id: null, team2_id: null, draft_type: null, complete: false, finished_at: null };
    expect(store.seriesAttributes(existing, base)).toMatchObject({ team1_id: TEAM_A, team2_id: TEAM_B });
  });

  it("keeps the stored draft type when the new one is null, and takes a new one", () => {
    const existing = { team1_id: null, team2_id: null, draft_type: "fearless", complete: false, finished_at: null };
    expect(store.seriesAttributes(existing, base).draft_type).toBe("fearless");
    expect(store.seriesAttributes(existing, { ...base, serie: { ...serie, draftType: "standard" } }).draft_type).toBe("standard");
    expect(store.seriesAttributes(null, base).draft_type).toBeNull();
  });

  it("stamps finished_at the first time the series is complete and never moves it", () => {
    expect(store.seriesAttributes(null, base).finished_at).toBeNull();
    expect(store.seriesAttributes(null, { ...base, complete: true }).finished_at).toEqual(T0);
    const earlier = new Date("2026-11-01T00:00:00.000Z");
    const existing = { team1_id: TEAM_A, team2_id: TEAM_B, draft_type: null, complete: true, finished_at: earlier };
    expect(store.seriesAttributes(existing, { ...base, complete: true }).finished_at).toEqual(earlier);
  });

  it("carries the listing's facts and the sync time", () => {
    expect(store.seriesAttributes(null, base)).toMatchObject({
      tournament_id: TOUR.id, stage_id: STAGE.id, external_id: "x1", parent_type: "Group", number: 3,
      esclub_status: "Finished", status: "finished", best_of: 3, starts_at: "2026-10-26T01:00:00.000Z",
      complete: false, last_synced_at: T0,
    });
  });
});

describe("partitionGames (a complete game is never touched)", () => {
  const game = (id, extra = {}) => ({
    externalMatchId: id, number: 0, playedAt: null, picks: Array(20).fill(""), firstPick: "blue", blueSideTeam: 1,
    winner: "blue", participants: { Ahri: { lane: "mid", playerKey: "k", gameName: "Player01", tagLine: "T01", side: "blue" }, Zed: { lane: "mid", playerKey: "j", gameName: "Player02", tagLine: "T02", side: "red" } },
    unmatchedParticipants: 0, substitutions: [], ...extra,
  });

  it("creates new, updates incomplete, skips complete", () => {
    const existing = [
      { id: "g1", external_match_id: "m1", complete: true },
      { id: "g2", external_match_id: "m2", complete: false },
    ];
    const { create, update, untouched } = store.partitionGames("ser-1", existing, [game("m1"), game("m2"), game("m3")]);
    expect(create.map((r) => r.external_match_id)).toEqual(["m3"]);
    expect(update.map((u) => u.id)).toEqual(["g2"]);
    expect(untouched).toEqual(["m1"]);
    expect(create[0]).toMatchObject({ series_id: "ser-1", complete: true, blue_side_team: 1, first_pick: "blue", winner: "blue" });
  });

  it("marks a game without a winner incomplete", () => {
    const { create } = store.partitionGames("s", [], [game("m1", { winner: null })]);
    expect(create[0].complete).toBe(false);
  });
});

describe("writeSeries SQL", () => {
  const serie = {
    externalId: "x1", parentType: "Group", number: 3, esclubStatus: "Finished", status: "finished",
    bestOf: 3, draftType: "fearless", startsAt: null,
  };
  const game = (id) => ({
    externalMatchId: id, number: 1, playedAt: "2026-10-26T01:00:00.000Z", picks: Array(20).fill("Ahri"), firstPick: "blue",
    blueSideTeam: 2, winner: "red", participants: { Ahri: { lane: "mid", playerKey: "k", gameName: "Player01", tagLine: "T01", side: "red" }, Zed: { lane: "mid", playerKey: "j", gameName: "Player02", tagLine: "T02", side: "blue" } },
    unmatchedParticipants: 1, substitutions: [],
  });
  const args = (games) => ({
    tournament: TOUR, stage: STAGE, serie, team1: { id: TEAM_A }, team2: { id: TEAM_B }, games, complete: false, now: T0,
  });

  it("does not let an old upcoming plan alter a series completed by its successor", async () => {
    const completed = { id: "ser-1", external_id: "x1", complete: true, status: "finished", draft_type: "fearless", team1_id: TEAM_A, team2_id: TEAM_B, finished_at: T0 };
    const cap = captureSql((sql) => sql.includes('FROM "LeagueSeries"') ? [completed] : []);
    const out = await store.writeSeries({ ...args([game("m3")]), serie: { ...serie, status: "upcoming", draftType: "standard" } }, TX);
    expect(out.series).toMatchObject(completed);
    expect(out.gamesWritten).toBe(0);
    expect(cap.sqls().every((sql) => /^SELECT/.test(sql))).toBe(true);
    expect(store.seriesAttributes(completed, { tournamentId: TOUR.id, stageId: STAGE.id, serie: { ...serie, status: "upcoming" }, complete: false, now: new Date() })).toEqual(completed);
  });

  it("suppresses the dialect SQL logger for participant inserts and updates", async () => {
    const cap = captureSql((sql) => {
      if (sql.includes('FROM "LeagueSeries"')) return [{ id: "ser-1", external_id: "x1", complete: false }];
      if (sql.includes('FROM "LeagueGames"')) return [{ id: "g1", external_match_id: "m1", complete: false }];
      return [];
    });
    const privateGame = (match) => ({ ...game(match), participants: { Ahri: { lane: "mid", side: "red", playerKey: "PRIVATE_KEY_SENTINEL", gameName: "Player99", tagLine: "T99" } } });
    await store.writeSeries(args([privateGame("m1"), privateGame("m2")]), TX);
    const sensitive = cap.calls.filter(({ sql }) => /^(INSERT INTO|UPDATE) "LeagueGames"/.test(sql));
    expect(sensitive).toHaveLength(2);
    const logger = vi.fn();
    for (const { sql, options } of sensitive) {
      const connection = { query: (_statement, callback) => callback(null, { rows: [], rowCount: 0 }) };
      const query = new sequelize.dialect.Query(connection, sequelize, { ...options, type: "RAW", logging: options.logging ?? logger });
      await query.run(sql);
    }
    expect(sensitive.every(({ sql }) => sql.includes("PRIVATE_KEY_SENTINEL") && sql.includes("Player99") && sql.includes("T99"))).toBe(true);
    expect(logger.mock.calls.flat().join(" ")).not.toMatch(/PRIVATE_KEY_SENTINEL|Player99|T99/);
    expect(sensitive.every(({ options }) => options.logging === false)).toBe(true);
  });

  it("inserts a new series by external_id and its games, all in the given transaction", async () => {
    const cap = captureSql(() => []);
    const out = await store.writeSeries(args([game("m1")]), TX);
    const sqls = cap.sqls();
    expect(sqls[0]).toMatch(/FROM "LeagueSeries" AS "LeagueSeries"/);
    expect(sqls[0]).toContain(`"external_id" = 'x1'`);
    expect(sqls.some((s) => /^INSERT INTO "LeagueSeries"/.test(s))).toBe(true);
    expect(sqls.filter((s) => /^INSERT INTO "LeagueGames"/.test(s))).toHaveLength(1);
    expect(cap.calls.every((c) => c.options.transaction?.id === TX.id)).toBe(true);
    expect(out.gamesWritten).toBe(1);
  });

  it("updates an existing series row, keeping its teams", async () => {
    const cap = captureSql((sql) =>
      sql.includes('FROM "LeagueSeries"')
        ? [{ id: "ser-1", external_id: "x1", tournament_id: TOUR.id, stage_id: STAGE.id, team1_id: TEAM_B, team2_id: TEAM_A, draft_type: null, complete: false, finished_at: null }]
        : [],
    );
    await store.writeSeries(args([]), TX);
    const update = cap.sqls().find((s) => /^UPDATE "LeagueSeries"/.test(s));
    expect(update).toBeDefined();
    expect(update).toContain(`WHERE "id" = 'ser-1'`);
    expect(update).not.toMatch(/"team1_id"/);
  });

  it("rewrites an incomplete game, inserts a new one, and never touches a complete one", async () => {
    const cap = captureSql((sql) => {
      if (sql.includes('FROM "LeagueSeries"')) {
        return [{ id: "ser-1", external_id: "x1", tournament_id: TOUR.id, stage_id: STAGE.id, team1_id: TEAM_A, team2_id: TEAM_B, complete: false }];
      }
      if (sql.includes('FROM "LeagueGames"')) {
        return [
          { id: "g1", series_id: "ser-1", external_match_id: "m1", complete: true },
          { id: "g2", series_id: "ser-1", external_match_id: "m2", complete: false },
        ];
      }
      return [];
    });
    const out = await store.writeSeries(args([game("m1"), game("m2"), game("m3")]), TX);
    const sqls = cap.sqls();
    const updates = sqls.filter((s) => /^UPDATE "LeagueGames"/.test(s));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`"id" = 'g2'`);
    expect(updates[0]).toMatch(/"complete" = false/);
    expect(sqls.filter((s) => /^INSERT INTO "LeagueGames"/.test(s))).toHaveLength(1);
    expect(sqls.some((s) => /^UPDATE "LeagueGames"/.test(s) && s.includes("'g1'"))).toBe(false);
    expect(out.gamesWritten).toBe(2);
    expect(out.gamesLeftAlone).toBe(1);
  });

  it("reads existing games of this series only", async () => {
    const cap = captureSql(() => []);
    await store.writeSeries(args([]), TX);
    const gq = cap.sqls().find((s) => s.includes('FROM "LeagueGames"'));
    // New series: it has no id to look games up with, so no games query at all.
    expect(gq).toBeUndefined();
  });
});

describe("rebuildRoster SQL", () => {
  const team = { id: TEAM_A };
  const participants = (suffix, side) => ({
    Ahri: { lane: "mid", playerKey: `k-${suffix}`, gameName: `Player${suffix}`, tagLine: "T01", side },
  });

  it("suppresses SQL logging for roster writes carrying Riot IDs", async () => {
    const cap = captureSql((sql) => {
      if (sql.includes('FROM "LeagueSeries"')) return [{ id: "ser-1", team1_id: TEAM_A }];
      if (sql.includes('FROM "LeagueGames"')) return [{ series_id: "ser-1", blue_side_team: 1, participants: participants("99", "blue") }];
      return [];
    });
    await store.rebuildRoster(team, TOUR.id, TX);
    const writes = cap.calls.filter(({ sql }) => /^(INSERT INTO|DELETE FROM) "TeamPlayers"/.test(sql));
    expect(writes).toHaveLength(2);
    const logger = vi.fn();
    for (const { sql, options } of writes) {
      const connection = { query: (_statement, callback) => callback(null, { rows: [], rowCount: 0 }) };
      await new sequelize.dialect.Query(connection, sequelize, { ...options, type: "RAW", logging: options.logging ?? logger }).run(sql);
    }
    expect(writes.some(({ sql }) => sql.includes("Player99") && sql.includes("T01"))).toBe(true);
    expect(logger.mock.calls.flat().join(" ")).not.toMatch(/Player99|T01/);
    expect(writes.every(({ options }) => options.logging === false)).toBe(true);
  });

  it("is scoped to one team: its series, their games, then delete and insert on that team_id only", async () => {
    const cap = captureSql((sql) => {
      if (sql.includes('FROM "LeagueSeries"')) {
        return [{ id: "ser-1", team1_id: TEAM_A }, { id: "ser-2", team1_id: TEAM_B }];
      }
      if (sql.includes('FROM "LeagueGames"')) {
        return [
          { series_id: "ser-1", blue_side_team: 1, played_at: new Date("2026-10-26T01:00:00Z"), participants: participants("01", "blue") },
          { series_id: "ser-2", blue_side_team: 1, played_at: null, participants: participants("02", "red") },
        ];
      }
      return [];
    });
    const n = await store.rebuildRoster(team, TOUR.id, TX);
    const sqls = cap.sqls();
    expect(sqls[0]).toContain(`"tournament_id" = '${TOUR.id}'`);
    expect(sqls[0]).toContain(`"team1_id" = '${TEAM_A}'`);
    expect(sqls[0]).toContain(`"team2_id" = '${TEAM_A}'`);
    expect(sqls[0]).not.toMatch(/JOIN|FROM \(SELECT|LIMIT/);
    expect(sqls[1]).toContain(`"series_id" IN ('ser-1', 'ser-2')`);
    expect(sqls[1]).not.toMatch(/JOIN|FROM \(SELECT|LIMIT/);
    const del = sqls.find((s) => /^DELETE FROM "TeamPlayers"/.test(s));
    expect(del).toContain(`WHERE "team_id" = '${TEAM_A}'`);
    const ins = sqls.find((s) => /^INSERT INTO "TeamPlayers"/.test(s));
    expect(ins).toContain(`'${TEAM_A}'`);
    expect(ins).not.toContain(TEAM_B);
    expect(sqls.indexOf(del)).toBeLessThan(sqls.indexOf(ins));
    expect(cap.calls.every((c) => c.options.transaction?.id === TX.id)).toBe(true);
    // ser-2 has team2 = team A: on blue-side-team 1 = team B, so A is red; both games' players are team A's.
    expect(n).toBe(2);
  });

  it("deletes and inserts nothing else when the team has no games or no named players", async () => {
    const cap = captureSql(() => []);
    expect(await store.rebuildRoster(team, TOUR.id, TX)).toBe(0);
    const sqls = cap.sqls();
    expect(sqls.filter((s) => /^DELETE FROM "TeamPlayers"/.test(s))).toHaveLength(1);
    expect(sqls.some((s) => /^INSERT/.test(s))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM "LeagueGames"'))).toBe(false);
  });

  it("leaves a player with no Riot ID off", async () => {
    const cap = captureSql((sql) => {
      if (sql.includes('FROM "LeagueSeries"')) return [{ id: "ser-1", team1_id: TEAM_A }];
      if (sql.includes('FROM "LeagueGames"')) {
        return [{ series_id: "ser-1", blue_side_team: 1, played_at: null, participants: { Ahri: { lane: "mid", playerKey: "k", gameName: null, tagLine: null, side: "blue" } } }];
      }
      return [];
    });
    expect(await store.rebuildRoster(team, TOUR.id, TX)).toBe(0);
    expect(cap.sqls().some((s) => /^INSERT/.test(s))).toBe(false);
  });
});

describe("touchSynced", () => {
  it("stamps the stage and the tournament by id", async () => {
    const cap = captureSql();
    await store.touchSynced(STAGE, TOUR, T0, TX);
    const sqls = cap.sqls();
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toMatch(/^UPDATE "LeagueStages" SET "last_synced_at"=/);
    expect(sqls[0]).toContain(`WHERE "id" = '${STAGE.id}'`);
    expect(sqls[1]).toMatch(/^UPDATE "Tournaments" SET "last_synced_at"=/);
    expect(sqls[1]).toContain(`WHERE "id" = '${TOUR.id}'`);
  });
});

describe("inTransaction", () => {
  it.each(["failed", "succeeded", null])("fences a %s sync before any mirror write", async (status) => {
    const cap = captureSql(() => status ? [{ status }] : []);
    vi.spyOn(sequelize, "transaction").mockImplementation(async (callback) => callback(TX));
    const write = vi.fn();
    await expect(store.inTransaction(write, "00000000-0000-4000-8000-000000000003")).rejects.toBeInstanceOf(EsclubSyncAbandoned);
    expect(write).not.toHaveBeenCalled();
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].sql).toBe('SELECT status FROM "EsclubSyncs" WHERE id = :syncId FOR UPDATE');
    expect(cap.calls[0].options.transaction).toEqual(TX);
  });

  it("locks the running sync row before the write callback, capturing rendered SQL", async () => {
    const { injectReplacements } = require("sequelize/lib/utils/sql");
    const cap = captureSql(() => [{ status: "running" }]);
    vi.spyOn(sequelize, "transaction").mockImplementation(async (callback) => callback(TX));
    const syncId = "00000000-0000-4000-8000-000000000003";
    await store.inTransaction(async (transaction) => {
      expect(transaction).toBe(TX);
      expect(cap.calls).toHaveLength(1);
    }, syncId);
    const captured = cap.calls[0];
    expect(injectReplacements(captured.sql, sequelize.dialect, captured.options.replacements)).toBe(`SELECT status FROM "EsclubSyncs" WHERE id = '${syncId}' FOR UPDATE`);
  });
  it("hands the callback a transaction from sequelize", async () => {
    vi.spyOn(sequelize, "transaction").mockImplementation(async (cb) => cb(TX));
    expect(await store.inTransaction(async (t) => t)).toBe(TX);
  });
});


describe("private linked name storage", () => {
  it("upserts only allowed columns on the composite key with SQL logging disabled", async () => {
    const cap = captureSql();
    await store.upsertPlayerNames(TOUR.id, [{ player_key: "synthetic-key", game_name: "Linked", tag_line: "TEST", checked_at: T0,
      id_user: "synthetic-private-user", discord: "synthetic-private-discord" }], TX);
    const insert = cap.calls.find((c) => c.sql.startsWith('INSERT INTO "LeaguePlayerNames"'));
    expect(insert.sql).toContain('ON CONFLICT ("tournament_id","player_key") DO UPDATE');
    expect(insert.sql).not.toMatch(/id_user|discord|synthetic-private/);
    expect(insert.options.logging).toBe(false);
    expect(insert.options.transaction).toEqual(TX);
  });
  it("loads names scoped to the tournament, without logging", async () => {
    const cap = captureSql();
    await store.loadPlayerNames(TOUR.id, TX);
    expect(cap.sqls()[0]).toContain(`"tournament_id" = '${TOUR.id}'`);
    expect(cap.calls[0].options.logging).toBe(false);
    expect(cap.calls[0].options.transaction).toEqual(TX);
  });
  it("rebuilds a roster using a linked name, suppressing the key-bearing read", async () => {
    const cap = captureSql((sql) => {
      if (sql.includes('FROM "LeagueSeries"')) return [{ id: "ser-1", team1_id: TEAM_A }];
      if (sql.includes('FROM "LeagueGames"')) return [{ series_id: "ser-1", blue_side_team: 1, played_at: null,
        participants: { Ahri: { lane: "mid", playerKey: "synthetic-key", gameName: null, tagLine: null, side: "blue" } } }];
      if (sql.includes('FROM "LeaguePlayerNames"')) return [{ player_key: "synthetic-key", game_name: "Linked", tag_line: "TEST", checked_at: T0 }];
      return [];
    });
    expect(await store.rebuildRoster({ id: TEAM_A }, TOUR.id, TX)).toBe(1);
    const read = cap.calls.find((c) => c.sql.includes('FROM "LeaguePlayerNames"'));
    expect(read.sql).toContain(`"tournament_id" = '${TOUR.id}'`);
    expect(read.options.logging).toBe(false);
    expect(cap.sqls().find((sql) => sql.startsWith('INSERT INTO "TeamPlayers"'))).toContain("'Linked'");
  });
});
