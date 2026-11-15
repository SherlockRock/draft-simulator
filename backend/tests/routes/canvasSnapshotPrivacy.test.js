import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

/**
 * S3 D8 privacy walk: the canvas snapshot carries no player data from the
 * league mirror. The fixtures put participants, player keys, Riot IDs and an
 * esclub user id into every mirror row the group include could reach; the
 * walk fails on any of those keys or values anywhere in the payload, except
 * `gameName`/`tagLine` of a linked team's roster under
 * `groups[i].Team1|Team2.TeamPlayers` (plan Answers Q5 A).
 */

const require = createRequire(import.meta.url);
const {
  Canvas,
  CanvasDraft,
  CanvasGroup,
  CanvasConnection,
  CanvasAnnotation,
  CanvasPoolPlacement,
} = require("../../models/Canvas");
const { buildCanvasSnapshot } = require("../../routes/canvasProjections");

const SERIES_ID = "11111111-1111-4111-8111-111111111111";

// Mirror-only player data: must appear nowhere in the payload.
const MIRROR_VALUES = [
  "Player07",
  "T07",
  "Player07#T07",
  "oauth-riot-0007",
  "esclub-user-0007",
];
// Roster data of the linked team: allowed only under Team1/Team2.TeamPlayers.
const ROSTER_VALUES = ["Player01", "T01"];

const FORBIDDEN_KEYS = new Set([
  "participants",
  "Participants",
  "playerKey",
  "id_oauth_riot",
  "gameName",
  "tagLine",
  "name_riot_game",
  "tag_riot_game",
  "id_user",
  "unmatched_participants",
]);
const ROSTER_KEYS = new Set(["gameName", "tagLine"]);
const ROSTER_PATH = /^groups\.\d+\.Team[12]\.TeamPlayers\.\d+$/;

const participant = () => ({
  lane: "mid",
  playerKey: "oauth-riot-0007",
  gameName: "Player07",
  tagLine: "T07",
  side: "blue",
});

const mirrorGame = () => ({
  id: "lg-1",
  number: 0,
  picks: Array(20).fill(""),
  participants: { Ahri: participant(), Player01: participant() },
  unmatched_participants: 0,
  raw: {
    participants: [
      {
        id_oauth_riot: "oauth-riot-0007",
        name_riot_game: "Player07",
        tag_riot_game: "T07",
        id_user: "esclub-user-0007",
        riotId: "Player07#T07",
      },
    ],
  },
});

const rosterTeam = (id) => ({
  id,
  name: `Team ${id}`,
  Tournament: { id: "t-1", name: "League", source: "esclub" },
  TeamPlayers: [
    { id: `${id}-p1`, role: "mid", gameName: "Player01", tagLine: "T01", ordinal: 0 },
  ],
});

// What a careless include could drag in: everything the mirror holds.
const importedGroupJson = () => ({
  id: "g-1",
  canvas_id: "c-1",
  name: "Series",
  type: "series",
  positionX: 0,
  positionY: 0,
  versus_draft_id: "vd-1",
  team1_id: "team-a",
  team2_id: "team-b",
  metadata: { blueTeamName: "Team team-a", redTeamName: "Team team-b" },
  Team1: rosterTeam("team-a"),
  Team2: rosterTeam("team-b"),
  VersusDraft: {
    id: "vd-1",
    league_series_id: SERIES_ID,
    participants: [participant()],
    LeagueSeries: {
      id: SERIES_ID,
      external_id: "9876",
      tournament_id: "t-1",
      starts_at: new Date("2026-11-11T18:00:00.000Z"),
      status: "finished",
      complete: true,
      Stage: { id: "s-1", name: "Regular Season", added_by: "esclub-user-0007" },
      Games: [mirrorGame()],
      members: [{ id_user: "esclub-user-0007", gameName: "Player07" }],
    },
  },
});

/** Every (path, key, value) leaf and key in a JSON-like tree. */
function walk(node, path, visit) {
  if (node instanceof Date) {
    visit(path, null, node.toISOString());
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}.${i}`, visit));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, child] of Object.entries(node)) {
      visit(path, key, undefined);
      walk(child, path ? `${path}.${key}` : key, visit);
    }
    return;
  }
  visit(path, null, node);
}

function leaks(payload) {
  const found = [];
  walk(JSON.parse(JSON.stringify(payload)), "", (path, key, value) => {
    if (key !== null && FORBIDDEN_KEYS.has(key)) {
      const allowed = ROSTER_KEYS.has(key) && ROSTER_PATH.test(path);
      if (!allowed) found.push(`key ${key} at ${path}`);
    }
    if (typeof value === "string") {
      for (const bad of MIRROR_VALUES) {
        if (value.includes(bad)) found.push(`value ${bad} at ${path}`);
      }
      for (const roster of ROSTER_VALUES) {
        const parent = path.slice(0, path.lastIndexOf("."));
        if (value.includes(roster) && !ROSTER_PATH.test(parent)) {
          found.push(`roster value ${roster} at ${path}`);
        }
      }
    }
  });
  return found;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Canvas, "findByPk").mockResolvedValue({
    toJSON: () => ({ id: "c-1", name: "C", cardLayout: "wide" }),
  });
  vi.spyOn(CanvasDraft, "findAll").mockResolvedValue([
    {
      draft_id: "d-1",
      positionX: 0,
      positionY: 0,
      is_locked: true,
      group_id: "g-1",
      source_type: "versus",
      Draft: {
        id: "d-1",
        name: "Series - Game 1",
        picks: Array(20).fill("Ahri"),
        type: "versus",
        versus_draft_id: "vd-1",
        seriesIndex: 0,
        completed: true,
        winner: "blue",
        blueSideTeam: 1,
        firstPick: "blue",
        picksVersion: 1,
      },
    },
  ]);
  vi.spyOn(CanvasConnection, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasAnnotation, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasPoolPlacement, "findAll").mockResolvedValue([]);
  vi.spyOn(CanvasGroup, "findAll").mockResolvedValue([
    { toJSON: importedGroupJson },
  ]);
});

describe("canvas snapshot privacy (S3 D8)", () => {
  it("the walk itself catches mirror data (fixture sanity)", () => {
    expect(leaks({ groups: [importedGroupJson()] })).not.toEqual([]);
  });

  it("carries no participant, player key, Riot ID or esclub user id", async () => {
    const payload = await buildCanvasSnapshot("c-1");
    expect(leaks(payload)).toEqual([]);
  });

  it("still carries the linked rosters and the LeagueImport view", async () => {
    const payload = await buildCanvasSnapshot("c-1");
    const [group] = payload.groups;
    expect(group.Team1.TeamPlayers[0]).toMatchObject({
      gameName: "Player01",
      tagLine: "T01",
    });
    expect(group.LeagueImport).toEqual({
      leagueSeriesId: SERIES_ID,
      tournamentId: "t-1",
      stageName: "Regular Season",
      startsAt: "2026-11-11T18:00:00.000Z",
      status: "finished",
      complete: true,
      esclubUrl: "https://esclub.gg/serie/9876",
    });
  });
});
