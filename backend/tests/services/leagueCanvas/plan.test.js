import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const N = require("../../../services/esclub/normalize");
const { gameIsComplete } = require("../../../services/esclub/derive");
const { seriesCardOrigin, nextSeriesCardOrigin, SERIES_GAME_STEP } = require("../../../utils/seriesCardLayout");
const { planSend, planRefresh, bulkOrder, columnPositions } = require("../../../services/leagueCanvas/plan");

// ---------------------------------------------------------------------------
// Fixtures: the S2 normaliser's output for the two recorded Bo3s, turned into
// the LeagueSeries / LeagueGame row shapes the mirror stores (the same mapping
// as mirrorStore's seriesAttributes / gameAttributes).
// ---------------------------------------------------------------------------

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")).reply;
const clone = (o) => JSON.parse(JSON.stringify(o));

const rosters = Object.fromEntries(fx("team-rosters.json").teams.map((t) => [t.id_team_roster, N.normalizeTeamRoster(t)]));
const resources = fx("game-resources.json").resources;

function normalized(dir) {
  const serie = fx(`${dir}/serie.json`).series[0];
  const matches = fx(`${dir}/matches.json`).matches;
  const drafts = {};
  const choices = {};
  for (const n of [0, 1]) {
    const m = matches.find((x) => x.number === n);
    drafts[m.id_match] = fx(`${dir}/draft-${n}.json`).drafts[0];
    choices[m.id_match] = fx(`${dir}/choices-${n}.json`).choices;
  }
  const ids = [...new Set(Object.values(choices).flat().filter((c) => c.is_final).map((c) => c.id_team_roster_source))];
  const order = Object.keys(rosters);
  const teams = ids.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((id) => rosters[id]);
  return N.normalizeSeries({ serie, seasonId: "s", stageId: "st", teams, matches, drafts, choices, resources }).series;
}

const TEAM_IDS = {
  "Contingent Esports": "aaaaaaaa-0000-4000-8000-000000000001",
  "Blue Otter": "aaaaaaaa-0000-4000-8000-000000000002",
  "Vancouver Impact": "aaaaaaaa-0000-4000-8000-000000000003",
};

function seriesRow(s, id) {
  const [t1, t2] = s.teams;
  return {
    id,
    tournament_id: "tttttttt-0000-4000-8000-000000000001",
    external_id: s.externalId,
    number: 1,
    best_of: s.bestOf,
    draft_type: s.draftType,
    starts_at: new Date(s.startsAt),
    status: s.status,
    complete: true,
    team1_id: TEAM_IDS[t1.name],
    team2_id: TEAM_IDS[t2.name],
    Team1: { id: TEAM_IDS[t1.name], name: t1.name },
    Team2: { id: TEAM_IDS[t2.name], name: t2.name },
  };
}

function gameRows(s) {
  return s.games.map((g) => ({
    number: g.number,
    picks: g.picks,
    first_pick: g.firstPick,
    blue_side_team: g.blueSideTeam,
    winner: g.winner,
    complete: gameIsComplete(g),
    played_at: g.playedAt ? new Date(g.playedAt) : null,
    participants: g.participants,
  }));
}

const GROUP = normalized("group-bo3");
const BRACKET = normalized("bracket-bo3");
const groupSeries = () => seriesRow(GROUP, "ssssssss-0000-4000-8000-000000000001");
const groupGames = () => gameRows(GROUP);
const bracketSeries = () => seriesRow(BRACKET, "ssssssss-0000-4000-8000-000000000002");
const bracketGames = () => gameRows(BRACKET);

const SENDER = "uuuuuuuu-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-14T12:00:00.000Z");

function syntheticPicks(tag) {
  return Array.from({ length: 20 }, (_, i) => `${tag}${i}`);
}

