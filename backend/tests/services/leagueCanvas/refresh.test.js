import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest";
import { createRequire } from "node:module";

/**
 * S3 Task 5 (D6, D12, Q2 B, Q3 A): `refreshLeagueGroup`, the DB side of
 * `POST /api/canvas/:canvasId/group/:groupId/league-refresh`. Models are
 * mocked; the last block renders every new query's SQL with
 * `sequelize.query` stubbed (no connection opens).
 */

const require = createRequire(import.meta.url);
const sequelize = require("../../../config/database");
const setupAssociations = require("../../../models/associations");
const { Canvas, CanvasGroup, CanvasDraft } = require("../../../models/Canvas");
const Draft = require("../../../models/Draft");
const VersusDraft = require("../../../models/VersusDraft");
const LeagueSeries = require("../../../models/LeagueSeries");
const LeagueGame = require("../../../models/LeagueGame");
const { nextSeriesCardOrigin, SERIES_GAME_STEP } = require("../../../utils/seriesCardLayout");
const refresh = require("../../../services/leagueCanvas/refresh");

const {
  refreshLeagueGroup,
  GroupNotFoundError,
  NotImportedSeriesError,
  lockGroup,
  lockVersusDraft,
  loadSeriesDrafts,
  loadGroupCards,
  loadSeriesState,
  updateDraft,
  updateGroupMetadata,
  updateVersusDraftNames,
} = refresh;

beforeAll(() => setupAssociations());
afterEach(() => vi.restoreAllMocks());

const CANVAS = "cccccccc-0000-4000-8000-000000000001";
const GROUP = "99999999-0000-4000-8000-000000000001";
const VD = "77777777-0000-4000-8000-000000000001";
const SERIES = "bbbbbbbb-0000-4000-8000-000000000001";
const OWNER = "eeeeeeee-0000-4000-8000-000000000002";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const D0 = "dddddddd-0000-4000-8000-000000000000";
const D1 = "dddddddd-0000-4000-8000-000000000001";

const picks = (tag) => Array.from({ length: 20 }, (_, i) => `${tag}Champ${i}`);
const FIRST_Y = 172.5;

function gameRow(number, overrides = {}) {
  return {
    series_id: SERIES,
    number,
    picks: picks(`G${number}`),
    first_pick: "blue",
    blue_side_team: number % 2 === 0 ? 2 : 1,
    winner: "blue",
    complete: true,
    played_at: new Date("2026-11-11T19:00:00.000Z"),
    participants: {
      Ahri: { lane: "mid", playerKey: "oauth-riot-0007", gameName: "Player07", tagLine: "T07" },
      list: ["Player08#T08", { id_oauth_riot: "riot-0008" }],
    },
    ...overrides,
  };
}

// A Draft as loadSeriesDrafts returns it, in sync with gameRow(number).
function draftRow(id, number, overrides = {}) {
  const g = gameRow(number);
  return {
    id,
    seriesIndex: number,
    picks: [...g.picks],
    firstPick: g.first_pick,
    blueSideTeam: g.blue_side_team,
    winner: g.winner,
    completed: true,
    ...overrides,
  };
}

const FORBIDDEN_KEYS = new Set(["participants", "playerKey", "id_oauth_riot", "gameName", "tagLine", "id_user"]);
const FORBIDDEN_VALUES = ["Player07", "T07", "oauth-riot-0007", "Player08", "riot-0008"];

function walkForPlayerData(value, path = "") {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...walkForPlayerData(v, `${path}[${i}]`)));
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
let groupRow;
let versusDraftRow;
let drafts;
let cards;
let games;
let seriesState;
let ids;

