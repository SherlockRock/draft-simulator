import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sequelize = require("../../../config/database");
const { injectReplacements } = require("sequelize/lib/utils/sql");
const Tournament = require("../../../models/Tournament");
const LeagueStage = require("../../../models/LeagueStage");
const LeagueSeries = require("../../../models/LeagueSeries");
const UserTournament = require("../../../models/UserTournament");
const syncState = require("../../../services/esclub/syncState");
const syncEngine = require("../../../services/esclub/sync");
const mirrorStore = require("../../../services/esclub/mirrorStore");
const A = require("../../../services/esclub/addLeague");
const { EsclubError, EsclubProtocolChanged, EsclubNotFound } = require("../../../services/esclub/errors");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));

const GROUP_SERIE = fx("group-bo3/serie.json").reply;
const ROUND_SERIE = fx("bracket-bo3/serie.json").reply;
const GROUP = fx("group.json").reply;
const GROUP_ROUND = fx("rounds.json").reply; // a fetch-round-shaped reply: rounds[0] is the group's round
const BRACKET_ROUND = fx("bracket-bo3/round.json").reply;
const STAGE = fx("event-stage.json").reply;
const EVENT = fx("event-active.json").reply;

const SERIE_ID = GROUP_SERIE.series[0].id_serie;
const ROUND_SERIE_ID = ROUND_SERIE.series[0].id_serie;
const SEASON_ID = EVENT.events[0].id_event_active;
const STAGE_ID = STAGE.events[0].id_event_stage;
const LOL = STAGE.events[0].id_game;
const T0 = new Date("2026-11-14T12:00:00.000Z");
const ON = { ESCLUB_SYNC_ENABLED: "true" };
const URL_OK = `https://esclub.gg/multimedia/serie/${SERIE_ID}/draft?match_number=1`;

// ---- parseEsclubUrl ---------------------------------------------------------

describe("parseEsclubUrl", () => {
  const id = "11f1c28a-af6b-071b-93aa-058d0cf4fd47";
  const ok = (text, expected = id) => expect(A.parseEsclubUrl(text)).toEqual({ kind: "serie", id: expected });
  const no = (text) => expect(A.parseEsclubUrl(text)).toBeNull();

  it("accepts a series link, with or without its draft tail, query and fragment", () => {
    ok(`https://esclub.gg/multimedia/serie/${id}`);
    ok(`https://esclub.gg/multimedia/serie/${id}/`);
    ok(`https://esclub.gg/multimedia/serie/${id}/draft`);
    ok(`https://esclub.gg/multimedia/serie/${id}/draft?match_number=2`);
    ok(`https://esclub.gg/multimedia/serie/${id}?x=1#top`);
    ok(`https://esclub.gg/multimedia/serie/${id}#top`);
  });

  it("accepts http, www, any host case and surrounding whitespace", () => {
    ok(`http://esclub.gg/multimedia/serie/${id}`);
    ok(`https://www.esclub.gg/multimedia/serie/${id}`);
    ok(`HTTPS://WWW.ESCLUB.GG/multimedia/serie/${id}`);
    ok(`  \n https://esclub.gg/multimedia/serie/${id}/draft \t`);
  });

  it("lower-cases an upper-case id", () => {
    ok(`https://esclub.gg/multimedia/serie/${id.toUpperCase()}/draft`);
  });

  it("rejects other hosts, including look-alikes", () => {
    no(`https://example.com/multimedia/serie/${id}`);
    no(`https://esclub.gg.evil.com/multimedia/serie/${id}`);
    no(`https://evil.com/esclub.gg/multimedia/serie/${id}`);
    no(`https://notesclub.gg/multimedia/serie/${id}`);
    no(`https://user@esclub.gg/multimedia/serie/${id}`);
    no(`https://esclub.gg:8443/multimedia/serie/${id}`);
    no(`https://esclub.gg@evil.com/multimedia/serie/${id}`);
  });

  it("rejects other paths", () => {
    no(`https://esclub.gg/multimedia/series/${id}`);
    no(`https://esclub.gg/serie/${id}`);
    no(`https://esclub.gg/multimedia/serie`);
    no(`https://esclub.gg/multimedia/serie/`);
    no(`https://esclub.gg/x/multimedia/serie/${id}`);
    no(`https://esclub.gg/multimedia/stage/${id}`);
    no(`https://esclub.gg/multimedia/serie/${id}x/draft`);
  });

  it("rejects a missing or malformed id", () => {
    no("https://esclub.gg/multimedia/serie/not-a-uuid");
    no("https://esclub.gg/multimedia/serie/11f1c28a-af6b-071b-93aa");
    no("https://esclub.gg/multimedia/serie/11f1c28aaf6b071b93aa058d0cf4fd47");
    no("https://esclub.gg/multimedia/serie/11f1c28a-af6b-071b-93aa-058d0cf4fd4g");
    no(`https://esclub.gg/multimedia/serie/${id}0`);
  });

  it("rejects other schemes, bare ids and junk", () => {
    no(`javascript:alert(1)//esclub.gg/multimedia/serie/${id}`);
    no(`ftp://esclub.gg/multimedia/serie/${id}`);
    no(`//esclub.gg/multimedia/serie/${id}`);
    no(`esclub.gg/multimedia/serie/${id}`);
    no(id);
    no("");
    no("   ");
    no(`two https://esclub.gg/multimedia/serie/${id} links`);
    no(undefined);
    no(null);
    no(42);
  });

  it("exports the example used in messages", () => {
    expect(A.ACCEPTED_LINK_EXAMPLE).toBe("https://esclub.gg/multimedia/serie/<series id>");
  });
});