function syntheticGame(number, over = {}) {
  return {
    number,
    picks: syntheticPicks(`G${number}C`),
    first_pick: "blue",
    blue_side_team: 1,
    winner: "blue",
    complete: true,
    played_at: new Date(`2026-11-1${number}T10:00:00.000Z`),
    participants: {
      [`G${number}C0`]: { lane: "top", playerKey: `secret-key-${number}`, gameName: `Player0${number}`, tagLine: `T0${number}`, side: "blue" },
    },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Privacy walk
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS = new Set(["participants", "playerKey", "gameName", "tagLine", "id_oauth_riot"]);

function walk(value, visit, path = "$") {
  if (value instanceof Date) return;
  if (Array.isArray(value)) {
    // Elements are visited too, so a plain string in an array is checked.
    value.forEach((v, i) => {
      visit(String(i), v, `${path}[${i}]`);
      walk(v, visit, `${path}[${i}]`);
    });
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v, `${path}.${k}`);
      walk(v, visit, `${path}.${k}`);
    }
  }
}

// The player-identifying values in the mirror games: player keys and Riot IDs.
function playerValues(games) {
  const out = new Set();
  for (const g of games) {
    for (const p of Object.values(g.participants || {})) {
      for (const k of ["playerKey", "gameName", "tagLine"]) {
        if (typeof p[k] === "string" && p[k]) out.add(p[k]);
      }
      if (p.gameName && p.tagLine) out.add(`${p.gameName}#${p.tagLine}`);
    }
  }
  return out;
}

function playerDataHits(output, games) {
  const values = playerValues(games);
  expect(values.size).toBeGreaterThan(0);
  const hits = [];
  walk(output, (k, v, path) => {
    if (FORBIDDEN_KEYS.has(k)) hits.push(`key ${path}`);
    if (typeof v === "string") {
      for (const s of values) if (v.includes(s)) hits.push(`value ${path}=${v}`);
    }
  });
  return hits;
}

function assertNoPlayerData(output, games) {
  expect(playerDataHits(output, games)).toEqual([]);
}

describe("privacy walk (test helper)", () => {
  const games = [
    {
      participants: {
        Ahri: { playerKey: "secret-key-1", gameName: "Player01", tagLine: "T01" },
      },
    },
  ];

  it("finds a Riot ID as a plain string inside an array", () => {
    const hits = playerDataHits({ drafts: [{ picks: ["Ahri", "Player01#T01"] }] }, games);
    // One hit per matching value: the Riot ID, its game name and its tag line.
    expect(hits).toEqual(Array(3).fill("value $.drafts[0].picks[1]=Player01#T01"));
  });

  it("finds player values in nested arrays, objects in arrays, and under object keys", () => {
    const hits = playerDataHits(
      { a: [["x", "secret-key-1"]], b: [{ who: "Player01" }], c: { d: "T01" }, participants: {} },
      games,
    );
    expect(hits).toEqual([
      "value $.a[0][1]=secret-key-1",
      "value $.b[0].who=Player01",
      "value $.c.d=T01",
      "key $.participants",
    ]);
  });
});

// ---------------------------------------------------------------------------
// planSend
// ---------------------------------------------------------------------------

