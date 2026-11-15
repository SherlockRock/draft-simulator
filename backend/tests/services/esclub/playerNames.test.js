import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { fillPlayerNames, newNameState, isWanted } = require("../../../services/esclub/playerNames");
const sync = require("../../../services/esclub/sync");
const E = require("../../../services/esclub/errors");
const T0 = new Date("2026-11-15T12:00:00Z");
const older = "2026-11-14T12:00:00Z";
const key = (n) => `synthetic-account-${n}`;
const user = (n) => `synthetic-user-${n}`;
const entry = (n, seriesId = "latest", playedAt = older, extra = {}) => ({ teamNumber: 1, seriesId,
  game: { blueSideTeam: 1, playedAt, participants: { Ahri: { playerKey: key(n), gameName: null, tagLine: null, side: "blue", lane: "mid", ...extra } } } });
const team = (id, entries) => ({ id, external_id: `roster-${id}`, entries });
const member = (id, n, extra = {}) => ({ id_parent: `roster-${id}`, type_parent: "TeamRoster", id_user: user(n), type_member: "Starter", time_start: 1, time_end: null, ...extra });
const account = (n) => ({ type_oauth: "Riot", id_oauth_external: key(n), name: `Player${n}#TEST` });

function harness({ teams = [team("a", [entry(1)])], stageTeams = teams, lists = { latest: [member("a", 1)] }, oauths = { [user(1)]: [account(1)] }, rows = [], fail, summary = sync.newSummary() } = {}) {
  const names = new Map(rows.map((r) => [r.player_key, r]));
  const calls = [];
  const rebuilds = [];
  let abandoned = false;
  const store = {
    inTransaction: vi.fn(async (work, syncId) => {
      if (abandoned && syncId === "sync-name-test") throw new E.EsclubSyncAbandoned("sync no longer running");
      const snap = new Map(names);
      try { return await work({ id: "name-tx" }); } catch (error) { names.clear(); for (const [k, v] of snap) names.set(k, v); throw error; }
    }),
    loadStageTeamPlayers: vi.fn(async () => ({ teams: stageTeams, allTeams: teams,
      allKeys: new Set(teams.flatMap((t) => t.entries.flatMap((e) => Object.values(e.game.participants).map((p) => p.playerKey)))) })),
    loadPlayerNames: vi.fn(async () => [...names.values()]),
    upsertPlayerNames: vi.fn(async (_tid, writes) => { for (const row of writes) names.set(row.player_key, row); }),
    rebuildRoster: vi.fn(async (t) => rebuilds.push(t.id)),
  };
  const client = { request: vi.fn(async (name, context) => {
    if (fail) { const error = fail(name, context, calls.length); if (error) throw error; }
    calls.push({ name, context });
    if (name === "fetch-members-by-serie") return { members: lists[context.id_serie] ?? [] };
    if (name === "fetch-oauths-by-user") return { oauths: oauths[context.id_user] ?? [] };
    throw new Error("unexpected stub request");
  }) };
  const nameState = newNameState();
  const args = { tournament: { id: "t-name-test" }, stage: { id: "s-name-test" }, store, summary, now: () => T0, nameState };
  return { args, store, client, calls, names, rebuilds, run: () => fillPlayerNames(client, args), abandon: () => { abandoned = true; } };
}
afterEach(() => vi.restoreAllMocks());