// ---- a stub client ----------------------------------------------------------

/** Serves the fixtures by request name, records every call. `over` replaces a reply by name. */
function makeClient(over = {}) {
  const calls = [];
  const replies = {
    "fetch-serie": (ctx) => (ctx.id_serie === ROUND_SERIE_ID ? ROUND_SERIE : GROUP_SERIE),
    "fetch-group": () => GROUP,
    "fetch-round": (ctx) => (ctx.id_round === BRACKET_ROUND.rounds[0].id_round ? BRACKET_ROUND : GROUP_ROUND),
    "fetch-event-stage": () => STAGE,
    "fetch-event-active": () => EVENT,
    ...over,
  };
  return {
    calls,
    names: () => calls.map((c) => c.name),
    async request(name, ctx) {
      calls.push({ name, ctx });
      const serve = replies[name];
      if (!serve) throw new Error(`stub: unexpected request ${name}`);
      const reply = typeof serve === "function" ? serve(ctx) : serve;
      if (reply instanceof Error) throw reply;
      return clone(reply);
    },
  };
}

const stageWith = (patch) => {
  const reply = clone(STAGE);
  patch(reply.events[0]);
  return reply;
};

// ---- validateAndLocate ------------------------------------------------------

describe("validateAndLocate", () => {
  it("under a group: serie, group, round, stage, season (5 requests)", async () => {
    const client = makeClient();
    const out = await A.validateAndLocate(client, { serieId: SERIE_ID });
    expect(client.names()).toEqual(["fetch-serie", "fetch-group", "fetch-round", "fetch-event-stage", "fetch-event-active"]);
    expect(client.calls[0].ctx).toEqual({ id_serie: SERIE_ID });
    expect(client.calls[1].ctx).toEqual({ id_group: GROUP_SERIE.series[0].id_parent });
    expect(client.calls[2].ctx).toEqual({ id_round: GROUP.groups[0].id_round });
    expect(client.calls[3].ctx).toEqual({ id_event_stage: GROUP_ROUND.rounds[0].id_event_stage });
    expect(client.calls[4].ctx).toEqual({ id_event_active: STAGE.events[0].id_event_active });
    expect(out).toEqual({
      season: { externalId: SEASON_ID, name: "NA Premier Season 1" },
      stage: { externalId: STAGE_ID, name: "Regular Season" },
    });
  });

  it("under a round: serie, round, stage, season (4 requests, no group)", async () => {
    const client = makeClient();
    await A.validateAndLocate(client, { serieId: ROUND_SERIE_ID });
    expect(client.names()).toEqual(["fetch-serie", "fetch-round", "fetch-event-stage", "fetch-event-active"]);
    expect(client.calls[1].ctx).toEqual({ id_round: ROUND_SERIE.series[0].id_parent });
  });

  it("an unknown parent type is a protocol change, after one request", async () => {
    const serie = clone(GROUP_SERIE);
    serie.series[0].type_parent = "Bracket";
    const client = makeClient({ "fetch-serie": serie });
    await expect(A.validateAndLocate(client, { serieId: SERIE_ID })).rejects.toBeInstanceOf(EsclubProtocolChanged);
    expect(client.calls).toHaveLength(1);
  });

  const rejects = async (stage, code, expectedRequests = 4) => {
    const client = makeClient({ "fetch-event-stage": stage });
    const err = await A.validateAndLocate(client, { serieId: ROUND_SERIE_ID }).catch((e) => e);
    expect(err).toBeInstanceOf(A.EsclubLeagueRejected);
    expect(err).toBeInstanceOf(EsclubError);
    expect(err.code).toBe(code);
    expect(client.calls).toHaveLength(expectedRequests - 1); // the season is never asked for
  };

  it("rejects a stage that is not League of Legends", () =>
    rejects(stageWith((s) => (s.id_game = "11ef0000-0000-0000-0000-000000000000")), "NOT_LOL"));
  it("rejects a stage with no default draft", () => rejects(stageWith((s) => (s.config.default_draft = null)), "NO_DRAFT"));
  it("rejects a blind default draft", () => rejects(stageWith((s) => (s.config.default_draft.is_blind = true)), "BLIND"));
  it("rejects a fearless type other than HardPick or None", () =>
    rejects(stageWith((s) => (s.config.default_draft.type_fearless = "SoftFearless")), "UNSUPPORTED_DRAFT"));

  it("accepts HardPick and None", async () => {
    for (const type of ["HardPick", "None"]) {
      const client = makeClient({ "fetch-event-stage": stageWith((s) => (s.config.default_draft.type_fearless = type)) });
      await expect(A.validateAndLocate(client, { serieId: ROUND_SERIE_ID })).resolves.toBeTruthy();
    }
  });

  it("LoL id is the one the sync engine uses", () => {
    expect(LOL).toBe(syncEngine.LOL_GAME_ID);
  });

  it("a missing field the walk needs is a protocol change", async () => {
    const cases = [
      ["fetch-event-stage", stageWith((s) => delete s.id_event_active)],
      ["fetch-event-stage", stageWith((s) => delete s.id_game)],
      ["fetch-event-stage", stageWith((s) => delete s.config.default_draft.type_fearless)],
      ["fetch-event-stage", stageWith((s) => delete s.config.default_draft.is_blind)],
    ];
    for (const [name, reply] of cases) {
      const client = makeClient({ [name]: reply });
      await expect(A.validateAndLocate(client, { serieId: ROUND_SERIE_ID })).rejects.toBeInstanceOf(EsclubProtocolChanged);
    }
  });

  it("a not-found fetch propagates as EsclubNotFound", async () => {
    const client = makeClient({ "fetch-event-active": { events: [] } });
    await expect(A.validateAndLocate(client, { serieId: SERIE_ID })).rejects.toBeInstanceOf(EsclubNotFound);
  });
});

