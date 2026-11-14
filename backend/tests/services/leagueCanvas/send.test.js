import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { createRequire } from "node:module";

/**
 * S3 Task 4 (D2–D5, D11): `sendLeagueSeries`, the DB side of
 * `POST /api/canvas/:canvasId/import/league-series`. Models are mocked; the
 * last block renders every new query's SQL with `sequelize.query` stubbed (no
 * connection opens).
 */

const require = createRequire(import.meta.url);
const sequelize = require("../../../config/database");
const setupAssociations = require("../../../models/associations");
const { Canvas, CanvasGroup, CanvasDraft } = require("../../../models/Canvas");
const Draft = require("../../../models/Draft");
const VersusDraft = require("../../../models/VersusDraft");
const LeagueSeries = require("../../../models/LeagueSeries");
const LeagueGame = require("../../../models/LeagueGame");
const UserTournament = require("../../../models/UserTournament");
const teamAccess = require("../../../services/teamAccess");
const { DEFAULT_ROW_STEP } = require("../../../services/leagueCanvas/plan");
const send = require("../../../services/leagueCanvas/send");

const {
  sendLeagueSeries,
  validateSendBody,
  CanvasNotFoundError,
  lockCanvas,
  loadSeries,
  loadGames,
  findExistingGroups,
  ensureUserTournaments,
} = send;

beforeAll(() => setupAssociations());
afterEach(() => vi.restoreAllMocks());

const CANVAS = "cccccccc-0000-4000-8000-000000000001";
const USER = "eeeeeeee-0000-4000-8000-000000000001";
const TOURNAMENT = "dddddddd-0000-4000-8000-000000000001";
const TOURNAMENT_2 = "dddddddd-0000-4000-8000-000000000002";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const T3 = "aaaaaaaa-0000-4000-8000-000000000003";
const sid = (n) => `bbbbbbbb-0000-4000-8000-00000000000${n}`;

const team = (id, name) => ({ id, name, source: "esclub", owner_id: null });

// A mirror series as `loadSeries` returns it (raw + nest). team1 is the
// roster esclub lists first; T2 is listed first in series 1 on purpose, so
// fix 7 can't pass by alphabetical or id accident.
function seriesRow(n, overrides = {}) {
  return {
    id: sid(n),
    tournament_id: TOURNAMENT,
    number: n,
    team1_id: T2,
    team2_id: T1,
    best_of: 3,
    draft_type: "fearless",
    starts_at: new Date(`2026-11-1${n}T18:00:00.000Z`),
    status: "finished",
    complete: true,
    Team1: team(T2, "Zeta Wolves"),
    Team2: team(T1, "Alpha Owls"),
    Stage: { name: "Regular Season" },
    ...overrides,
  };
}

const picks = (tag) => Array.from({ length: 20 }, (_, i) => `${tag}Champ${i}`);

// Mirror games, deliberately carrying participants: a mock returns what it is
// given, so this proves nothing from these keys is copied anywhere.
function gameRow(seriesId, number, overrides = {}) {
  return {
    series_id: seriesId,
    number,
    picks: picks(`G${number}`),
    first_pick: "blue",
    blue_side_team: number % 2 === 0 ? 2 : 1,
    winner: number === 0 ? "red" : "blue",
    complete: true,
    played_at: new Date("2026-11-11T19:00:00.000Z"),
    participants: {
      Ahri: { lane: "mid", playerKey: "oauth-riot-0007", gameName: "Player07", tagLine: "T07" },
    },
    ...overrides,
  };
}

const FORBIDDEN_KEYS = new Set([
  "participants",
  "playerKey",
  "id_oauth_riot",
  "gameName",
  "tagLine",
  "id_user",
]);
const FORBIDDEN_VALUES = ["Player07", "T07", "oauth-riot-0007"];

function walkForPlayerData(value, path = "") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...walkForPlayerData(v, `${path}.${i}`)));
  } else if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) hits.push(`${path}.${k}`);
      hits.push(...walkForPlayerData(v, `${path}.${k}`));
    }
  } else if (typeof value === "string" && FORBIDDEN_VALUES.some((s) => value.includes(s))) {
    hits.push(`${path}=${value}`);
  }
  return hits;
}

