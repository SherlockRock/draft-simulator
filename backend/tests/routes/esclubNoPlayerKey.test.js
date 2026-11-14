import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";

// Privacy (S2 D11): no esclub read route may carry a player key, a Riot ID,
// a participant list, substitution data, an esclub user id or requested_by.

const require = createRequire(import.meta.url);
const auth = require("../../middleware/auth");
const Tournament = require("../../models/Tournament");
const LeagueStage = require("../../models/LeagueStage");
const LeagueSeries = require("../../models/LeagueSeries");
const LeagueGame = require("../../models/LeagueGame");
const EsclubSync = require("../../models/EsclubSync");
const syncState = require("../../services/esclub/syncState");

function buildApp() {
  const routePath = require.resolve("../../routes/esclub");
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use("/api/esclub", require("../../routes/esclub"));
  return app;
}

const TID = "44444444-4444-4444-8444-444444444444";
const SID = "55555555-5555-4555-8555-555555555555";
const YID = "66666666-6666-4666-8666-666666666666";
const STAGE = "77777777-7777-4777-8777-777777777777";
const TEAM_A = "88888888-8888-4888-8888-888888888888";
const TEAM_B = "99999999-9999-4999-8999-999999999999";

const FORBIDDEN_KEYS = [
  "playerKey",
  "player_key",
  "id_oauth_riot",
  "gameName",
  "tagLine",
  "participants",
  "substitutions",
  "unmatched_participants",
  "requested_by",
  "requestedBy",
  "error_message",
  "id_user",
  "via",
];
const FORBIDDEN_VALUES = [
  "PLAYERKEY-ALPHA",
  "PLAYERKEY-BRAVO",
  "oauth-riot-ALPHA",
  "Player01",
  "T01",
  "Player02",
  "T02",
  "esclub-user-9",
  "requester-7",
  "sub-player-text",
];

// Rows as Sequelize would hand them back if every column had been loaded:
// the route must not forward any of the player data on them.
const dirtyParticipants = {
  Ahri: {
    lane: "mid",
    playerKey: "PLAYERKEY-ALPHA",
    id_oauth_riot: "oauth-riot-ALPHA",
    gameName: "Player01",
    tagLine: "T01",
    id_user: "esclub-user-9",
  },
  Zed: {
    lane: null,
    playerKey: "PLAYERKEY-BRAVO",
    gameName: "Player02",
    tagLine: "T02",
  },
};

const dirtyGame = {
  series_id: SID,
  number: 1,
  played_at: new Date("2026-11-20T18:10:00Z"),
  picks: ["Ahri", "Zed"],
  first_pick: "blue",
  blue_side_team: 1,
  winner: "blue",
  complete: true,
  participants: dirtyParticipants,
  substitutions: [{ gameName: "sub-player-text", playerKey: "PLAYERKEY-ALPHA" }],
  unmatched_participants: 1,
  id_user: "esclub-user-9",
};

const team = (id, name) => ({
  id,
  name,
  acronym: "AAA",
  colors: null,
  owner_id: "requester-7",
});

const dirtySeries = {
  id: SID,
  external_id: "ext-serie-1",
  tournament_id: TID,
  stage_id: STAGE,
  number: 1,
  starts_at: null,
  status: "finished",
  complete: true,
  best_of: 3,
  draft_type: "fearless",
  team1_id: TEAM_A,
  team2_id: TEAM_B,
  Team1: team(TEAM_A, "Alpha"),
  Team2: team(TEAM_B, "Bravo"),
  requested_by: "requester-7",
  participants: dirtyParticipants,
};

const dirtySync = {
  id: YID,
  kind: "league",
  status: "failed",
  tournament_id: TID,
  stage_id: null,
  series_id: null,
  requested_by: "requester-7",
  via: "api",
  started_at: new Date("2026-11-14T10:00:00Z"),
  heartbeat_at: new Date("2026-11-14T10:00:30Z"),
  finished_at: new Date("2026-11-14T10:01:00Z"),
  request_count: 3,
  error_class: "EsclubUnavailable",
  error_message: "failed for requester-7 PLAYERKEY-ALPHA",
  summary: { seriesListed: 2 },
};

/** Every key and every string in a JSON value. */
function walk(value, keys, strings) {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, keys, strings);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      walk(v, keys, strings);
    }
  } else if (typeof value === "string") {
    strings.push(value);
  }
}

function expectClean(res) {
  const keys = [];
  const strings = [];
  walk(res.body, keys, strings);
  for (const key of FORBIDDEN_KEYS) expect(keys).not.toContain(key);
  // Champion names are keys of `lanes`; nothing else may be a player datum.
  const text = JSON.stringify(res.body);
  for (const value of FORBIDDEN_VALUES) expect(text).not.toContain(value);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(auth, "protect").mockImplementation((req, _res, next) => {
    req.user = { id: "u1" };
    next();
  });
  vi.spyOn(Tournament, "findByPk").mockResolvedValue({
    id: TID,
    name: "Spring",
    region: "na1",
    source: "esclub",
    last_synced_at: null,
    created_by: "requester-7",
  });
  vi.spyOn(LeagueStage, "findAll").mockResolvedValue([
    { id: STAGE, name: "Season", last_synced_at: null, added_by: "requester-7" },
  ]);
  vi.spyOn(EsclubSync, "findOne").mockResolvedValue(dirtySync);
  vi.spyOn(syncState, "getSync").mockResolvedValue(dirtySync);
  vi.spyOn(syncState, "nextAvailableAt").mockResolvedValue(null);
  vi.spyOn(syncState, "usageToday").mockResolvedValue({ used: 0, budget: 10 });
  vi.spyOn(LeagueSeries, "findAll").mockResolvedValue([dirtySeries]);
  vi.spyOn(LeagueSeries, "findByPk").mockResolvedValue(dirtySeries);
  vi.spyOn(LeagueGame, "findAll").mockResolvedValue([dirtyGame]);
});

const ROUTES = [
  ["syncs", `/api/esclub/syncs/${YID}`],
  ["tournament", `/api/esclub/tournaments/${TID}`],
  ["series list", `/api/esclub/tournaments/${TID}/series`],
  ["series detail", `/api/esclub/series/${SID}`],
];

describe("no esclub read route returns player data", () => {
  it.each(ROUTES)("%s", async (_label, url) => {
    const res = await request(buildApp()).get(url);
    expect(res.status).toBe(200);
    expectClean(res);
  });

  it("the series detail still carries lanes (the walk is not vacuous)", async () => {
    const res = await request(buildApp()).get(`/api/esclub/series/${SID}`);
    expect(res.body.series.games[0].lanes).toEqual({ Ahri: "mid" });
    expect(JSON.stringify(res.body)).toContain("Alpha");
  });

  it("the walk catches a leak", () => {
    const leaky = { body: { games: [{ participants: {} }] } };
    expect(() => expectClean(leaky)).toThrow();
    const leakyValue = { body: { note: "Player01" } };
    expect(() => expectClean(leakyValue)).toThrow();
  });
});

describe("action responses carry no requester", () => {
  it("a refresh that joins a running sync shows the view only", async () => {
    vi.spyOn(syncState, "beginSync").mockResolvedValue({ joined: dirtySync });
    const res = await request(buildApp()).post(
      `/api/esclub/tournaments/${TID}/refresh`,
    );
    expect(res.status).toBe(200);
    expectClean(res);
  });
});