// ---- addLeague --------------------------------------------------------------

/** In-memory models behind spies: what exists, what was written. */
function makeWorld({ series = null, tournament = null, stage = null, userRow = null } = {}) {
  const w = { tournaments: tournament ? [tournament] : [], stages: stage ? [stage] : [], series, userRow, writes: [], syncRows: [], target: null, order: [] };
  vi.spyOn(LeagueSeries, "findOne").mockImplementation(async () => w.series);
  vi.spyOn(Tournament, "findOne").mockImplementation(async ({ where }) => w.tournaments.find((t) => t.external_id === where.external_id) ?? null);
  vi.spyOn(Tournament, "create").mockImplementation(async (values) => {
    const row = { id: "tour-new", ...values };
    w.tournaments.push(row);
    w.writes.push(["tournament", values]);
    return row;
  });
  vi.spyOn(LeagueStage, "findOne").mockImplementation(async ({ where }) => w.stages.find((s) => s.external_id === where.external_id) ?? null);
  vi.spyOn(LeagueStage, "create").mockImplementation(async (values) => {
    const row = { id: "stage-new", ...values };
    w.stages.push(row);
    w.writes.push(["stage", values]);
    return row;
  });
  vi.spyOn(UserTournament, "update").mockImplementation(async (values, { where }) => {
    w.writes.push(["userUpdate", values, where]);
    return [w.userRow ? 1 : 0];
  });
  vi.spyOn(UserTournament, "create").mockImplementation(async (values) => {
    w.userRow = values;
    w.writes.push(["userCreate", values]);
    return values;
  });
  vi.spyOn(sequelize, "query").mockImplementation(async (sql, o) => {
    w.target = o.replacements;
    w.writes.push(["syncTarget", o.replacements]);
    return [[], 1];
  });
  vi.spyOn(sequelize, "transaction").mockImplementation(async (cb) => cb({ id: "tx" }));
  vi.spyOn(mirrorStore, "touchSynced").mockImplementation(async (st, t) => {
    w.writes.push(["touched", st.id, t.id]);
  });
  return w;
}