let calls;
let transaction;
let existingGroups;
let seriesRows;
let gameRows;
let canvasRow;
let ids;

function mockModels() {
  calls = [];
  ids = 0;
  transaction = {
    commit: vi.fn(async () => {
      calls.push("commit");
      transaction.finished = "commit";
    }),
    rollback: vi.fn(async () => {
      calls.push("rollback");
      transaction.finished = "rollback";
    }),
    finished: undefined,
  };
  vi.spyOn(Canvas.sequelize, "transaction").mockImplementation(async () => {
    calls.push("transaction");
    return transaction;
  });
  vi.spyOn(Canvas, "findOne").mockImplementation(async (opts) => {
    calls.push("Canvas.findOne");
    return canvasRow;
  });
  vi.spyOn(LeagueSeries, "findAll").mockImplementation(async () => {
    calls.push("LeagueSeries.findAll");
    return seriesRows;
  });
  vi.spyOn(LeagueGame, "findAll").mockImplementation(async () => {
    calls.push("LeagueGame.findAll");
    return gameRows;
  });
  vi.spyOn(CanvasGroup, "findAll").mockImplementation(async (opts) => {
    if (opts.attributes && opts.attributes.length === 1 && opts.attributes[0] === "name") {
      calls.push("CanvasGroup.findAll(names)");
      return [];
    }
    calls.push("CanvasGroup.findAll(existing)");
    return existingGroups;
  });
  vi.spyOn(VersusDraft, "create").mockImplementation(async (values) => {
    calls.push("VersusDraft.create");
    return { ...values, id: `vd-${++ids}` };
  });
  vi.spyOn(Draft, "create").mockImplementation(async (values) => {
    calls.push("Draft.create");
    return { ...values, id: `d-${++ids}` };
  });
  vi.spyOn(CanvasGroup, "create").mockImplementation(async (values) => {
    calls.push("CanvasGroup.create");
    return { ...values, id: `g-${++ids}` };
  });
  vi.spyOn(CanvasDraft, "create").mockImplementation(async (values) => {
    calls.push("CanvasDraft.create");
    return { ...values, id: `cd-${++ids}` };
  });
  vi.spyOn(UserTournament, "bulkCreate").mockImplementation(async () => {
    calls.push("UserTournament.bulkCreate");
    return [];
  });
  vi.spyOn(UserTournament, "update");
  vi.spyOn(UserTournament, "upsert");
}

beforeEach(() => {
  canvasRow = { id: CANVAS };
  existingGroups = [];
  seriesRows = [seriesRow(1)];
  gameRows = [gameRow(sid(1), 1), gameRow(sid(1), 0)];
  mockModels();
});

const run = (overrides = {}) =>
  sendLeagueSeries({
    canvasId: CANVAS,
    userId: USER,
    leagueSeriesIds: [sid(1)],
    positionX: 400,
    positionY: 300,
    ...overrides,
  });