beforeEach(() => {
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
  groupRow = {
    id: GROUP,
    canvas_id: CANVAS,
    type: "series",
    versus_draft_id: VD,
    metadata: {
      blueTeamName: "Zeta Wolves",
      redTeamName: "Alpha Owls",
      gameType: "scrim",
      length: 3,
      disabledChampions: ["Ahri"],
      origin: "manual",
    },
  };
  versusDraftRow = {
    id: VD,
    name: "Zeta Wolves vs Alpha Owls",
    owner_id: OWNER,
    blueTeamName: "Zeta Wolves",
    redTeamName: "Alpha Owls",
    league_series_id: SERIES,
  };
  drafts = [draftRow(D0, 0)];
  cards = [{ id: "cd-0", draft_id: D0, positionX: 0, positionY: FIRST_Y }];
  games = [gameRow(0)];
  seriesState = {
    id: SERIES,
    status: "finished",
    complete: true,
    team1_id: T2,
    team2_id: T1,
    Team1: { id: T2, name: "Zeta Wolves" },
    Team2: { id: T1, name: "Alpha Owls" },
  };

  vi.spyOn(Canvas.sequelize, "transaction").mockImplementation(async () => {
    calls.push("transaction");
    return transaction;
  });
  vi.spyOn(CanvasGroup, "findOne").mockImplementation(async () => {
    calls.push("CanvasGroup.findOne");
    return groupRow;
  });
  vi.spyOn(VersusDraft, "findOne").mockImplementation(async () => {
    calls.push("VersusDraft.findOne");
    return versusDraftRow;
  });
  vi.spyOn(Draft, "findAll").mockImplementation(async () => {
    calls.push("Draft.findAll");
    return drafts;
  });
  vi.spyOn(CanvasDraft, "findAll").mockImplementation(async () => {
    calls.push("CanvasDraft.findAll");
    return cards;
  });
  vi.spyOn(LeagueGame, "findAll").mockImplementation(async () => {
    calls.push("LeagueGame.findAll");
    return games;
  });
  vi.spyOn(LeagueSeries, "findOne").mockImplementation(async () => {
    calls.push("LeagueSeries.findOne");
    return seriesState;
  });
  vi.spyOn(Draft, "create").mockImplementation(async (v) => ({ ...v, id: `d-new-${++ids}` }));
  vi.spyOn(CanvasDraft, "create").mockImplementation(async (v) => ({ ...v, id: `cd-new-${++ids}` }));
  vi.spyOn(Draft, "update").mockImplementation(async () => {
    calls.push("Draft.update");
    return [1];
  });
  vi.spyOn(CanvasGroup, "update").mockImplementation(async () => {
    calls.push("CanvasGroup.update");
    return [1];
  });
  vi.spyOn(VersusDraft, "update").mockImplementation(async () => {
    calls.push("VersusDraft.update");
    return [1];
  });
  vi.spyOn(CanvasDraft, "update");
});

const run = () => refreshLeagueGroup({ canvasId: CANVAS, groupId: GROUP });

describe("refreshLeagueGroup: refusals", () => {
  it("a group not on this canvas (or gone): GroupNotFoundError, rolled back, nothing else read", async () => {
    groupRow = null;
    await expect(run()).rejects.toBeInstanceOf(GroupNotFoundError);
    expect(CanvasGroup.findOne.mock.calls[0][0].where).toEqual({ id: GROUP, canvas_id: CANVAS });
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(VersusDraft.findOne).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain group", () => { groupRow = { ...groupRow, type: "custom", versus_draft_id: null }; }],
    ["a series without a VersusDraft", () => { groupRow = { ...groupRow, versus_draft_id: null }; }],
    ["a manual series", () => { versusDraftRow = { ...versusDraftRow, league_series_id: null }; }],
    ["a purged series (league_series_id set NULL)", () => { versusDraftRow = { ...versusDraftRow, league_series_id: null }; }],
    ["a VersusDraft row that is gone", () => { versusDraftRow = null; }],
    ["a mirror series row that is gone", () => { seriesState = null; }],
  ])("%s: NotImportedSeriesError, rolled back, nothing written", async (_label, arrange) => {
    arrange();
    await expect(run()).rejects.toBeInstanceOf(NotImportedSeriesError);
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(Draft.create).not.toHaveBeenCalled();
    expect(Draft.update).not.toHaveBeenCalled();
  });
});