let begin;
let finish;
let count;
let syncStage;
const syncRow = { id: "sync-1", kind: "add", tournament_id: null };

beforeEach(() => {
  begin = vi.spyOn(syncState, "beginSync").mockResolvedValue({ sync: syncRow });
  finish = vi.spyOn(syncState, "finishSync").mockResolvedValue(true);
  count = vi.spyOn(syncState, "countRequest").mockResolvedValue({ used: 1, syncCount: 1 });
  syncStage = vi.spyOn(syncEngine, "syncStage").mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A fake session: hands the stub client to fn and counts each request through opts.onRequest. */
function makeSession(client) {
  return vi.fn(async (fn, opts) => {
    let n = 0;
    const counted = {
      ...client,
      request: async (name, ctx) => {
        n += 1;
        await opts.onRequest(name, n);
        return client.request(name, ctx);
      },
    };
    return fn(counted);
  });
}

const run = (over = {}, client = makeClient()) => {
  const session = makeSession(client);
  return {
    client,
    session,
    done: A.addLeague({ url: URL_OK, userId: "u1", env: ON, now: () => T0, session, background: false, ...over }),
  };
};

describe("addLeague: refusals before any request", () => {
  it("an unaccepted link is invalid URL: no request, no sync row", async () => {
    makeWorld();
    const { client, session, done } = run({ url: "https://esclub.gg.evil.com/multimedia/serie/" + SERIE_ID });
    expect(await done).toEqual({ invalid: "URL" });
    expect(client.calls).toHaveLength(0);
    expect(session).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(LeagueSeries.findOne).not.toHaveBeenCalled();
  });

  it("a bad region is invalid REGION: no request, no sync row", async () => {
    makeWorld();
    const { client, done } = run({ region: "xx9" });
    expect(await done).toEqual({ invalid: "REGION" });
    expect(client.calls).toHaveLength(0);
    expect(begin).not.toHaveBeenCalled();
  });

  it("the region defaults to na1", async () => {
    const w = makeWorld();
    await run().done;
    expect(w.writes.find(([k]) => k === "tournament")[1].region).toBe("na1");
  });

  it("the kill switch off answers off and sends nothing", async () => {
    makeWorld();
    begin.mockResolvedValue({ off: "disabled" });
    const { client, session, done } = run({ env: {} });
    expect(await done).toEqual({ off: "disabled" });
    expect(client.calls).toHaveLength(0);
    expect(session).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ kind: "add", tournamentId: null, userId: "u1", via: "api", env: {} }));
  });

  it.each([["busy", { busy: { retryAfter: 60 } }], ["cooldown", { cooldown: { availableAt: T0 } }], ["limited", { limited: { retryAfter: 5 } }], ["joined", { joined: syncRow }], ["budget", { off: "budget" }]])(
    "a %s refusal is returned as is and nothing is sent or written",
    async (_n, answer) => {
      const w = makeWorld();
      begin.mockResolvedValue(answer);
      const { client, done } = run();
      expect(await done).toEqual(answer);
      expect(client.calls).toHaveLength(0);
      expect(w.writes).toHaveLength(0);
    },
  );
});