describe("stage linked name resolution", () => {
  it("stops early and keeps only a matching Riot name from mixed oauth replies", async () => {
    const h = harness({ lists: { latest: [member("a", 1), member("a", 2)] }, oauths: { [user(1)]: [account(1), { type_oauth: "Discord", name: "synthetic-discord-name", id_oauth_external: "synthetic-discord-id" }, account(999)] } });
    await h.run();
    expect(h.calls.map((c) => c.name)).toEqual(["fetch-members-by-serie", "fetch-oauths-by-user"]);
    expect([...h.names.values()]).toEqual([{ player_key: key(1), game_name: "Player1", tag_line: "TEST", checked_at: T0 }]);
    expect(h.rebuilds).toEqual(["a"]);
    expect(h.args.summary).toMatchObject({ nameMemberLists: 1, nameLookups: 1, namesResolved: 1, namesUnmatched: 0 });
    expect(JSON.stringify(h.args.summary)).not.toMatch(/synthetic|Player1|Discord|accountKey|id_user/);
  });
  it("skips game-named and linked-named players and unchanged no-matches", async () => {
    const h = harness({ teams: [team("a", [entry(1, "latest", older, { gameName: "Game", tagLine: "T" }), entry(2), entry(3)])], rows: [
      { player_key: key(2), game_name: "Linked", tag_line: "T", checked_at: T0 },
      { player_key: key(3), game_name: null, tag_line: null, checked_at: T0 },
    ] });
    await h.run();
    expect(h.calls).toHaveLength(0);
    expect(h.store.upsertPlayerNames).not.toHaveBeenCalled();
  });
  it("rechecks a no-match only after a strictly newer game; null dates stay oldest", () => {
    const row = { game_name: null, checked_at: T0 };
    expect(isWanted({ named: false, latest: T0.getTime() + 1 }, row)).toBe(true);
    expect(isWanted({ named: false, latest: T0.getTime() }, row)).toBe(false);
    expect(isWanted({ named: false, latest: -Infinity }, row)).toBe(false);
    expect(isWanted({ named: true, latest: Infinity })).toBe(false);
    expect(isWanted({ named: false, latest: -Infinity })).toBe(true);
  });
  it("rechecks a stale no-match, resolves it and avoids another lookup", async () => {
    const h = harness({ teams: [team("a", [entry(1, "latest", "2026-11-15T11:00:00Z")])], rows: [{ player_key: key(1), game_name: null, tag_line: null, checked_at: new Date(older) }] });
    await h.run();
    h.calls.length = 0;
    await h.run();
    expect(h.calls).toHaveLength(0);
    expect(h.args.summary.namesResolved).toBe(1);
  });
  it("reads the latest series with games, then the latest series of a remaining player", async () => {
    const h = harness({ teams: [team("a", [entry(2, "oldest", "2026-11-10T00:00:00Z"), entry(2, "extra", older), entry(1, "latest", "2026-11-15T10:00:00Z")])],
      lists: { latest: [member("a", 1)], extra: [member("a", 2, { time_end: 2 })] }, oauths: { [user(1)]: [account(1)], [user(2)]: [account(2)] } });
    await h.run();
    expect(h.calls.filter((c) => c.name === "fetch-members-by-serie").map((c) => c.context.id_serie)).toEqual(["latest", "extra"]);
    expect(h.args.summary.namesResolved).toBe(2);
  });
  it("processes teams with the most wanted first, reuses lists and deduplicates users across rosters", async () => {
    const a = team("a", [entry(1)]);
    const b = team("b", [entry(2), entry(3)]);
    const h = harness({ teams: [a, b], lists: { latest: [member("a", 4), member("b", 4), member("b", 2), member("a", 1)] }, oauths: { [user(2)]: [account(2)], [user(1)]: [account(1)] } });
    await h.run();
    expect(h.calls.filter((c) => c.name === "fetch-members-by-serie")).toHaveLength(1);
    expect(h.calls.filter((c) => c.name === "fetch-oauths-by-user").map((c) => c.context.id_user)).toEqual([user(4), user(2), user(1)]);
    expect(h.args.summary).toMatchObject({ namesResolved: 2, namesUnmatched: 1 });
  });
  it("matches moved players across the tournament and rebuilds every affected team", async () => {
    const a = team("a", [entry(1)]), b = team("b", [entry(1), entry(2)]);
    const h = harness({ teams: [a, b], stageTeams: [a], oauths: { [user(1)]: [account(1), account(2)] } });
    await h.run();
    expect(h.args.summary.namesResolved).toBe(2);
    expect(h.rebuilds).toEqual(["a", "b"]);
  });
  it("writes no-matches only after both lists finish and does not read a third", async () => {
    const h = harness({ teams: [team("a", [entry(1, "latest", "2026-11-15T10:00:00Z"), entry(2, "extra"), entry(3, "third", "2026-11-10T00:00:00Z")])],
      lists: { latest: [member("a", 4)], extra: [member("a", 5)], third: [member("a", 3)] } });
    await h.run();
    expect(h.calls.filter((c) => c.name === "fetch-members-by-serie").map((c) => c.context.id_serie)).toEqual(["latest", "extra"]);
    expect(h.args.summary.namesUnmatched).toBe(3);
    expect([...h.names.values()].every((n) => n.game_name === null && n.tag_line === null)).toBe(true);
    expect(h.rebuilds).toEqual([]);
  });
  it.each([E.EsclubRequestCapReached, E.EsclubBudgetExhausted, E.EsclubProtocolChanged])("%s during lookups preserves matches, omits no-matches and succeeds", async (ErrorClass) => {
    const h = harness({ teams: [team("a", [entry(1), entry(2)])], lists: { latest: [member("a", 1), member("a", 2)] },
      fail: (name, ctx) => name === "fetch-oauths-by-user" && ctx.id_user === user(2) ? new ErrorClass("synthetic-private-context") : undefined });
    const state = { limitsFromEnv: () => ({ cap: 400, budget: 2000 }), finishSync: vi.fn() };
    const result = await sync.runSync({ id: "sync-name-test" }, async (client, summary) => {
      h.args.summary = summary;
      await fillPlayerNames(client, h.args);
    }, { session: async (work) => work(h.client), state });
    expect(result.status).toBe("succeeded");
    expect(h.names.size).toBe(1);
    expect(result.summary.namesUnmatched).toBe(0);
    expect(h.args.nameState.stopped).toBe(true);
    const reason = ErrorClass === E.EsclubRequestCapReached ? "names: request cap" : ErrorClass === E.EsclubBudgetExhausted ? "names: daily budget" : "names: EsclubProtocolChanged";
    expect(result.summary.skipped).toEqual({ [reason]: 1 });
    // A cap or budget refusal is never sent, so it is not counted as a lookup.
    expect(result.summary.nameLookups).toBe(ErrorClass === E.EsclubProtocolChanged ? 2 : 1);
    expect(JSON.stringify(result.summary)).not.toContain("synthetic-private");
  });
  it("a protocol stop on the extra member list keeps earlier matches and retries absences next sync", async () => {
    const h = harness({ teams: [team("a", [entry(1, "latest", "2026-11-15T10:00:00Z"), entry(2, "extra")])],
      fail: (name, ctx) => name === "fetch-members-by-serie" && ctx.id_serie === "extra" ? new E.EsclubProtocolChanged("bad field") : undefined });
    await h.run();
    expect(h.names.size).toBe(1);
    expect(h.args.summary).toMatchObject({ namesResolved: 1, namesUnmatched: 0, skipped: { "names: EsclubProtocolChanged": 1 } });
  });
  it("stops after 120 oauth lookups, writes matches, and leaves other players retryable", async () => {
    const h = harness({ teams: [team("a", [entry(1), entry(2)])], lists: { latest: Array.from({ length: 121 }, (_, n) => member("a", n + 1)) } });
    await h.run();
    expect(h.calls.filter((c) => c.name === "fetch-oauths-by-user")).toHaveLength(120);
    expect(h.args.summary).toMatchObject({ nameLookups: 120, namesResolved: 1, namesUnmatched: 0, skipped: { "names: lookup limit": 1 } });
    expect(h.names.has(key(2))).toBe(false);
  });
  it.each([E.EsclubUnavailable, E.EsclubSyncAbandoned])("%s propagates and writes nothing for the team in hand", async (ErrorClass) => {
    const h = harness({ teams: [team("a", [entry(1), entry(2)])], lists: { latest: [member("a", 1), member("a", 2)] },
      fail: (name, ctx) => name === "fetch-oauths-by-user" && ctx.id_user === user(2) ? new ErrorClass("stop") : undefined });
    await expect(h.run()).rejects.toBeInstanceOf(ErrorClass);
    expect(h.names.size).toBe(0);
  });
  it("fences the write after requests; abandoned ownership writes nothing", async () => {
    const h = harness();
    Object.defineProperty(h.args.summary, "syncId", { value: "sync-name-test" });
    const original = h.client.request;
    h.client.request = async (...args) => { const reply = await original(...args); if (args[0] === "fetch-oauths-by-user") h.abandon(); return reply; };
    await expect(h.run()).rejects.toBeInstanceOf(E.EsclubSyncAbandoned);
    expect(h.names.size).toBe(0);
    expect(h.store.upsertPlayerNames).not.toHaveBeenCalled();
    expect(h.store.inTransaction.mock.calls.every((call) => call[1] === "sync-name-test")).toBe(true);
  });
});