describe("refreshLeagueGroup: locking and reads", () => {
  it("locks the group, then the VersusDraft, before reading the series' Drafts", async () => {
    await run();
    expect(calls.slice(0, 4)).toEqual([
      "transaction",
      "CanvasGroup.findOne",
      "VersusDraft.findOne",
      "Draft.findAll",
    ]);
    expect(CanvasGroup.findOne.mock.calls[0][0]).toMatchObject({ lock: true, transaction });
    expect(VersusDraft.findOne.mock.calls[0][0]).toMatchObject({
      where: { id: VD },
      lock: true,
      transaction,
    });
    expect(Draft.findAll.mock.calls[0][0]).toMatchObject({ where: { versus_draft_id: VD }, transaction });
    expect(CanvasDraft.findAll.mock.calls[0][0]).toMatchObject({
      where: { canvas_id: CANVAS, group_id: GROUP },
      transaction,
    });
    expect(LeagueGame.findAll.mock.calls[0][0].where).toEqual({ series_id: [SERIES] });
    expect(LeagueSeries.findOne.mock.calls[0][0].where).toEqual({ id: SERIES });
  });
});

describe("refreshLeagueGroup: one retry on a deadlock or serialization failure", () => {
  // A fresh transaction object per attempt, as Sequelize gives.
  let transactions;
  beforeEach(() => {
    transactions = [];
    Canvas.sequelize.transaction.mockImplementation(async () => {
      calls.push("transaction");
      const t = {
        commit: vi.fn(async () => {
          calls.push("commit");
          t.finished = "commit";
        }),
        rollback: vi.fn(async () => {
          calls.push("rollback");
          t.finished = "rollback";
        }),
        finished: undefined,
      };
      transactions.push(t);
      return t;
    });
  });
  const failure = (where, code) =>
    Object.assign(new Error("lock trouble"), { [where]: { code } });

  it.each([
    ["40P01 on error.parent", "parent", "40P01"],
    ["40001 on error.original", "original", "40001"],
  ])("%s: rolls back, retries in a new transaction, and succeeds", async (_label, where, code) => {
    games = [gameRow(0), gameRow(1)];
    VersusDraft.findOne.mockRejectedValueOnce(failure(where, code));
    const out = await run();
    expect(out.result.added).toBe(1);
    expect(transactions).toHaveLength(2);
    expect(transactions[0].rollback).toHaveBeenCalledTimes(1);
    expect(transactions[0].commit).not.toHaveBeenCalled();
    expect(transactions[1].commit).toHaveBeenCalledTimes(1);
    expect(CanvasGroup.findOne).toHaveBeenCalledTimes(2);
    expect(CanvasGroup.findOne.mock.calls[1][0]).toMatchObject({ lock: true, transaction: transactions[1] });
    expect(Draft.create.mock.calls[0][1]).toEqual({ transaction: transactions[1] });
  });

  it("retries once only: a second deadlock is thrown", async () => {
    VersusDraft.findOne
      .mockRejectedValueOnce(failure("parent", "40P01"))
      .mockRejectedValueOnce(failure("parent", "40P01"));
    await expect(run()).rejects.toMatchObject({ parent: { code: "40P01" } });
    expect(transactions).toHaveLength(2);
    for (const t of transactions) expect(t.rollback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a plain error", () => new Error("boom")],
    ["another SQL state", () => failure("parent", "23505")],
    ["GroupNotFoundError", () => new GroupNotFoundError()],
  ])("%s is not retried", async (_label, make) => {
    CanvasGroup.findOne.mockRejectedValueOnce(make());
    await expect(run()).rejects.toBeTruthy();
    expect(transactions).toHaveLength(1);
  });
});

describe("refreshLeagueGroup: appends", () => {
  it("appends each missing game after the last card by positionX, locked, in this group; never moves a card", async () => {
    drafts = [draftRow(D0, 0), draftRow(D1, 1)];
    // Cards in creation order differ from x order: the last card is the one at x 380.
    cards = [
      { id: "cd-1", draft_id: D1, positionX: 380, positionY: FIRST_Y },
      { id: "cd-0", draft_id: D0, positionX: 0, positionY: FIRST_Y },
    ];
    games = [gameRow(0), gameRow(1), gameRow(3), gameRow(2)];
    const out = await run();
    expect(out.changed).toBe(true);
    expect(out.result).toEqual({ added: 2, updated: 0, series: { status: "finished", complete: true } });

    expect(Draft.create.mock.calls.map(([d]) => d.seriesIndex)).toEqual([2, 3]);
    for (const [d, opts] of Draft.create.mock.calls) {
      expect(d).toMatchObject({ versus_draft_id: VD, owner_id: OWNER, type: "versus" });
      expect(d.name).toBe(`Zeta Wolves vs Alpha Owls - Game ${d.seriesIndex + 1}`);
      expect(opts).toEqual({ transaction });
    }
    const first = nextSeriesCardOrigin({ positionX: 380, positionY: FIRST_Y });
    expect(CanvasDraft.create.mock.calls.map(([c]) => c)).toEqual([
      {
        canvas_id: CANVAS,
        group_id: GROUP,
        draft_id: "d-new-1",
        positionX: first.x,
        positionY: first.y,
        is_locked: true,
        source_type: "versus",
      },
      {
        canvas_id: CANVAS,
        group_id: GROUP,
        draft_id: "d-new-3",
        positionX: first.x + SERIES_GAME_STEP,
        positionY: first.y,
        is_locked: true,
        source_type: "versus",
      },
    ]);
    expect(CanvasDraft.update).not.toHaveBeenCalled();
    // Group position, name and layout never written.
    expect(CanvasGroup.update).not.toHaveBeenCalled();
    expect(transaction.commit).toHaveBeenCalledTimes(1);
  });

  it("the rightmost card is in the middle of three: appends follow it (max x, not first or last)", async () => {
    const D2 = "dddddddd-0000-4000-8000-000000000002";
    drafts = [draftRow(D0, 0), draftRow(D1, 1), draftRow(D2, 2)];
    cards = [
      { id: "cd-0", draft_id: D0, positionX: 0, positionY: FIRST_Y },
      { id: "cd-2", draft_id: D2, positionX: 760, positionY: FIRST_Y + 40 },
      { id: "cd-1", draft_id: D1, positionX: 380, positionY: FIRST_Y },
    ];
    games = [gameRow(0), gameRow(1), gameRow(2), gameRow(3)];
    await run();
    const origin = nextSeriesCardOrigin({ positionX: 760, positionY: FIRST_Y + 40 });
    expect(CanvasDraft.create).toHaveBeenCalledTimes(1);
    expect(CanvasDraft.create.mock.calls[0][0]).toMatchObject({ positionX: origin.x, positionY: origin.y });
  });

  it("a card dragged out of the group: its Draft is not re-added and is still updated", async () => {
    drafts = [draftRow(D0, 0), draftRow(D1, 1, { winner: null, completed: false })];
    cards = [{ id: "cd-0", draft_id: D0, positionX: 0, positionY: FIRST_Y }];
    games = [gameRow(0), gameRow(1), gameRow(2)];
    const out = await run();
    expect(Draft.create.mock.calls.map(([d]) => d.seriesIndex)).toEqual([2]);
    expect(CanvasDraft.create.mock.calls[0][0]).toMatchObject({ positionX: SERIES_GAME_STEP, positionY: FIRST_Y });
    expect(Draft.update).toHaveBeenCalledTimes(1);
    expect(Draft.update.mock.calls[0][1].where).toEqual({ id: D1, versus_draft_id: VD });
    expect(out.result).toMatchObject({ added: 1, updated: 1 });
  });

  it("no card left in the group: the append seeds at the first series origin", async () => {
    cards = [];
    games = [gameRow(0), gameRow(1)];
    await run();
    expect(CanvasDraft.create.mock.calls[0][0]).toMatchObject({ positionX: 0, positionY: FIRST_Y });
  });
});

describe("refreshLeagueGroup: updates (Q2 B, Q3 A)", () => {
  it("fills a missing winner (completed, completedAt), never clears one", async () => {
    drafts = [draftRow(D0, 0, { winner: null, completed: false })];
    await run();
    expect(Draft.update).toHaveBeenCalledTimes(1);
    const [values, opts] = Draft.update.mock.calls[0];
    expect(values).toEqual({
      winner: "blue",
      completed: true,
      completedAt: new Date("2026-11-11T19:00:00.000Z"),
    });
    expect(opts).toEqual({ where: { id: D0, versus_draft_id: VD }, transaction });

    vi.clearAllMocks();
    drafts = [draftRow(D0, 0)];
    games = [gameRow(0, { winner: null, complete: false })];
    const out = await run();
    expect(Draft.update).not.toHaveBeenCalled();
    expect(out.changed).toBe(false);
  });

  it("picks follow the mirror and bump picksVersion, resetting lastPickMutationId", async () => {
    games = [gameRow(0, { picks: picks("New"), complete: false, winner: null })];
    drafts = [draftRow(D0, 0, { winner: null, completed: false })];
    const out = await run();
    expect(out.result).toMatchObject({ added: 0, updated: 1 });
    const [values] = Draft.update.mock.calls[0];
    expect(values.picks).toEqual(picks("New"));
    expect(values.lastPickMutationId).toBeNull();
    expect(values.picksVersion).toBeInstanceOf(sequelize.Sequelize.Utils.Literal);
    expect(values.picksVersion.val).toBe('"picksVersion" + 1');
  });

  it("sides and first pick follow the mirror without a picksVersion bump", async () => {
    drafts = [draftRow(D0, 0, { firstPick: "red", blueSideTeam: 1 })];
    await run();
    const [values] = Draft.update.mock.calls[0];
    expect(values).toEqual({ firstPick: "blue", blueSideTeam: 2 });
  });
});

describe("refreshLeagueGroup: names", () => {
  it("rewrites the names from the linked teams on the group and VersusDraft; every other metadata key kept", async () => {
    seriesState = {
      ...seriesState,
      Team1: { id: T2, name: "Zeta Wolves Renamed" },
      Team2: { id: T1, name: "Alpha Owls" },
    };
    const out = await run();
    expect(out.changed).toBe(true);
    expect(out.result).toMatchObject({ added: 0, updated: 0 });
    expect(CanvasGroup.update).toHaveBeenCalledTimes(1);
    const [values, opts] = CanvasGroup.update.mock.calls[0];
    expect(Object.keys(values)).toEqual(["metadata"]);
    expect(values.metadata).toEqual({ ...groupRow.metadata, blueTeamName: "Zeta Wolves Renamed" });
    expect(values.metadata.gameType).toBe("scrim");
    expect(opts).toEqual({ where: { id: GROUP, canvas_id: CANVAS }, transaction });
    expect(VersusDraft.update).toHaveBeenCalledTimes(1);
    expect(VersusDraft.update.mock.calls[0]).toEqual([
      { blueTeamName: "Zeta Wolves Renamed", redTeamName: "Alpha Owls" },
      { where: { id: VD }, transaction },
    ]);
  });

  it("a placeholder or missing team name is never written", async () => {
    seriesState = { ...seriesState, Team1: { id: T2, name: "Team 1" }, Team2: null, team2_id: null };
    groupRow = { ...groupRow, metadata: { gameType: "official" } };
    const out = await run();
    expect(CanvasGroup.update).not.toHaveBeenCalled();
    expect(VersusDraft.update).not.toHaveBeenCalled();
    expect(out.changed).toBe(false);
  });

  it("names already current: no group or VersusDraft write", async () => {
    await run();
    expect(CanvasGroup.update).not.toHaveBeenCalled();
    expect(VersusDraft.update).not.toHaveBeenCalled();
  });
});

describe("refreshLeagueGroup: nothing to do, idempotence, privacy", () => {
  it("nothing changed: committed, changed false, no write", async () => {
    const out = await run();
    expect(out).toEqual({
      changed: false,
      result: { added: 0, updated: 0, series: { status: "finished", complete: true } },
    });
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(Draft.create).not.toHaveBeenCalled();
    expect(Draft.update).not.toHaveBeenCalled();
  });

  it("an in-progress series reports its status", async () => {
    seriesState = { ...seriesState, status: "in_progress", complete: false };
    const out = await run();
    expect(out.result.series).toEqual({ status: "in_progress", complete: false });
  });

  it("rolls back and rethrows when a write fails", async () => {
    games = [gameRow(0), gameRow(1)];
    Draft.create.mockRejectedValueOnce(new Error("boom"));
    await expect(run()).rejects.toThrow("boom");
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it("writes no player data (every create and update value, and the result)", async () => {
    drafts = [draftRow(D0, 0, { winner: null, completed: false, picks: picks("Old") })];
    games = [gameRow(0), gameRow(1)];
    seriesState = { ...seriesState, Team1: { id: T2, name: "Zeta Wolves Renamed" } };
    const out = await run();
    const written = [Draft, CanvasDraft]
      .flatMap((m) => m.create.mock.calls.map((c) => c[0]))
      .concat([Draft, CanvasGroup, VersusDraft].flatMap((m) => m.update.mock.calls.map((c) => c[0])));
    expect(written.length).toBeGreaterThan(3);
    expect(walkForPlayerData(written)).toEqual([]);
    expect(walkForPlayerData(out)).toEqual([]);
  });
});

describe("generated SQL (sequelize.query stubbed, no connection)", () => {
  beforeEach(() => vi.restoreAllMocks());

  // Statements with bind parameters (the UPDATEs) arrive as { query, bind };
  // inline the values, as tests/services/esclub/mirrorStore.test.js does.
  const renderSql = (sql) => {
    if (typeof sql === "string") return sql;
    const lit = (v) =>
      v === null || v === undefined ? "NULL"
        : v instanceof Date ? `'${v.toISOString()}'`
        : typeof v === "string" ? `'${v}'`
        : typeof v === "object" ? `'${JSON.stringify(v)}'`
        : String(v);
    return sql.query.replace(/\$(\d+)/g, (_m, n) => lit(sql.bind[Number(n) - 1]));
  };
  const sqlOf = async (fn, result = []) => {
    const query = vi.spyOn(sequelize, "query").mockResolvedValue(result);
    await fn();
    expect(query).toHaveBeenCalledTimes(1);
    const sql = renderSql(query.mock.calls[0][0]);
    expect(typeof sql).toBe("string");
    return sql;
  };
  const fakeTransaction = { id: "tx", LOCK: Canvas.sequelize.Transaction?.LOCK };

  it("lockGroup: the group by id AND canvas, FOR UPDATE, no join", async () => {
    const sql = await sqlOf(() => lockGroup(CANVAS, GROUP, fakeTransaction), null);
    expect(sql).toMatch(/FROM "CanvasGroups" AS "CanvasGroup"/);
    expect(sql).toContain(`"CanvasGroup"."id" = '${GROUP}'`);
    expect(sql).toContain(`"CanvasGroup"."canvas_id" = '${CANVAS}'`);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/JOIN/);
  });

  it("lockVersusDraft: by id, FOR UPDATE, no join", async () => {
    const sql = await sqlOf(() => lockVersusDraft(VD, fakeTransaction), null);
    expect(sql).toMatch(/FROM "VersusDrafts" AS "VersusDraft"/);
    expect(sql).toContain(`"VersusDraft"."id" = '${VD}'`);
    expect(sql).toContain('"league_series_id"');
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/JOIN/);
  });

  it("loadSeriesDrafts: every Draft of the series, the planner's columns only", async () => {
    const sql = await sqlOf(() => loadSeriesDrafts(VD, fakeTransaction));
    expect(sql).toMatch(/FROM "Drafts" AS "Draft"/);
    expect(sql).toContain(`"Draft"."versus_draft_id" = '${VD}'`);
    const selected = sql.slice(0, sql.indexOf(" FROM "));
    for (const column of ["id", "seriesIndex", "picks", "firstPick", "blueSideTeam", "winner", "completed"]) {
      expect(selected).toContain(`"${column}"`);
    }
    expect(sql).not.toMatch(/JOIN|FOR UPDATE/);
  });

  it("loadGroupCards: the group's cards on this canvas", async () => {
    const sql = await sqlOf(() => loadGroupCards(CANVAS, GROUP, fakeTransaction));
    expect(sql).toMatch(/FROM "CanvasDrafts" AS "CanvasDraft"/);
    expect(sql).toContain(`"CanvasDraft"."canvas_id" = '${CANVAS}'`);
    expect(sql).toContain(`"CanvasDraft"."group_id" = '${GROUP}'`);
    expect(sql).toContain('"positionX"');
    expect(sql).not.toMatch(/JOIN/);
  });

  it("loadSeriesState: status, complete, team ids, LEFT joins for the two team names only", async () => {
    const sql = await sqlOf(() => loadSeriesState(SERIES, fakeTransaction), null);
    expect(sql).toMatch(/FROM "LeagueSeries" AS "LeagueSeries"/);
    expect(sql).toContain(`"LeagueSeries"."id" = '${SERIES}'`);
    expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team1" ON "LeagueSeries"\."team1_id" = "Team1"\."id"/);
    expect(sql).toMatch(/LEFT OUTER JOIN "Teams" AS "Team2" ON "LeagueSeries"\."team2_id" = "Team2"\."id"/);
    expect(sql).toContain('"Team1"."name"');
    expect(sql).not.toMatch(/INNER JOIN|LeagueGames|participants|TeamPlayers|external_id|FOR UPDATE/);
  });

  it("the games read (send.loadGames) never selects participants", async () => {
    const { loadGames } = require("../../../services/leagueCanvas/send");
    const sql = await sqlOf(() => loadGames([SERIES], fakeTransaction));
    expect(sql).toContain(`"LeagueGame"."series_id" IN ('${SERIES}')`);
    expect(sql).not.toMatch(/participants|substitutions|external_match_id/);
  });

  it("updateDraft with picks: bumps picksVersion in SQL, clears lastPickMutationId, pinned to the series", async () => {
    const sql = await sqlOf(
      () =>
        updateDraft(
          VD,
          { id: D0, changes: { picks: picks("New"), firstPick: "red" }, picksChanged: true },
          fakeTransaction,
        ),
      [[], 0],
    );
    expect(sql).toMatch(/^UPDATE "Drafts" SET/);
    expect(sql).toContain('"picksVersion"="picksVersion" + 1');
    expect(sql).toMatch(/"lastPickMutationId"=NULL/);
    expect(sql).toMatch(/"firstPick"=/);
    expect(sql).toContain(`"id" = '${D0}'`);
    expect(sql).toContain(`"versus_draft_id" = '${VD}'`);
  });

  it("updateDraft without picks: no picksVersion", async () => {
    const sql = await sqlOf(
      () => updateDraft(VD, { id: D0, changes: { winner: "red", completed: true, completedAt: new Date(0) } }, fakeTransaction),
      [[], 0],
    );
    expect(sql).toMatch(/^UPDATE "Drafts" SET/);
    expect(sql).not.toContain("picksVersion");
    expect(sql).toMatch(/"winner"=/);
  });

  it("updateGroupMetadata: the metadata column only, by id and canvas", async () => {
    const sql = await sqlOf(
      () => updateGroupMetadata(CANVAS, GROUP, { blueTeamName: "A", gameType: "official" }, fakeTransaction),
      [[], 0],
    );
    expect(sql).toMatch(/^UPDATE "CanvasGroups" SET "metadata"=/);
    expect(sql).not.toMatch(/positionX|positionY|"name"=/);
    expect(sql).toContain(`"id" = '${GROUP}'`);
    expect(sql).toContain(`"canvas_id" = '${CANVAS}'`);
  });

  it("updateVersusDraftNames: the two name columns only", async () => {
    const sql = await sqlOf(
      () => updateVersusDraftNames(VD, { blueTeamName: "A", redTeamName: "B" }, fakeTransaction),
      [[], 0],
    );
    expect(sql).toMatch(/^UPDATE "VersusDrafts" SET "blueTeamName"='A',"redTeamName"='B',"updatedAt"='[^']+' WHERE "id" = '/);
    expect(sql).toContain(`"id" = '${VD}'`);
  });
});