describe("addLeague: a series already in the mirror", () => {
  const known = { id: "ser-1", tournament_id: "tour-1", stage_id: "stage-1" };

  it("creates the user row, sends nothing, writes no sync row and counts no add", async () => {
    const w = makeWorld({ series: known });
    const { client, session, done } = run();
    expect(await done).toEqual({ known: { tournamentId: "tour-1", stageId: "stage-1" } });
    expect(client.calls).toHaveLength(0);
    expect(session).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(UserTournament.create).toHaveBeenCalledWith({ user_id: "u1", tournament_id: "tour-1", archived_at: null }, expect.anything());
    expect(w.writes.map(([k]) => k)).toEqual(["userUpdate", "userCreate"]);
  });

  it("un-archives an archived user row instead of creating one", async () => {
    const w = makeWorld({ series: known, userRow: { archived_at: T0 } });
    const out = await run().done;
    expect(out).toEqual({ known: { tournamentId: "tour-1", stageId: "stage-1" } });
    expect(UserTournament.update).toHaveBeenCalledWith({ archived_at: null }, { where: { user_id: "u1", tournament_id: "tour-1" }, transaction: expect.anything() });
    expect(UserTournament.create).not.toHaveBeenCalled();
    expect(w.writes.map(([k]) => k)).toEqual(["userUpdate"]);
  });

  it("works with the kill switch off (no traffic is needed)", async () => {
    makeWorld({ series: known });
    const out = await run({ env: {} }).done;
    expect(out).toEqual({ known: { tournamentId: "tour-1", stageId: "stage-1" } });
  });

  it("looks the series up by the lower-cased external id", async () => {
    makeWorld({ series: known });
    await run({ url: `https://esclub.gg/multimedia/serie/${SERIE_ID.toUpperCase()}` }).done;
    expect(LeagueSeries.findOne.mock.calls[0][0].where).toEqual({ external_id: SERIE_ID });
  });
});

describe("addLeague: a new season and stage", () => {
  it("begins an add sync, creates tournament, stage and user row in one transaction, then syncs the stage", async () => {
    const w = makeWorld();
    const { client, done } = run({ region: "euw1" });
    const out = await done;

    expect(begin).toHaveBeenCalledWith({ kind: "add", tournamentId: null, userId: "u1", via: "api", now: T0, env: ON });
    expect(client.names()).toEqual(["fetch-serie", "fetch-group", "fetch-round", "fetch-event-stage", "fetch-event-active"]);
    expect(count).toHaveBeenCalledTimes(5);
    expect(sequelize.transaction).toHaveBeenCalledTimes(1);

    expect(w.writes.map(([k]) => k)).toEqual(["tournament", "stage", "userUpdate", "userCreate", "syncTarget", "touched"]);
    expect(w.writes[0][1]).toMatchObject({ name: "NA Premier Season 1", source: "esclub", external_id: SEASON_ID, region: "euw1", created_by: "u1" });
    expect(w.writes[1][1]).toMatchObject({ tournament_id: "tour-new", external_id: STAGE_ID, name: "Regular Season", added_by: "u1" });
    expect(w.writes[3][1]).toMatchObject({ user_id: "u1", tournament_id: "tour-new", archived_at: null });
    expect(w.target).toMatchObject({ syncId: "sync-1", tournamentId: "tour-new", stageId: "stage-new" });

    expect(syncStage).toHaveBeenCalledTimes(1);
    const [, args] = syncStage.mock.calls[0];
    expect(args.tournament).toMatchObject({ id: "tour-new", external_id: SEASON_ID, region: "euw1", source: "esclub" });
    expect(args.stage).toMatchObject({ id: "stage-new", external_id: STAGE_ID });
    expect(w.writes.at(-1)).toEqual(["touched", "stage-new", "tour-new"]);

    expect(out.sync).toBe(syncRow);
    expect(out.result.status).toBe("succeeded");
    expect(out.result.summary).toMatchObject({ newStage: true, newSeason: true });
    expect(finish).toHaveBeenCalledWith("sync-1", expect.objectContaining({ status: "succeeded", error: null }));
  });

  it("an existing season of the same esclub id is reused: the region given is ignored", async () => {
    const w = makeWorld({ tournament: { id: "tour-old", external_id: SEASON_ID, region: "kr", name: "x" } });
    const out = await run({ region: "euw1" }).done;
    expect(w.writes.find(([k]) => k === "tournament")).toBeUndefined();
    expect(w.writes.find(([k]) => k === "stage")[1].tournament_id).toBe("tour-old");
    expect(out.result.summary).toMatchObject({ newStage: true, newSeason: false });
    expect(syncStage.mock.calls[0][1].tournament).toMatchObject({ id: "tour-old", region: "kr" });
  });

  it("an un-archived user row is revived rather than duplicated", async () => {
    const w = makeWorld({ userRow: { archived_at: T0 } });
    await run().done;
    expect(UserTournament.create).not.toHaveBeenCalled();
    expect(w.writes.some(([k]) => k === "userUpdate")).toBe(true);
  });
});