it("reuses private Riot projections for games first imported by a later stage", async () => {
  const h = harness({ oauths: { [user(1)]: [account(1), account(2)] } });
  await h.run();
  const laterTeam = team("b", [entry(2)]);
  h.store.loadStageTeamPlayers.mockResolvedValue({ teams: [laterTeam], allTeams: [laterTeam], allKeys: new Set([key(2)]) });
  h.calls.length = 0;
  await h.run();
  expect(h.calls).toHaveLength(0);
  expect(h.names.get(key(2)).game_name).toBe("Player2");
  expect(h.args.summary.nameLookups).toBe(1);
});

it.each([E.EsclubRequestCapReached, E.EsclubBudgetExhausted, E.EsclubProtocolChanged])("%s on the first member list leaves all wanted players retryable", async (ErrorClass) => {
  const h = harness({ fail: () => new ErrorClass("private stop text") });
  await h.run();
  expect(h.names.size).toBe(0);
  expect(h.args.summary.namesUnmatched).toBe(0);
  expect(h.store.upsertPlayerNames).not.toHaveBeenCalled();
});

it("rolls back names when roster replacement fails and does not count uncommitted resolutions", async () => {
  const h = harness();
  h.store.rebuildRoster.mockRejectedValue(new Error("synthetic database failure"));
  await expect(h.run()).rejects.toThrow("synthetic database failure");
  expect(h.names.size).toBe(0);
  expect(h.args.summary.namesResolved).toBe(0);
});