describe("planSend", () => {
  it("builds the versus draft per D2 (fix 6: origin manual; fix 7: team1 is blue name)", () => {
    const series = groupSeries();
    const plan = planSend(series, groupGames(), { senderId: SENDER, now: NOW });
    expect(plan.refused).toBeUndefined();
    expect(plan.versusDraft).toEqual({
      origin: "manual",
      league_series_id: series.id,
      name: "Contingent Esports vs Blue Otter",
      blueTeamName: "Contingent Esports",
      redTeamName: "Blue Otter",
      length: 3,
      type: "fearless",
      competitive: true,
      disabledChampions: [],
      owner_id: SENDER,
    });
  });

  it("fix 7: team1 is the same team in group.team1_id, metadata.blueTeamName and versusDraft.blueTeamName; sides stay per game", () => {
    const series = bracketSeries();
    const games = bracketGames();
    const plan = planSend(series, games, { senderId: SENDER, now: NOW });
    expect(plan.group.team1_id).toBe(series.team1_id);
    expect(plan.group.team2_id).toBe(series.team2_id);
    expect(series.Team1.id).toBe(plan.group.team1_id);
    expect(plan.group.metadata.blueTeamName).toBe(series.Team1.name);
    expect(plan.group.metadata.redTeamName).toBe(series.Team2.name);
    expect(plan.versusDraft.blueTeamName).toBe(series.Team1.name);
    expect(plan.versusDraft.redTeamName).toBe(series.Team2.name);
    // The bracket Bo3 has team 2 on blue in game 0 and team 1 on blue in game 1.
    expect(games.map((g) => g.blue_side_team)).toEqual([2, 1]);
    expect(plan.drafts.map((d) => d.blueSideTeam)).toEqual([2, 1]);
    expect(plan.drafts.map((d) => d.firstPick)).toEqual(games.map((g) => g.first_pick));
  });

  it("a 2-0 Bo3 gives two drafts and length 3", () => {
    const plan = planSend(groupSeries(), groupGames(), { senderId: SENDER, now: NOW });
    expect(plan.drafts).toHaveLength(2);
    expect(plan.cards).toHaveLength(2);
    expect(plan.versusDraft.length).toBe(3);
    expect(plan.group.metadata.length).toBe(3);
  });

  it("builds one versus Draft per game, in number order, from the mirror", () => {
    const games = groupGames();
    const plan = planSend(groupSeries(), [...games].reverse(), { senderId: SENDER, now: NOW });
    expect(plan.drafts).toEqual(
      games.map((g) => ({
        type: "versus",
        seriesIndex: g.number,
        name: `Contingent Esports vs Blue Otter - Game ${g.number + 1}`,
        picks: g.picks,
        firstPick: g.first_pick,
        blueSideTeam: g.blue_side_team,
        winner: g.winner,
        completed: true,
        completedAt: g.played_at,
        public: false,
        owner_id: SENDER,
      })),
    );
  });

  it("copies picks into a new array", () => {
    const games = groupGames();
    const plan = planSend(groupSeries(), games, { senderId: SENDER, now: NOW });
    expect(plan.drafts[0].picks).not.toBe(games[0].picks);
    plan.drafts[0].picks[0] = "Changed";
    expect(games[0].picks[0]).not.toBe("Changed");
  });

  it("keeps a gap in game numbers in seriesIndex and lays cards out by order", () => {
    const series = groupSeries();
    const plan = planSend(series, [syntheticGame(2), syntheticGame(0)], { senderId: SENDER, now: NOW });
    expect(plan.drafts.map((d) => d.seriesIndex)).toEqual([0, 2]);
    expect(plan.drafts.map((d) => d.name)).toEqual([
      "Contingent Esports vs Blue Otter - Game 1",
      "Contingent Esports vs Blue Otter - Game 3",
    ]);
    expect(plan.cards).toEqual([
      { seriesIndex: 0, positionX: seriesCardOrigin(0).x, positionY: seriesCardOrigin(0).y, is_locked: true, source_type: "versus" },
      { seriesIndex: 2, positionX: seriesCardOrigin(1).x, positionY: seriesCardOrigin(1).y, is_locked: true, source_type: "versus" },
    ]);
  });

  it("winner sets completed; no winner leaves the game open; completedAt falls back to now", () => {
    const plan = planSend(
      groupSeries(),
      [syntheticGame(0, { played_at: null }), syntheticGame(1, { winner: null, complete: false })],
      { senderId: SENDER, now: NOW },
    );
    expect(plan.drafts[0]).toMatchObject({ winner: "blue", completed: true, completedAt: NOW });
    expect(plan.drafts[1]).toMatchObject({ winner: null, completed: false, completedAt: null });
  });

  it("winner undefined in the mirror becomes null", () => {
    const plan = planSend(groupSeries(), [syntheticGame(0, { winner: undefined })], { senderId: SENDER, now: NOW });
    expect(plan.drafts[0].winner).toBeNull();
    expect(plan.drafts[0].completed).toBe(false);
  });

  it("builds the group: series type, the series name, team ids and D2's metadata", () => {
    const series = groupSeries();
    const plan = planSend(series, groupGames(), { senderId: SENDER, now: NOW });
    expect(plan.group).toEqual({
      type: "series",
      name: "Contingent Esports vs Blue Otter",
      team1_id: series.team1_id,
      team2_id: series.team2_id,
      metadata: {
        blueTeamName: "Contingent Esports",
        redTeamName: "Blue Otter",
        length: 3,
        competitive: true,
        seriesType: "fearless",
        draftMode: "fearless",
        origin: "manual",
        disabledChampions: [],
        gameType: "official",
      },
    });
    expect(plan.group).not.toHaveProperty("canvas_id");
    expect(plan.group).not.toHaveProperty("positionX");
  });

  it("draft_type null becomes standard", () => {
    const series = { ...groupSeries(), draft_type: null };
    const plan = planSend(series, groupGames(), { senderId: SENDER, now: NOW });
    expect(plan.versusDraft.type).toBe("standard");
    expect(plan.group.metadata.seriesType).toBe("standard");
    expect(plan.group.metadata.draftMode).toBe("standard");
  });

  it("puts no placeholder team name in the metadata", () => {
    const series = groupSeries();
    series.Team1 = { ...series.Team1, name: "Team 1" };
    series.Team2 = { ...series.Team2, name: " team 2 " };
    const plan = planSend(series, groupGames(), { senderId: SENDER, now: NOW });
    expect(plan.group.metadata).not.toHaveProperty("blueTeamName");
    expect(plan.group.metadata).not.toHaveProperty("redTeamName");
  });

  it("refuses a series without both teams", () => {
    const a = { ...groupSeries(), team2_id: null, Team2: null };
    const b = { ...groupSeries(), team1_id: null, Team1: null };
    expect(planSend(a, groupGames(), { senderId: SENDER, now: NOW })).toEqual({ refused: "no-teams" });
    expect(planSend(b, groupGames(), { senderId: SENDER, now: NOW })).toEqual({ refused: "no-teams" });
  });

  it("refuses no-teams when a team row is missing or does not match its id", () => {
    const base = groupSeries();
    const other = "aaaaaaaa-0000-4000-8000-000000000003";
    const cases = [
      { ...base, Team1: null },
      { ...base, Team2: undefined },
      { ...base, team1_id: null },
      { ...base, Team1: { ...base.Team1, id: other } },
      { ...base, Team2: { ...base.Team2, id: other } },
      { ...base, Team1: { name: base.Team1.name } },
      // the two teams swapped between ids and rows
      { ...base, Team1: base.Team2, Team2: base.Team1 },
    ];
    for (const s of cases) {
      expect(planSend(s, groupGames(), { senderId: SENDER, now: NOW })).toEqual({ refused: "no-teams" });
    }
  });

  it("a team-less upcoming series is refused as no-teams", () => {
    const s = { ...groupSeries(), status: "upcoming", team2_id: null, Team2: null };
    expect(planSend(s, [], { senderId: SENDER, now: NOW })).toEqual({ refused: "no-teams" });
  });

  it("refuses a best_of outside VersusDraft.length's 1..7 as unsupported-length", () => {
    for (const best_of of [0, 8, 2.5, null, undefined, -1, "3", NaN]) {
      const s = { ...groupSeries(), best_of };
      expect(planSend(s, groupGames(), { senderId: SENDER, now: NOW })).toEqual({ refused: "unsupported-length" });
    }
    for (const best_of of [1, 7]) {
      const plan = planSend({ ...groupSeries(), best_of }, groupGames(), { senderId: SENDER, now: NOW });
      expect(plan.refused).toBeUndefined();
      expect(plan.versusDraft.length).toBe(best_of);
    }
  });

  it("checks the length after no-teams and upcoming, before no-games", () => {
    const bad = { ...groupSeries(), best_of: 0 };
    expect(planSend({ ...bad, Team1: null }, groupGames(), { senderId: SENDER, now: NOW })).toEqual({ refused: "no-teams" });
    expect(planSend({ ...bad, status: "upcoming" }, [], { senderId: SENDER, now: NOW })).toEqual({ refused: "upcoming" });
    expect(planSend({ ...bad, status: "in_progress" }, [], { senderId: SENDER, now: NOW })).toEqual({ refused: "unsupported-length" });
  });

  it("refuses an upcoming series", () => {
    const s = { ...groupSeries(), status: "upcoming", complete: false };
    expect(planSend(s, [], { senderId: SENDER, now: NOW })).toEqual({ refused: "upcoming" });
  });

  it("refuses a series with no games in the mirror, and sends one in progress", () => {
    const s = { ...groupSeries(), status: "in_progress", complete: false };
    expect(planSend(s, [], { senderId: SENDER, now: NOW })).toEqual({ refused: "no-games" });
    expect(planSend(s, undefined, { senderId: SENDER, now: NOW })).toEqual({ refused: "no-games" });
    const sent = planSend(s, [syntheticGame(0)], { senderId: SENDER, now: NOW });
    expect(sent.refused).toBeUndefined();
    expect(sent.drafts).toHaveLength(1);
  });

  it("carries no participant data anywhere (deep walk, both Bo3s and synthetic)", () => {
    for (const [series, games] of [
      [groupSeries(), groupGames()],
      [bracketSeries(), bracketGames()],
      [groupSeries(), [syntheticGame(0), syntheticGame(1)]],
    ]) {
      const plan = planSend(series, games, { senderId: SENDER, now: NOW });
      assertNoPlayerData(plan, games);
    }
  });

  it("does not mutate its inputs", () => {
    const series = groupSeries();
    const games = groupGames();
    const before = clone({ series, games });
    planSend(series, games, { senderId: SENDER, now: NOW });
    expect(clone({ series, games })).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// planRefresh
// ---------------------------------------------------------------------------

const SERIES_NAME = "Contingent Esports vs Blue Otter";

// Turn planSend's drafts into the "existing" shape, with ids.
function existingFrom(drafts) {
  return drafts.map((d, i) => ({
    id: `dddddddd-0000-4000-8000-00000000000${i}`,
    seriesIndex: d.seriesIndex,
    picks: [...d.picks],
    firstPick: d.firstPick,
    blueSideTeam: d.blueSideTeam,
    winner: d.winner,
    completed: d.completed,
  }));
}

// Apply a refresh plan to the existing drafts, as the caller would.
function apply(existing, result) {
  const next = existing.map((d) => {
    const u = result.updates.find((x) => x.id === d.id);
    return u ? { ...d, ...u.changes } : { ...d };
  });
  result.appends.forEach((a, i) => {
    next.push({
      id: `eeeeeeee-0000-4000-8000-00000000000${i}`,
      seriesIndex: a.draft.seriesIndex,
      picks: [...a.draft.picks],
      firstPick: a.draft.firstPick,
      blueSideTeam: a.draft.blueSideTeam,
      winner: a.draft.winner,
      completed: a.draft.completed,
    });
  });
  return next;
}

const LAST_CARD = { positionX: 380, positionY: 172.5 };

describe("planRefresh", () => {
  const opts = (over = {}) => ({ lastCard: LAST_CARD, now: NOW, seriesName: SERIES_NAME, senderId: SENDER, ...over });

  it("nothing to do when the cards already match the mirror", () => {
    const games = groupGames();
    const existing = existingFrom(planSend(groupSeries(), games, { senderId: SENDER, now: NOW }).drafts);
    expect(planRefresh(existing, games, opts())).toEqual({ appends: [], updates: [] });
  });

  it("appends only the missing game numbers, after the last card, one step apart", () => {
    const g0 = syntheticGame(0);
    const existing = existingFrom(planSend(groupSeries(), [g0], { senderId: SENDER, now: NOW }).drafts);
    const r = planRefresh(existing, [syntheticGame(2), g0, syntheticGame(1)], opts());
    expect(r.updates).toEqual([]);
    expect(r.appends.map((a) => a.draft.seriesIndex)).toEqual([1, 2]);
    const first = nextSeriesCardOrigin(LAST_CARD);
    expect(r.appends.map((a) => a.card)).toEqual([
      { seriesIndex: 1, positionX: first.x, positionY: first.y, is_locked: true, source_type: "versus" },
      { seriesIndex: 2, positionX: first.x + SERIES_GAME_STEP, positionY: first.y, is_locked: true, source_type: "versus" },
    ]);
    expect(r.appends[0].draft).toEqual({
      type: "versus",
      seriesIndex: 1,
      name: `${SERIES_NAME} - Game 2`,
      picks: syntheticPicks("G1C"),
      firstPick: "blue",
      blueSideTeam: 1,
      winner: "blue",
      completed: true,
      completedAt: syntheticGame(1).played_at,
      public: false,
      owner_id: SENDER,
    });
  });

  it("with no last card, appends start at the first series slot", () => {
    const r = planRefresh([], [syntheticGame(0)], opts({ lastCard: null }));
    expect(r.appends[0].card).toMatchObject({ positionX: seriesCardOrigin(0).x, positionY: seriesCardOrigin(0).y });
  });

  it("never returns a position for an existing card", () => {
    const existing = existingFrom([planSend(groupSeries(), [syntheticGame(0)], { senderId: SENDER, now: NOW }).drafts[0]]);
    const r = planRefresh(existing, [syntheticGame(0, { winner: "red", picks: syntheticPicks("X") })], opts());
    expect(r.updates).toHaveLength(1);
    const u = r.updates[0];
    for (const k of ["positionX", "positionY", "x", "y"]) {
      expect(u).not.toHaveProperty(k);
      expect(u.changes).not.toHaveProperty(k);
    }
  });

  it("a dragged-out draft (present in the series, not in the group) is not re-added", () => {
    const games = groupGames();
    const existing = existingFrom(planSend(groupSeries(), games, { senderId: SENDER, now: NOW }).drafts);
    // game 1 was dragged out of the group: still in existingDrafts, so not appended
    const r = planRefresh(existing, games, opts({ lastCard: { positionX: 0, positionY: 172.5 } }));
    expect(r.appends).toEqual([]);
  });

  it("follows the mirror's picks while they differ, with picksChanged", () => {
    const g = syntheticGame(0, { winner: null, complete: false });
    const existing = existingFrom(planSend(groupSeries(), [g], { senderId: SENDER, now: NOW }).drafts);
    const newPicks = syntheticPicks("NEW");
    const r = planRefresh(existing, [{ ...g, picks: newPicks }], opts());
    expect(r.updates).toEqual([{ id: existing[0].id, changes: { picks: newPicks }, picksChanged: true }]);
    expect(r.updates[0].changes.picks).not.toBe(newPicks);
  });

  it("follows the mirror's sides and first pick without picksChanged", () => {
    const g = syntheticGame(0);
    const existing = existingFrom(planSend(groupSeries(), [g], { senderId: SENDER, now: NOW }).drafts);
    existing[0].blueSideTeam = 2;
    existing[0].firstPick = "red";
    const r = planRefresh(existing, [g], opts());
    expect(r.updates).toEqual([{ id: existing[0].id, changes: { firstPick: "blue", blueSideTeam: 1 } }]);
  });

  it("fills a winner where the card has none, with completed and completedAt", () => {
    const open = syntheticGame(0, { winner: null, complete: false });
    const existing = existingFrom(planSend(groupSeries(), [open], { senderId: SENDER, now: NOW }).drafts);
    const done = syntheticGame(0);
    const r = planRefresh(existing, [done], opts());
    expect(r.updates).toEqual([
      { id: existing[0].id, changes: { winner: "blue", completed: true, completedAt: done.played_at } },
    ]);
    const noTime = planRefresh(existing, [{ ...done, played_at: null }], opts());
    expect(noTime.updates[0].changes.completedAt).toBe(NOW);
  });

  it("catches a card up to the final picks of a complete mirror game (cards follow the mirror whenever they differ)", () => {
    // The card was written while the game was still open; the write that
    // completed the game in the mirror also changed its picks. S2 never
    // rewrites a complete game, so the card catches up once and then stays.
    const open = syntheticGame(0, { winner: null, complete: false, picks: syntheticPicks("EARLY") });
    const existing = existingFrom(planSend(groupSeries(), [open], { senderId: SENDER, now: NOW }).drafts);
    const done = syntheticGame(0, { complete: true, picks: syntheticPicks("FINAL") });
    const r = planRefresh(existing, [done], opts());
    expect(r.updates).toEqual([
      {
        id: existing[0].id,
        changes: { picks: syntheticPicks("FINAL"), winner: "blue", completed: true, completedAt: done.played_at },
        picksChanged: true,
      },
    ]);
    // Same winner already on the card: the picks alone still follow.
    const settled = existingFrom(planSend(groupSeries(), [{ ...done, picks: syntheticPicks("EARLY") }], { senderId: SENDER, now: NOW }).drafts);
    expect(planRefresh(settled, [done], opts()).updates).toEqual([
      { id: settled[0].id, changes: { picks: syntheticPicks("FINAL") }, picksChanged: true },
    ]);
  });

  it("completes a card that has the mirror's winner but completed false", () => {
    const g = syntheticGame(0);
    const existing = existingFrom(planSend(groupSeries(), [g], { senderId: SENDER, now: NOW }).drafts);
    existing[0].completed = false;
    expect(existing[0].winner).toBe("blue");
    const r = planRefresh(existing, [g], opts());
    expect(r.updates).toEqual([
      { id: existing[0].id, changes: { winner: "blue", completed: true, completedAt: g.played_at } },
    ]);
  });

  it("sets a different winner from the mirror (Q3 A: the mirror wins)", () => {
    const g = syntheticGame(0);
    const existing = existingFrom(planSend(groupSeries(), [g], { senderId: SENDER, now: NOW }).drafts);
    const r = planRefresh(existing, [{ ...g, winner: "red" }], opts());
    expect(r.updates).toEqual([
      { id: existing[0].id, changes: { winner: "red", completed: true, completedAt: g.played_at } },
    ]);
  });

  it("never clears a winner when the mirror has none", () => {
    const g = syntheticGame(0);
    const existing = existingFrom(planSend(groupSeries(), [g], { senderId: SENDER, now: NOW }).drafts);
    for (const winner of [null, undefined]) {
      const r = planRefresh(existing, [{ ...g, winner }], opts());
      expect(r).toEqual({ appends: [], updates: [] });
    }
  });

  it("leaves a draft with no mirror game alone", () => {
    const existing = existingFrom(planSend(groupSeries(), [syntheticGame(0), syntheticGame(3)], { senderId: SENDER, now: NOW }).drafts);
    existing[1].picks = syntheticPicks("HAND");
    existing[1].winner = null;
    const r = planRefresh(existing, [syntheticGame(0)], opts());
    expect(r).toEqual({ appends: [], updates: [] });
  });

  it("lists only changed fields, keyed by draft id, across several drafts", () => {
    const games = [syntheticGame(0), syntheticGame(1)];
    const existing = existingFrom(planSend(groupSeries(), games, { senderId: SENDER, now: NOW }).drafts);
    existing[1].winner = null;
    existing[1].completed = false;
    const r = planRefresh(existing, games, opts());
    expect(r.updates).toEqual([
      { id: existing[1].id, changes: { winner: "blue", completed: true, completedAt: games[1].played_at } },
    ]);
  });

  it("is idempotent: a second run on the result gives nothing", () => {
    const series = bracketSeries();
    const games = bracketGames();
    const first = planSend(series, [games[0]], { senderId: SENDER, now: NOW });
    const existing = existingFrom(first.drafts);
    existing[0].picks = syntheticPicks("OLD");
    existing[0].winner = null;
    existing[0].completed = false;
    existing[0].blueSideTeam = 1;
    const r1 = planRefresh(existing, games, opts());
    expect(r1.appends).toHaveLength(1);
    expect(r1.updates).toHaveLength(1);
    expect(r1.updates[0].picksChanged).toBe(true);
    const r2 = planRefresh(apply(existing, r1), games, opts());
    expect(r2).toEqual({ appends: [], updates: [] });
  });

  it("carries no participant data anywhere (deep walk)", () => {
    const games = [syntheticGame(0), syntheticGame(1, { picks: syntheticPicks("Y") })];
    const existing = existingFrom(planSend(groupSeries(), [syntheticGame(0, { winner: null })], { senderId: SENDER, now: NOW }).drafts);
    const r = planRefresh(existing, [...games, ...bracketGames().map((g) => ({ ...g, number: g.number + 5 }))], opts());
    expect(r.appends.length).toBeGreaterThan(0);
    expect(r.updates.length).toBeGreaterThan(0);
    assertNoPlayerData(r, [...games, ...bracketGames()]);
  });

  it("does not mutate its inputs", () => {
    const games = [syntheticGame(0), syntheticGame(1)];
    const existing = existingFrom(planSend(groupSeries(), [syntheticGame(0, { winner: null })], { senderId: SENDER, now: NOW }).drafts);
    const before = clone({ existing, games });
    planRefresh(existing, games, opts());
    expect(clone({ existing, games })).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// bulkOrder and columnPositions
// ---------------------------------------------------------------------------

describe("bulkOrder", () => {
  it("newest first: starts_at descending (nulls last), then number descending, then id", () => {
    const rows = [
      { id: "c", starts_at: null, number: 1 },
      { id: "a", starts_at: new Date("2026-11-01T00:00:00Z"), number: 1 },
      { id: "b", starts_at: "2026-11-10T00:00:00.000Z", number: 1 },
      { id: "e", starts_at: new Date("2026-11-01T00:00:00Z"), number: 3 },
      { id: "d", starts_at: null, number: 2 },
      { id: "g", starts_at: new Date("2026-11-01T00:00:00Z"), number: 3 },
      { id: "f", starts_at: new Date("2026-11-01T00:00:00Z"), number: 3 },
    ];
    expect(bulkOrder(rows).map((r) => r.id)).toEqual(["b", "e", "f", "g", "a", "d", "c"]);
  });

  it("returns a new array and leaves the input order alone", () => {
    const rows = [
      { id: "a", starts_at: new Date("2026-01-01T00:00:00Z"), number: 1 },
      { id: "b", starts_at: new Date("2026-02-01T00:00:00Z"), number: 1 },
    ];
    const out = bulkOrder(rows);
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("columnPositions", () => {
  it("stacks count positions down from the drop point", () => {
    expect(columnPositions({ positionX: 100, positionY: 50 }, 3, 700)).toEqual([
      { x: 100, y: 50 },
      { x: 100, y: 750 },
      { x: 100, y: 1450 },
    ]);
  });

  it("no positions for zero", () => {
    expect(columnPositions({ positionX: 0, positionY: 0 }, 0, 700)).toEqual([]);
  });

  it("clamps rowStep to 200..2000", () => {
    expect(columnPositions({ positionX: 0, positionY: 0 }, 2, 10)[1].y).toBe(200);
    expect(columnPositions({ positionX: 0, positionY: 0 }, 2, -500)[1].y).toBe(200);
    expect(columnPositions({ positionX: 0, positionY: 0 }, 2, 99999)[1].y).toBe(2000);
    expect(columnPositions({ positionX: 0, positionY: 0 }, 2, 200)[1].y).toBe(200);
    expect(columnPositions({ positionX: 0, positionY: 0 }, 2, 2000)[1].y).toBe(2000);
  });

  it("falls back to 1250 when rowStep is absent or not a finite number", () => {
    for (const step of [undefined, null, NaN, Infinity, -Infinity, "500"]) {
      expect(columnPositions({ positionX: 0, positionY: 10 }, 2, step)[1].y).toBe(1260);
    }
  });
});