describe("addLeague: a stage the mirror already has, reached through an unseen serie link", () => {
  it("makes the user row and the add row but starts no backfill; the walk's requests are all counted", async () => {
    // Documented cost: the walk (4 or 5 requests; 6 for a group link with a season
    // that was unknown) is the price of recognising a known stage, and the sync row
    // is an add, so it counts toward the 3-a-day add limit.
    const w = makeWorld({
      tournament: { id: "tour-1", external_id: SEASON_ID, region: "na1", name: "NA Premier Season 1" },
      stage: { id: "stage-1", external_id: STAGE_ID, tournament_id: "tour-1", name: "Regular Season" },
    });
    const { client, done } = run();
    const out = await done;
    expect(client.calls).toHaveLength(5);
    expect(count).toHaveBeenCalledTimes(5);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(syncStage).not.toHaveBeenCalled();
    expect(mirrorStore.touchSynced).not.toHaveBeenCalled();
    expect(w.writes.map(([k]) => k)).toEqual(["userUpdate", "userCreate", "syncTarget"]);
    expect(w.target).toMatchObject({ tournamentId: "tour-1", stageId: "stage-1" });
    expect(out.result.status).toBe("succeeded");
    expect(out.result.summary).toMatchObject({ newStage: false, newSeason: false });
  });

});

describe("addLeague: rejections write nothing", () => {
  it.each([
    ["NOT_LOL", (s) => (s.id_game = "11ef0000-0000-0000-0000-000000000000")],
    ["NO_DRAFT", (s) => (s.config.default_draft = null)],
    ["BLIND", (s) => (s.config.default_draft.is_blind = true)],
    ["UNSUPPORTED_DRAFT", (s) => (s.config.default_draft.type_fearless = "SoftFearless")],
  ])("%s ends the sync as failed with its class and writes no row", async (_code, patch) => {
    const w = makeWorld();
    const { done } = run({}, makeClient({ "fetch-event-stage": stageWith(patch) }));
    const out = await done;
    expect(out.result.status).toBe("failed");
    expect(out.result.error).toBeInstanceOf(A.EsclubLeagueRejected);
    expect(out.result.error.code).toBe(_code);
    expect(finish).toHaveBeenCalledWith("sync-1", expect.objectContaining({ status: "failed", error: out.result.error }));
    expect(w.writes).toHaveLength(0);
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(syncStage).not.toHaveBeenCalled();
  });

  it("a protocol change ends the sync as failed with nothing written", async () => {
    const w = makeWorld();
    const serie = clone(GROUP_SERIE);
    serie.series[0].type_parent = "Bracket";
    const out = await run({}, makeClient({ "fetch-serie": serie })).done;
    expect(out.result.error).toBeInstanceOf(EsclubProtocolChanged);
    expect(w.writes).toHaveLength(0);
  });

  it("a failed write inside the transaction fails the sync (no partial sync of the stage)", async () => {
    makeWorld();
    vi.spyOn(Tournament, "create").mockRejectedValue(new Error("db down"));
    const out = await run().done;
    expect(out.result.status).toBe("failed");
    expect(syncStage).not.toHaveBeenCalled();
  });
});

