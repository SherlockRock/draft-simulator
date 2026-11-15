import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { EsclubClient } = require("../../../services/esclub/client");
const { EsclubProtocolChanged, EsclubNotFound } = require("../../../services/esclub/errors");
const R = require("../../../services/esclub/requests");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const SEP = "\u0004";
const flush = () => new Promise((r) => setImmediate(r));

/** A fake socket answering each request from `answer(request, context)`; nothing touches the network. */
async function session(answer) {
  const instances = [];
  class FakeWebSocket {
    constructor() {
      this.sent = [];
      instances.push(this);
    }
    send(text) {
      const frame = JSON.parse(text.slice(0, -1));
      this.sent.push(frame);
      const { request, context } = frame.payload;
      const reply = request === "fetch-client" ? { ok: true } : answer(request, context);
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({ payload_id: frame.payload_id, payload: { context: reply }, mode: { Answer: "" } }) + SEP,
      }));
    }
    close() {}
  }
  const client = new EsclubClient({
    WebSocketImpl: FakeWebSocket, env: { ESCLUB_SYNC_ENABLED: "true" }, minGapMs: 0, sleep: async () => {},
  });
  const p = client.connect();
  await flush();
  instances[0].onopen();
  await p;
  return { client, sent: () => instances[0].sent.slice(1).map((f) => f.payload) };
}

/** Runs `call(client)` against a socket replaying `fixture`; returns the result and what was sent. */
async function replay(fixture, call) {
  const f = fx(fixture);
  const { client, sent } = await session(() => f.reply);
  const result = await call(client);
  return { f, result, sent: sent() };
}

const cases = [
  ["event-active.json", "fetchEventActive", (c, f) => R.fetchEventActive(c, f.context)],
  ["event-stages.json", "fetchEventStages", (c, f) => R.fetchEventStages(c, f.context)],
  ["event-stage.json", "fetchEventStage", (c, f) => R.fetchEventStage(c, f.context)],
  ["rounds.json", "fetchRounds", (c, f) => R.fetchRounds(c, f.context)],
  ["bracket-bo3/round.json", "fetchRound", (c, f) => R.fetchRound(c, f.context)],
  ["groups-of-round.json", "fetchGroups", (c, f) => R.fetchGroups(c, f.context)],
  ["series-of-group.json", "fetchSeriesInParent", (c, f) => R.fetchSeriesInParent(c, { id_parent: f.context.id_parent })],
  ["bracket-bo3/series-of-round.json", "fetchSeriesInParent", (c, f) => R.fetchSeriesInParent(c, { id_parent: f.context.id_parent })],
  ["group-bo3/serie.json", "fetchSerie", (c, f) => R.fetchSerie(c, f.context)],
  ["bracket-bo3/serie.json", "fetchSerie", (c, f) => R.fetchSerie(c, f.context)],
  ["group-bo3/matches.json", "fetchMatches", (c, f) => R.fetchMatches(c, { id_serie: f.context.id_serie })],
  ["bracket-bo3/matches.json", "fetchMatches", (c, f) => R.fetchMatches(c, { id_serie: f.context.id_serie })],
  ["group-bo3/draft-0.json", "fetchDraft", (c, f) => R.fetchDraft(c, f.context)],
  ["bracket-bo3/draft-1.json", "fetchDraft", (c, f) => R.fetchDraft(c, f.context)],
  ["group-bo3/choices-0.json", "fetchDraftChoices", (c, f) => R.fetchDraftChoices(c, f.context)],
  ["group-bo3/choices-1.json", "fetchDraftChoices", (c, f) => R.fetchDraftChoices(c, f.context)],
  ["bracket-bo3/choices-0.json", "fetchDraftChoices", (c, f) => R.fetchDraftChoices(c, f.context)],
  ["bracket-bo3/choices-1.json", "fetchDraftChoices", (c, f) => R.fetchDraftChoices(c, f.context)],
  ["group-bo3/scores-0.json", "fetchScores", (c, f) => R.fetchScores(c, f.context)],
  ["bracket-bo3/scores-1.json", "fetchScores", (c, f) => R.fetchScores(c, f.context)],
  ["team-roster-schedule.json", "fetchTeamRosterSchedule", (c, f) => R.fetchTeamRosterSchedule(c, { id_team_roster: f.context.id_team_roster })],
  ["team-rosters.json", "fetchTeamRosters", (c, f) => R.fetchTeamRosters(c, f.context)],
  ["game-resources.json", "fetchGameResources", (c, f) => R.fetchGameResources(c, f.context)],
];