describe("validateSendBody", () => {
  const ok = { leagueSeriesIds: [sid(1)], positionX: 10, positionY: 20 };

  it("accepts a list of uuids and two finite numbers", () => {
    expect(validateSendBody(ok)).toEqual({
      ok: true,
      value: { leagueSeriesIds: [sid(1)], positionX: 10, positionY: 20, rowStep: undefined },
    });
  });

  it("passes rowStep through and lowercases ids", () => {
    const upper = sid(1).toUpperCase();
    expect(validateSendBody({ ...ok, leagueSeriesIds: [upper], rowStep: 900 }).value).toEqual({
      leagueSeriesIds: [sid(1)],
      positionX: 10,
      positionY: 20,
      rowStep: 900,
    });
  });

  it.each([
    ["no body", undefined],
    ["ids missing", { positionX: 1, positionY: 1 }],
    ["ids not an array", { ...ok, leagueSeriesIds: sid(1) }],
    ["empty list", { ...ok, leagueSeriesIds: [] }],
    ["51 ids", { ...ok, leagueSeriesIds: Array.from({ length: 51 }, (_, i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`) }],
    ["a non-uuid", { ...ok, leagueSeriesIds: ["not-a-uuid"] }],
    ["a number id", { ...ok, leagueSeriesIds: [7] }],
    ["duplicates", { ...ok, leagueSeriesIds: [sid(1), sid(1)] }],
    ["duplicates differing in case", { ...ok, leagueSeriesIds: [sid(1), sid(1).toUpperCase()] }],
    ["positionX missing", { leagueSeriesIds: [sid(1)], positionY: 1 }],
    ["positionY a string", { ...ok, positionY: "5" }],
    ["positionX NaN-like", { ...ok, positionX: null }],
  ])("refuses %s", (_label, body) => {
    const result = validateSendBody(body);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  // D5: the server falls back to the default step when it has no usable one,
  // like `columnPositions` does; a bad step never refuses the send.
  it.each([
    ["null", null],
    ["a string", "900"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an object", { step: 900 }],
  ])("treats rowStep %s as absent (default step)", (_label, rowStep) => {
    expect(validateSendBody({ ...ok, rowStep })).toEqual({
      ok: true,
      value: { leagueSeriesIds: [sid(1)], positionX: 10, positionY: 20, rowStep: undefined },
    });
  });

  it("accepts exactly 50 ids", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(validateSendBody({ ...ok, leagueSeriesIds: fifty }).ok).toBe(true);
  });
});

describe("sendLeagueSeries", () => {
  it("locks the Canvas row first, inside the transaction, before any other read", async () => {
    await run();
    expect(calls.slice(0, 2)).toEqual(["transaction", "Canvas.findOne"]);
    const opts = Canvas.findOne.mock.calls[0][0];
    expect(opts.where).toEqual({ id: CANVAS });
    expect(opts.lock).toBe(true);
    expect(opts.transaction).toBe(transaction);
  });

  it("loads the series and the games inside the transaction, after the lock", async () => {
    await run();
    expect(LeagueSeries.findAll).toHaveBeenCalledTimes(1);
    expect(LeagueSeries.findAll.mock.calls[0][0].transaction).toBe(transaction);
    expect(LeagueGame.findAll).toHaveBeenCalledTimes(1);
    expect(LeagueGame.findAll.mock.calls[0][0].transaction).toBe(transaction);
    const lock = calls.indexOf("Canvas.findOne");
    expect(calls.indexOf("LeagueSeries.findAll")).toBeGreaterThan(lock);
    expect(calls.indexOf("LeagueGame.findAll")).toBeGreaterThan(lock);
  });

  it("D5: rowStep null falls back to the default step", async () => {
    seriesRows = [seriesRow(1), seriesRow(2)];
    gameRows = [gameRow(sid(1), 0), gameRow(sid(2), 0)];
    await run({ leagueSeriesIds: [sid(1), sid(2)], rowStep: null });
    expect(CanvasGroup.create.mock.calls.map((c) => c[0].positionY)).toEqual([300, 300 + DEFAULT_ROW_STEP]);
  });

  it("throws CanvasNotFoundError and rolls back when the canvas is gone", async () => {
    canvasRow = null;
    await expect(run()).rejects.toBeInstanceOf(CanvasNotFoundError);
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(LeagueSeries.findAll).not.toHaveBeenCalled();
    expect(VersusDraft.create).not.toHaveBeenCalled();
  });

  it("builds one series: VersusDraft, a Draft per game, the group and locked cards", async () => {
    const result = await run();

    expect(result.existing).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].leagueSeriesId).toBe(sid(1));

    expect(VersusDraft.create).toHaveBeenCalledTimes(1);
    const vd = VersusDraft.create.mock.calls[0][0];
    expect(vd).toMatchObject({
      origin: "manual",
      league_series_id: sid(1),
      length: 3,
      type: "fearless",
      competitive: true,
      owner_id: USER,
    });
    expect(VersusDraft.create.mock.calls[0][1]).toEqual({ transaction });

    expect(Draft.create).toHaveBeenCalledTimes(2);
    const drafts = Draft.create.mock.calls.map((c) => c[0]);
    expect(drafts.map((d) => d.seriesIndex)).toEqual([0, 1]);
    for (const d of drafts) {
      expect(d.versus_draft_id).toBe("vd-1");
      expect(d.owner_id).toBe(USER);
      expect(d.type).toBe("versus");
    }
    expect(drafts[0].picks).toEqual(picks("G0"));
    expect(drafts[0].blueSideTeam).toBe(2);
    expect(drafts[0].winner).toBe("red");
    expect(drafts[0].completed).toBe(true);

    expect(CanvasGroup.create).toHaveBeenCalledTimes(1);
    const group = CanvasGroup.create.mock.calls[0][0];
    expect(group).toMatchObject({
      canvas_id: CANVAS,
      type: "series",
      versus_draft_id: "vd-1",
      positionX: 400,
      positionY: 300,
      name: "Zeta Wolves vs Alpha Owls",
    });
    expect(group.metadata).toMatchObject({ gameType: "official", origin: "manual", length: 3 });
    // ids: vd-1, d-2, d-3, g-4, cd-5, cd-6
    expect(result.created[0].groupId).toBe("g-4");

    const cards = CanvasDraft.create.mock.calls.map((c) => c[0]);
    expect(cards).toHaveLength(2);
    const draftIds = Draft.create.mock.calls.map((_, i) => `d-${i + 2}`);
    expect(cards.map((c) => c.draft_id)).toEqual(draftIds);
    for (const card of cards) {
      expect(card).toMatchObject({
        canvas_id: CANVAS,
        group_id: "g-4",
        is_locked: true,
        source_type: "versus",
      });
      expect(card).not.toHaveProperty("seriesIndex");
    }
    expect(calls.at(-1)).toBe("commit");
  });

  it("asks generateUniqueCanvasGroupName for the name, in the transaction", async () => {
    await run();
    const nameQuery = CanvasGroup.findAll.mock.calls.find((c) => c[0].attributes?.[0] === "name");
    expect(nameQuery[0].where).toEqual({ canvas_id: CANVAS });
    expect(nameQuery[0].transaction).toBe(transaction);
  });

  it("fix 7: LeagueSeries.team1 is team1 on the group, its metadata and the VersusDraft", async () => {
    await run();
    const vd = VersusDraft.create.mock.calls[0][0];
    const group = CanvasGroup.create.mock.calls[0][0];
    expect(group.team1_id).toBe(T2);
    expect(group.team2_id).toBe(T1);
    expect(group.metadata.blueTeamName).toBe("Zeta Wolves");
    expect(group.metadata.redTeamName).toBe("Alpha Owls");
    expect(vd.blueTeamName).toBe("Zeta Wolves");
    expect(vd.redTeamName).toBe("Alpha Owls");
    // Sides stay per game.
    expect(Draft.create.mock.calls.map((c) => c[0].blueSideTeam)).toEqual([2, 1]);
  });

  it("D4: a series already on this canvas is returned under existing and nothing is created", async () => {
    existingGroups = [{ id: "g-old", VersusDraft: { league_series_id: sid(1) } }];
    const result = await run();
    expect(result).toEqual({
      created: [],
      existing: [{ leagueSeriesId: sid(1), groupId: "g-old" }],
      skipped: [],
    });
    expect(VersusDraft.create).not.toHaveBeenCalled();
    expect(Draft.create).not.toHaveBeenCalled();
    expect(CanvasGroup.create).not.toHaveBeenCalled();
    expect(CanvasDraft.create).not.toHaveBeenCalled();
    expect(UserTournament.bulkCreate).not.toHaveBeenCalled();
    expect(transaction.commit).toHaveBeenCalledTimes(1);
  });

  it("D4: the existing check is pinned to this canvas and the requested ids, inside the transaction", async () => {
    await run({ leagueSeriesIds: [sid(1), sid(2)] });
    const call = CanvasGroup.findAll.mock.calls.find((c) => c[0].include);
    expect(call[0].where).toEqual({ canvas_id: CANVAS });
    expect(call[0].include[0].where).toEqual({ league_series_id: [sid(1), sid(2)] });
    expect(call[0].include[0].required).toBe(true);
    expect(call[0].transaction).toBe(transaction);
    // Read after the lock.
    expect(calls.indexOf("CanvasGroup.findAll(existing)")).toBeGreaterThan(calls.indexOf("Canvas.findOne"));
  });

  it("D3: refusals and unknown ids are skipped with their reason, in request order", async () => {
    seriesRows = [
      seriesRow(1),
      seriesRow(2, { status: "upcoming" }),
      seriesRow(3, { team2_id: null, Team2: null }),
      seriesRow(4),
    ];
    gameRows = [gameRow(sid(1), 0), gameRow(sid(2), 0), gameRow(sid(3), 0)];
    const unknown = sid(9);
    const result = await run({ leagueSeriesIds: [unknown, sid(2), sid(3), sid(4), sid(1)] });
    expect(result.skipped).toEqual([
      { leagueSeriesId: unknown, reason: "not-found" },
      { leagueSeriesId: sid(2), reason: "upcoming" },
      { leagueSeriesId: sid(3), reason: "no-teams" },
      { leagueSeriesId: sid(4), reason: "no-games" },
    ]);
    expect(result.created.map((c) => c.leagueSeriesId)).toEqual([sid(1)]);
    expect(VersusDraft.create).toHaveBeenCalledTimes(1);
  });

  it("a team-less series loaded through a LEFT join (nulls nested) is refused no-teams", async () => {
    seriesRows = [
      seriesRow(1, {
        team2_id: null,
        Team2: { id: null, name: null, source: null, owner_id: null },
      }),
    ];
    const result = await run();
    expect(result.skipped).toEqual([{ leagueSeriesId: sid(1), reason: "no-teams" }]);
  });

  it("D11: canLinkTeam is consulted for both teams; a refusal skips not-linkable", async () => {
    const spy = vi.spyOn(teamAccess, "canLinkTeam");
    await run();
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: T2 }), USER);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: T1 }), USER);

    mockModels();
    spy.mockImplementation((t) => t.id !== T1);
    const result = await run();
    expect(result.skipped).toEqual([{ leagueSeriesId: sid(1), reason: "not-linkable" }]);
    expect(VersusDraft.create).not.toHaveBeenCalled();
    expect(CanvasGroup.create).not.toHaveBeenCalled();
  });

  it("D5: bulk in one transaction, newest first, one column with no gap for existing or skipped", async () => {
    // starts_at: 1 → 11-11, 2 → 11-12, 3 → 11-13, 4 → 11-14 (existing), 5 → 11-15 (upcoming)
    seriesRows = [1, 2, 3, 4, 5].map((n) =>
      seriesRow(n, n === 5 ? { status: "upcoming" } : {}),
    );
    gameRows = [1, 2, 3, 4, 5].map((n) => gameRow(sid(n), 0));
    existingGroups = [{ id: "g-old", VersusDraft: { league_series_id: sid(4) } }];

    const result = await run({
      leagueSeriesIds: [sid(1), sid(4), sid(2), sid(5), sid(3)],
      rowStep: 900,
    });

    expect(Canvas.sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(result.created.map((c) => c.leagueSeriesId)).toEqual([sid(3), sid(2), sid(1)]);
    expect(result.existing).toEqual([{ leagueSeriesId: sid(4), groupId: "g-old" }]);
    expect(result.skipped).toEqual([{ leagueSeriesId: sid(5), reason: "upcoming" }]);

    const positions = CanvasGroup.create.mock.calls.map((c) => [c[0].positionX, c[0].positionY]);
    expect(positions).toEqual([
      [400, 300],
      [400, 1200],
      [400, 2100],
    ]);
    // Each group carries its own series' VersusDraft.
    const vdIdBySeries = new Map();
    for (const [i, c] of VersusDraft.create.mock.calls.entries()) {
      vdIdBySeries.set(c[0].league_series_id, (await VersusDraft.create.mock.results[i].value).id);
    }
    expect(CanvasGroup.create.mock.calls.map((c) => c[0].versus_draft_id)).toEqual(
      [sid(3), sid(2), sid(1)].map((id) => vdIdBySeries.get(id)),
    );
    // Every write in the one transaction.
    for (const model of [VersusDraft, Draft, CanvasGroup, CanvasDraft]) {
      for (const c of model.create.mock.calls) expect(c[1]).toEqual({ transaction });
    }
  });

  it("D5: rowStep absent falls back to the default; out of range is clamped", async () => {
    seriesRows = [seriesRow(1), seriesRow(2)];
    gameRows = [gameRow(sid(1), 0), gameRow(sid(2), 0)];
    await run({ leagueSeriesIds: [sid(1), sid(2)] });
    expect(CanvasGroup.create.mock.calls.map((c) => c[0].positionY)).toEqual([300, 300 + DEFAULT_ROW_STEP]);

    mockModels();
    await run({ leagueSeriesIds: [sid(1), sid(2)], rowStep: 50 });
    expect(CanvasGroup.create.mock.calls.map((c) => c[0].positionY)).toEqual([300, 500]);
  });

  it("R3: creates the UserTournaments rows if missing, never un-archiving (ON CONFLICT DO NOTHING)", async () => {
    seriesRows = [seriesRow(1), seriesRow(2), seriesRow(3, { tournament_id: TOURNAMENT_2 })];
    gameRows = [gameRow(sid(1), 0), gameRow(sid(2), 0), gameRow(sid(3), 0)];
    await run({ leagueSeriesIds: [sid(1), sid(2), sid(3)] });

    expect(UserTournament.bulkCreate).toHaveBeenCalledTimes(1);
    const [rows, opts] = UserTournament.bulkCreate.mock.calls[0];
    expect(rows).toEqual([
      { user_id: USER, tournament_id: TOURNAMENT_2, archived_at: null },
      { user_id: USER, tournament_id: TOURNAMENT, archived_at: null },
    ]);
    expect(opts).toEqual({ ignoreDuplicates: true, transaction });
    expect(opts).not.toHaveProperty("updateOnDuplicate");
    expect(UserTournament.update).not.toHaveBeenCalled();
    expect(UserTournament.upsert).not.toHaveBeenCalled();
    expect(calls.indexOf("UserTournament.bulkCreate")).toBeLessThan(calls.indexOf("commit"));
  });

  it("R3: no UserTournaments write when nothing is sent", async () => {
    seriesRows = [seriesRow(1, { status: "upcoming" })];
    await run();
    expect(UserTournament.bulkCreate).not.toHaveBeenCalled();
  });

  it("rolls back and rethrows when a write fails", async () => {
    CanvasGroup.create.mockRejectedValueOnce(new Error("boom"));
    await expect(run()).rejects.toThrow("boom");
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("writes no player data anywhere (every create's values, and the result)", async () => {
    seriesRows = [seriesRow(1), seriesRow(2)];
    gameRows = [gameRow(sid(1), 0), gameRow(sid(1), 1), gameRow(sid(2), 0)];
    const result = await run({ leagueSeriesIds: [sid(1), sid(2)] });
    const written = [VersusDraft, Draft, CanvasGroup, CanvasDraft]
      .flatMap((m) => m.create.mock.calls.map((c) => c[0]))
      .concat(UserTournament.bulkCreate.mock.calls.map((c) => c[0]));
    expect(written.length).toBeGreaterThan(0);
    expect(walkForPlayerData(written)).toEqual([]);
    expect(walkForPlayerData(result)).toEqual([]);
  });
});

describe("generated SQL (sequelize.query stubbed, no connection)", () => {
  // The file's beforeEach mocks the models; here Sequelize must render for real.
  beforeEach(() => vi.restoreAllMocks());

  const sqlOf = async (fn, result = []) => {
    const query = vi.spyOn(sequelize, "query").mockResolvedValue(result);
    await fn();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(typeof sql).toBe("string");
    return sql;
  };
  const fakeTransaction = { id: "tx", LOCK: Canvas.sequelize.Transaction?.LOCK };

  it("lockCanvas: SELECT … FROM Canvases WHERE id … FOR UPDATE", async () => {
    const sql = await sqlOf(() => lockCanvas(CANVAS, fakeTransaction), null);
    expect(sql).toMatch(/FROM "Canvases" AS "Canvas"/);
    expect(sql).toContain(`"Canvas"."id" = '${CANVAS}'`);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/JOIN/);
  });

  it("loadSeries: public columns, LEFT joins to both teams and the stage, no player data", async () => {
    const sql = await sqlOf(() => loadSeries([sid(1), sid(2)], fakeTransaction));
    expect(sql).toMatch(/FROM "LeagueSeries" AS "LeagueSeries"/);
    expect(sql).toContain(`"LeagueSeries"."id" IN ('${sid(1)}', '${sid(2)}')`);
    expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team1" ON "LeagueSeries"\."team1_id" = "Team1"\."id"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team2" ON "LeagueSeries"\."team2_id" = "Team2"\."id"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "LeagueStages" AS "Stage" ON "LeagueSeries"\."stage_id" = "Stage"\."id"/);
    expect(sql).not.toMatch(/INNER JOIN/);
    expect(sql).not.toMatch(/LeagueGames|participants|TeamPlayers|external_id/);
    expect(sql).not.toMatch(/FOR UPDATE/);
  });

  it("loadGames: the listed columns only, never participants", async () => {
    const sql = await sqlOf(() => loadGames([sid(1)], fakeTransaction));
    expect(sql).toMatch(/FROM "LeagueGames" AS "LeagueGame"/);
    expect(sql).toContain(`"LeagueGame"."series_id" IN ('${sid(1)}')`);
    const selected = sql.slice(0, sql.indexOf(" FROM "));
    for (const column of ["series_id", "number", "picks", "first_pick", "blue_side_team", "winner", "complete", "played_at"]) {
      expect(selected).toContain(`"${column}"`);
    }
    expect(sql).not.toMatch(/participants|substitutions|external_match_id/);
    expect(sql).not.toMatch(/JOIN/);
  });

  it("findExistingGroups: pinned to the canvas, inner join to VersusDrafts on league_series_id", async () => {
    const sql = await sqlOf(() => findExistingGroups(CANVAS, [sid(1)], fakeTransaction));
    expect(sql).toMatch(/FROM "CanvasGroups" AS "CanvasGroup"/);
    expect(sql).toContain(`"CanvasGroup"."canvas_id" = '${CANVAS}'`);
    expect(sql).toMatch(/INNER JOIN "VersusDrafts" AS "VersusDraft" ON "CanvasGroup"\."versus_draft_id" = "VersusDraft"\."id"/);
    expect(sql).toContain(`"VersusDraft"."league_series_id" IN ('${sid(1)}')`);
    expect(sql).not.toMatch(/LeagueSeries|LeagueGames|participants/);
  });

  it("findExistingGroups: maps each series to its first group", async () => {
    vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([
      { id: "g-a", VersusDraft: { league_series_id: sid(1) } },
      { id: "g-b", VersusDraft: { league_series_id: sid(1) } },
      { id: "g-c", VersusDraft: { league_series_id: sid(2) } },
    ]);
    const map = await findExistingGroups(CANVAS, [sid(1), sid(2)], fakeTransaction);
    expect([...map.entries()]).toEqual([
      [sid(1), "g-a"],
      [sid(2), "g-c"],
    ]);
  });

  it("ensureUserTournaments: one INSERT … ON CONFLICT DO NOTHING, never an update", async () => {
    const sql = await sqlOf(() => ensureUserTournaments(USER, [TOURNAMENT], fakeTransaction), [[], 0]);
    expect(sql).toMatch(/^INSERT INTO "UserTournaments"/);
    expect(sql).toContain(`'${USER}'`);
    expect(sql).toContain(`'${TOURNAMENT}'`);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(sql).not.toMatch(/DO UPDATE|UPDATE "UserTournaments"/);
  });

  it("ensureUserTournaments: no query for no tournaments", async () => {
    const query = vi.spyOn(sequelize, "query");
    await ensureUserTournaments(USER, [], fakeTransaction);
    expect(query).not.toHaveBeenCalled();
  });
});