describe("addLeague: background mode", () => {
  it("returns { sync } at once and finishes the work afterwards", async () => {
    makeWorld();
    let release;
    const gate = new Promise((r) => (release = r));
    const client = makeClient({ "fetch-event-active": () => EVENT });
    const slow = vi.fn(async (fn, opts) => {
      await gate;
      return makeSession(client)(fn, opts);
    });
    const out = await A.addLeague({ url: URL_OK, userId: "u1", env: ON, now: () => T0, session: slow });
    expect(out).toEqual({ sync: syncRow });
    expect(finish).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(syncStage).toHaveBeenCalledTimes(1);
  });

  it("a failure in the background is logged, never unhandled", async () => {
    makeWorld();
    finish.mockRejectedValue(new Error("cannot record"));
    const out = await A.addLeague({ url: URL_OK, userId: "u1", env: ON, now: () => T0, session: makeSession(makeClient()) });
    expect(out).toEqual({ sync: syncRow });
    await vi.waitFor(() => expect(finish).toHaveBeenCalled());
  });
});

// ---- the SQL of the queries this module adds -------------------------------

describe("rendered SQL", () => {
  const rendered = [];
  beforeEach(() => {
    rendered.length = 0;
    vi.spyOn(sequelize, "query").mockImplementation(async (sql, o = {}) => {
      rendered.push(typeof sql === "string" ? injectReplacements(sql, sequelize.dialect, o.replacements ?? {}) : JSON.stringify(sql));
      return [];
    });
  });

  const normalized = () => rendered.map((s) => String(s).replace(/\s+/g, " ").trim());

  it("known-series lookup, find season, find stage", async () => {
    await LeagueSeries.findOne({ where: { external_id: SERIE_ID }, attributes: ["tournament_id", "stage_id"], raw: true });
    await Tournament.findOne({ where: { source: "esclub", external_id: SEASON_ID }, raw: true });
    await LeagueStage.findOne({ where: { external_id: STAGE_ID }, raw: true });
    const [a, b, c] = normalized();
    expect(a).toBe(`SELECT "tournament_id", "stage_id" FROM "LeagueSeries" AS "LeagueSeries" WHERE "LeagueSeries"."external_id" = '${SERIE_ID}' LIMIT 1;`);
    expect(b).toMatch(/FROM "Tournaments" AS "Tournament" WHERE "Tournament"\."source" = 'esclub' AND "Tournament"\."external_id" = '[0-9a-f-]+' LIMIT 1;$/);
    expect(c).toMatch(/FROM "LeagueStages" AS "LeagueStage" WHERE "LeagueStage"\."external_id" = '[0-9a-f-]+' LIMIT 1;$/);
  });

  it("un-archive update", async () => {
    await UserTournament.update({ archived_at: null }, { where: { user_id: "11111111-1111-4111-8111-111111111111", tournament_id: "22222222-2222-4222-8222-222222222222" } });
    const { query, bind } = JSON.parse(rendered[0]);
    expect(query).toBe('UPDATE "UserTournaments" SET "archived_at"=$1,"updatedAt"=$2 WHERE "user_id" = $3 AND "tournament_id" = $4');
    expect(bind[0]).toBeNull();
    expect(bind.slice(2)).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("the sync row's target", async () => {
    await A.setSyncTarget("sync-1", "tour-1", "stage-1");
    expect(normalized()[0]).toBe(
      `UPDATE "EsclubSyncs" SET tournament_id = 'tour-1', stage_id = 'stage-1', "updatedAt" = NOW() WHERE id = 'sync-1' AND status = 'running'`,
    );
  });
});