describe("each function sends the recorded request and context, and parses the recorded reply", () => {
  for (const [file, name, call] of cases) {
    it(`${name} on ${file}`, async () => {
      const { f, sent, result } = await replay(file, (c) => call(c, fx(file)));
      expect(sent).toHaveLength(1);
      expect(sent[0].request).toBe(f.request);
      expect(sent[0].context).toEqual(f.context);
      const expected = f.reply[Object.keys(f.reply)[0]];
      if (Array.isArray(result?.items)) expect(result.items).toEqual(expected);
      else expect(result).toEqual(expected[0]);
    });
  }
});

describe("shapes", () => {
  it("a list returns every item and a cursor derived from the last one", async () => {
    const { result } = await replay("series-of-group.json", (c) =>
      R.fetchSeriesInParent(c, { id_parent: fx("series-of-group.json").context.id_parent }));
    expect(result.items).toHaveLength(45);
    expect(result.cursor).toEqual({ number: result.items[44].number });
  });

  it("an empty list has a null cursor", async () => {
    const { client } = await session(() => ({ series: [] }));
    expect(await R.fetchSeriesInParent(client, { id_parent: "x" })).toEqual({ items: [], cursor: null });
  });

  it("a by-id fetch returns the item itself", async () => {
    const { result } = await replay("group-bo3/serie.json", (c) => R.fetchSerie(c, fx("group-bo3/serie.json").context));
    expect(result.id_serie).toBe("11f1c28a-af6b-071b-93aa-058d0cf4fd47");
    expect(result.id_serie_winner).toBeNull();
  });

  it("fetchMatches on the group Bo3 returns game number 0 first", async () => {
    const { result } = await replay("group-bo3/matches.json", (c) =>
      R.fetchMatches(c, { id_serie: fx("group-bo3/matches.json").context.id_serie }));
    expect(result.items.map((m) => m.number)).toEqual([0, 1]);
    expect(result.cursor).toEqual({ number: 1 });
  });

  it("accepts null Riot IDs and key_encryption (bracket Bo3)", async () => {
    const { result } = await replay("bracket-bo3/matches.json", (c) =>
      R.fetchMatches(c, { id_serie: fx("bracket-bo3/matches.json").context.id_serie }));
    const p = result.items[0].config.integrations[0].LeagueOfLegends.participants[0];
    expect(p.name_riot_game).toBeNull();
    expect(p.tag_riot).toBeNull();
  });

  it("the schedule holds series under both a Group and a Round", async () => {
    const f = fx("team-roster-schedule.json");
    const { result } = await replay("team-roster-schedule.json", (c) =>
      R.fetchTeamRosterSchedule(c, { id_team_roster: f.context.id_team_roster }));
    expect(result.items).toHaveLength(21);
    const types = new Set(result.items.map((s) => s.type_parent));
    expect(types.has("Group")).toBe(true);
    expect(types.has("Round")).toBe(true);
  });

  it("sends the exact table contexts, null cursors included", async () => {
    const { client, sent } = await session(() => ({ series: [], teams: [], scores: [], resources: [] }));
    await R.fetchScores(client, { id_match: "m" });
    await R.fetchTeamRosters(client, { id_event_stage: "s" });
    expect(sent()).toEqual([
      expect.objectContaining({ request: "fetch-scores-by-match", context: { id_match: "m", omit_teams: true } }),
      expect.objectContaining({
        request: "fetch-team-rosters-by-event-stage-next",
        context: { id_event_stage: "s", id_team_roster: null, before: false },
      }),
    ]);
  });
});

describe("protocol checks", () => {
  it("a missing field names the request and the field path", async () => {
    const f = fx("group-bo3/serie.json");
    const bad = structuredClone(f.reply);
    delete bad.series[0].best_of;
    const { client } = await session(() => bad);
    const err = await R.fetchSerie(client, f.context).catch((e) => e);
    expect(err).toBeInstanceOf(EsclubProtocolChanged);
    expect(err.message).toContain("fetch-serie");
    expect(err.message).toContain("series[0].best_of");
  });

  it("a wrong type inside a participant is caught with its path", async () => {
    const f = fx("group-bo3/matches.json");
    const bad = structuredClone(f.reply);
    bad.matches[1].config.integrations[0].LeagueOfLegends.participants[3].id_champion = "126";
    const { client } = await session(() => bad);
    const err = await R.fetchMatches(client, { id_serie: f.context.id_serie }).catch((e) => e);
    expect(err).toBeInstanceOf(EsclubProtocolChanged);
    expect(err.message).toContain("fetch-matches-by-number-next");
    expect(err.message).toContain("matches[1].config.integrations[0].LeagueOfLegends.participants[3].id_champion");
  });

  it("a null lane_team is accepted and reaches the normaliser as lane: null", async () => {
    const f = fx("group-bo3/matches.json");
    const reply = structuredClone(f.reply);
    const m = reply.matches.find((x) => x.number === 1);
    m.config.integrations[0].LeagueOfLegends.participants[0].lane_team = null;
    const { client } = await session(() => reply);
    const { items } = await R.fetchMatches(client, { id_serie: f.context.id_serie });
    const N = require("../../../services/esclub/normalize");
    const rosters = fx("team-rosters.json").reply.teams.map(N.normalizeTeamRoster);
    const drafts = {};
    const choices = {};
    for (const n of [0, 1]) {
      const d = fx(`group-bo3/draft-${n}.json`).reply.drafts[0];
      drafts[d.id_match] = d;
      choices[d.id_match] = fx(`group-bo3/choices-${n}.json`).reply.choices;
    }
    const ids = [...new Set(Object.values(choices).flat().filter((c) => c.is_final).map((c) => c.id_team_roster_source))];
    const out = N.normalizeSeries({
      serie: fx("group-bo3/serie.json").reply.series[0], seasonId: "s", stageId: "t",
      teams: ids.map((id) => rosters.find((r) => r.externalId === id)),
      matches: items, drafts, choices, resources: fx("game-resources.json").reply.resources,
    });
    const lanes = Object.values(out.series.games[1].participants).map((p) => p.lane);
    expect(lanes.filter((l) => l === null)).toHaveLength(1);
  });

  it("a reply without the array key is EsclubProtocolChanged", async () => {
    const { client } = await session(() => ({ other: [] }));
    await expect(R.fetchRounds(client, { id_event_stage: "s" })).rejects.toBeInstanceOf(EsclubProtocolChanged);
  });

  it("a non-null where the fixtures have null still passes, a wrong type there fails", async () => {
    const f = fx("group-bo3/serie.json");
    const bad = structuredClone(f.reply);
    bad.series[0].time_start_forced = "soon";
    const { client } = await session(() => bad);
    await expect(R.fetchSerie(client, f.context)).rejects.toThrow(/time_start_forced/);
  });

  it("extra fields are not rejected", async () => {
    const f = fx("group-bo3/serie.json");
    const ok = structuredClone(f.reply);
    ok.series[0].brand_new_field = { a: 1 };
    const { client } = await session(() => ok);
    expect((await R.fetchSerie(client, f.context)).brand_new_field).toEqual({ a: 1 });
  });

  it("fetchSerie with [] is EsclubNotFound; so is every by-id fetch", async () => {
    const { client } = await session(() => ({ series: [], events: [], rounds: [], drafts: [] }));
    for (const call of [
      () => R.fetchSerie(client, { id_serie: "x" }),
      () => R.fetchEventActive(client, { id_event_active: "x" }),
      () => R.fetchEventStage(client, { id_event_stage: "x" }),
      () => R.fetchRound(client, { id_round: "x" }),
      () => R.fetchDraft(client, { id_match: "x" }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(EsclubNotFound);
    }
  });
});

describe("list cursors", () => {
  const last = (f, key) => f.reply[key][f.reply[key].length - 1];
  it.each([
    ["event-stages.json", (c, f) => R.fetchEventStages(c, f.context), (f) => ({ id_event_stage: last(f, "events").id_event_stage })],
    ["rounds.json", (c, f) => R.fetchRounds(c, f.context), (f) => ({ number: last(f, "rounds").number })],
    ["groups-of-round.json", (c, f) => R.fetchGroups(c, f.context), (f) => ({ number: last(f, "groups").number })],
    ["series-of-group.json", (c, f) => R.fetchSeriesInParent(c, { id_parent: f.context.id_parent }), (f) => ({ number: last(f, "series").number })],
    ["group-bo3/matches.json", (c, f) => R.fetchMatches(c, { id_serie: f.context.id_serie }), (f) => ({ number: last(f, "matches").number })],
    ["team-rosters.json", (c, f) => R.fetchTeamRosters(c, f.context), (f) => ({ id_team_roster: last(f, "teams").id_team_roster })],
    ["team-roster-schedule.json", (c, f) => R.fetchTeamRosterSchedule(c, { id_team_roster: f.context.id_team_roster }), () => null],
    ["group-bo3/choices-0.json", (c, f) => R.fetchDraftChoices(c, f.context), () => null],
  ])("%s gives the cursor the next request would send (or null)", async (fixture, call, expected) => {
    const { f, result } = await replay(fixture, (c) => call(c, fx(fixture)));
    expect(result.cursor).toEqual(expected(f));
  });
});

describe("fetchGroup", () => {
  it("sends fetch-group with the group id and parses the recorded reply", async () => {
    const f = fx("group.json");
    const { result, sent } = await replay("group.json", (c) => R.fetchGroup(c, { id_group: f.context.id_group }));
    expect(sent).toHaveLength(1);
    expect(sent[0].request).toBe("fetch-group");
    expect(sent[0].context).toEqual({ id_group: f.context.id_group });
    expect(result).toEqual(f.reply.groups[0]);
    expect(typeof result.id_round).toBe("string");
  });

  it("an empty reply is EsclubNotFound", async () => {
    const { client } = await session(() => ({ groups: [] }));
    await expect(R.fetchGroup(client, { id_group: "g" })).rejects.toBeInstanceOf(EsclubNotFound);
  });

  it("a group without id_round is EsclubProtocolChanged", async () => {
    const { id_round, ...rest } = fx("group.json").reply.groups[0];
    const { client } = await session(() => ({ groups: [rest] }));
    await expect(R.fetchGroup(client, { id_group: "g" })).rejects.toBeInstanceOf(EsclubProtocolChanged);
  });
});

describe("fetchSerieTeamOrder", () => {
  const member = (id_parent, extra = {}) => ({
    id_parent, type_parent: "TeamRoster", id_user: "fake-user-99", type_member: "Owner", time_start: 1, time_end: null, ...extra,
  });
  const run = async (members) => {
    const { client, sent } = await session(() => ({ members }));
    return { call: () => R.fetchSerieTeamOrder(client, { id_serie: "s1" }), sent };
  };

  it("sends fetch-members-by-serie with exactly {id_serie}", async () => {
    const { call, sent } = await run([]);
    await call();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].request).toBe("fetch-members-by-serie");
    expect(sent()[0].context).toEqual({ id_serie: "s1" });
  });

  it("the group Bo3 gives its two rosters, the choice-0 roster first", async () => {
    const f = fx("group-bo3/members.json");
    const choice0 = fx("group-bo3/choices-0.json").reply.choices.find((c) => c.id_team_roster_source).id_team_roster_source;
    const { result, sent } = await replay("group-bo3/members.json", (c) =>
      R.fetchSerieTeamOrder(c, { id_serie: f.context.id_serie }));
    expect(sent[0].context).toEqual({ id_serie: f.context.id_serie });
    expect(result.rosterIds).toHaveLength(2);
    expect(result.rosterIds[0]).toBe(choice0);
    expect(new Set(result.rosterIds).size).toBe(2);
  });

  it("returns nothing but rosterIds: no member records, no user ids", async () => {
    const { result } = await replay("group-bo3/members.json", (c) =>
      R.fetchSerieTeamOrder(c, { id_serie: fx("group-bo3/members.json").context.id_serie }));
    expect(Object.keys(result)).toEqual(["rosterIds"]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("fake-user");
    expect(text).not.toContain("id_user");
    expect(text).not.toContain("type_member");
  });

  it("orders by first appearance, ignoring repeats", async () => {
    const { call } = await run([member("b"), member("a"), member("b"), member("a")]);
    expect(await call()).toEqual({ rosterIds: ["b", "a"] });
  });

  it("three rosters is EsclubProtocolChanged", async () => {
    const { call } = await run([member("a"), member("b"), member("c")]);
    await expect(call()).rejects.toBeInstanceOf(EsclubProtocolChanged);
  });

  it("one roster gives one id, an empty list gives none", async () => {
    expect((await (await run([member("a"), member("a")])).call()).rosterIds).toEqual(["a"]);
    expect((await (await run([])).call()).rosterIds).toEqual([]);
  });

  it("a member without id_parent is EsclubProtocolChanged", async () => {
    const m = member("a");
    delete m.id_parent;
    const { call } = await run([m]);
    await expect(call()).rejects.toBeInstanceOf(EsclubProtocolChanged);
  });

  it("a type_parent other than TeamRoster is EsclubProtocolChanged", async () => {
    const { call } = await run([member("a", { type_parent: "Organisation" })]);
    await expect(call()).rejects.toBeInstanceOf(EsclubProtocolChanged);
  });

  it("a reply without a members array is EsclubProtocolChanged", async () => {
    const { client } = await session(() => ({}));
    await expect(R.fetchSerieTeamOrder(client, { id_serie: "s" })).rejects.toBeInstanceOf(EsclubProtocolChanged);
  });
});


it("protocol shape errors reveal only paths and types, never field values", async () => {
  const secret = "FAKE_PRIVATE_PLAYER#TAG";
  await expect(R.fetchSerieTeamOrder({ request: async () => ({ members: [{ id_parent: secret, type_parent: secret }] }) }, { id_serie: "fake-series" }))
    .rejects.toThrow('members[0].type_parent is not "TeamRoster"');
  try {
    await R.fetchSerieTeamOrder({ request: async () => ({ members: [{ id_parent: { name_riot_game: secret }, type_parent: "TeamRoster" }] }) }, { id_serie: "fake-series" });
  } catch (error) {
    expect(error.message).toBe("esclub fetch-members-by-serie: members[0].id_parent is not a string (got object)");
    expect(error.message).not.toContain(secret);
  }
});
