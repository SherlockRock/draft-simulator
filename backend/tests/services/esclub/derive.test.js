import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const N = require("../../../services/esclub/normalize");
const D = require("../../../services/esclub/derive");
const { TeamInvariantError } = require("../../../services/teamAccess");
const { EsclubProtocolChanged } = require("../../../services/esclub/errors");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")).reply;
const clone = (o) => JSON.parse(JSON.stringify(o));

const rosters = Object.fromEntries(fx("team-rosters.json").teams.map((t) => [t.id_team_roster, N.normalizeTeamRoster(t)]));
const resources = fx("game-resources.json").resources;

function load(dir) {
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
  return { serie, matches, drafts, choices, teams };
}
const input = (d, over = {}) => ({
  serie: d.serie, seasonId: "s", stageId: "st", teams: d.teams,
  matches: d.matches, drafts: d.drafts, choices: d.choices, resources, ...over,
});
const group = N.normalizeSeries(input(load("group-bo3")));
const bracket = N.normalizeSeries(input(load("bracket-bo3")));

// ---- synthetic helpers -------------------------------------------------------

const CHAMPS = ["Aatrox", "Ahri", "Akali", "Alistar", "Amumu", "Anivia", "Annie", "Ashe", "Brand", "Braum"];
/** players: [{k, lane, name?, tag?}] on `side`, plus nothing for the other side. */
function game({ blue = 1, playedAt = "2026-01-01T00:00:00.000Z", players = [], winner = "blue" }) {
  const participants = {};
  players.forEach((p, i) => {
    participants[p.champ ?? CHAMPS[i]] = {
      lane: p.lane ?? null,
      playerKey: p.k === undefined ? `k${i}` : p.k,
      gameName: p.name === undefined ? `Name${p.k}` : p.name,
      tagLine: p.tag === undefined ? `T${p.k}` : p.tag,
      side: p.side ?? "blue",
    };
  });
  return { blueSideTeam: blue, playedAt, participants, winner };
}
const entry = (g, teamNumber = 1) => ({ teamNumber, game: g });
const P = (k, lane, extra = {}) => ({ k, lane, ...extra });
const ids = (roster) => roster.map((r) => `${r.role}:${r.gameName}`);

describe("deriveRoster on the fixtures", () => {
  it("group Bo3: each team gets five starters in role order and no bench, from its own side", () => {
    for (const teamNumber of [1, 2]) {
      const entries = group.series.games.map((g) => ({ teamNumber, game: g }));
      const roster = D.deriveRoster(entries);
      expect(roster.map((r) => r.role)).toEqual(["top", "jungle", "mid", "adc", "support"]);
      expect(roster.map((r) => r.ordinal)).toEqual([0, 1, 2, 3, 4]);
      const expectedNames = new Set();
      for (const g of group.series.games) {
        const side = g.blueSideTeam === teamNumber ? "blue" : "red";
        for (const p of Object.values(g.participants)) if (p.side === side) expectedNames.add(`${p.gameName}#${p.tagLine}`);
      }
      expect(new Set(roster.map((r) => `${r.gameName}#${r.tagLine}`))).toEqual(expectedNames);
    }
  });
  it("the two teams share nobody", () => {
    const a = D.deriveRoster(group.series.games.map((g) => ({ teamNumber: 1, game: g })));
    const b = D.deriveRoster(group.series.games.map((g) => ({ teamNumber: 2, game: g })));
    const names = new Set(a.map((r) => r.gameName));
    expect(b.some((r) => names.has(r.gameName))).toBe(false);
  });
  it("output never carries a player key", () => {
    const roster = D.deriveRoster(group.series.games.map((g) => ({ teamNumber: 1, game: g })));
    for (const r of roster) expect(Object.keys(r).sort()).toEqual(["gameName", "ordinal", "role", "tagLine"]);
    expect(JSON.stringify(roster)).not.toMatch(/fake-oauth/);
  });
  it("bracket Bo3: players with no Riot ID are left off, so the roster is empty", () => {
    const g1 = bracket.series.games.find((g) => g.number === 1);
    expect(Object.values(g1.participants).every((p) => p.gameName === null)).toBe(true);
    expect(D.deriveRoster([{ teamNumber: 1, game: g1 }])).toEqual([]);
  });
  it("bracket Bo3: a game where the team is on red reads the red participants", () => {
    const g0 = bracket.series.games.find((g) => g.number === 0);
    expect(g0.blueSideTeam).toBe(2);
    const red = Object.values(g0.participants).filter((p) => p.side === "red").map((p) => p.playerKey.slice(-3));
    const withNames = clone(g0);
    for (const p of Object.values(withNames.participants)) {
      p.gameName = `N-${p.playerKey.slice(-3)}`;
      p.tagLine = "T";
    }
    const roster = D.deriveRoster([{ teamNumber: 1, game: withNames }]);
    expect(roster.map((r) => r.gameName).sort()).toEqual(red.map((k) => `N-${k}`).sort());
    const rosterTeam2 = D.deriveRoster([{ teamNumber: 2, game: withNames }]);
    const blue = Object.values(g0.participants).filter((p) => p.side === "blue").map((p) => `N-${p.playerKey.slice(-3)}`);
    expect(rosterTeam2.map((r) => r.gameName).sort()).toEqual(blue.sort());
  });
});

describe("deriveRoster rules", () => {
  const five = (prefix, lanes = ["top", "jungle", "mid", "bot", "support"]) => lanes.map((l, i) => P(`${prefix}${i}`, l));

  it("empty input gives an empty roster", () => {
    expect(D.deriveRoster([])).toEqual([]);
  });
  it("lane bot is role adc; starters come in role order whatever the lane order", () => {
    const r = D.deriveRoster([entry(game({ players: [P("a", "support"), P("b", "bot"), P("c", "mid"), P("d", "jungle"), P("e", "top")] }))]);
    expect(ids(r)).toEqual(["top:Namee", "jungle:Named", "mid:Namec", "adc:Nameb", "support:Namea"]);
    expect(r.map((x) => x.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });
  it("the player with the most games in a role is its starter; the other goes to the bench", () => {
    const g1 = game({ playedAt: "2026-01-01T00:00:00.000Z", players: [P("a", "top")] });
    const g2 = game({ playedAt: "2026-01-02T00:00:00.000Z", players: [P("a", "top")] });
    const g3 = game({ playedAt: "2026-01-03T00:00:00.000Z", players: [P("b", "top")] });
    const r = D.deriveRoster([entry(g1), entry(g2), entry(g3)]);
    expect(ids(r)).toEqual(["top:Namea", "null:Nameb"]);
  });
  it("one role per player: a player strongest in two roles takes the higher count, the other role goes to the next player", () => {
    // a: 3 games top, 2 games mid. b: 1 game mid. c: 1 game top.
    const g = (n, players) => entry(game({ playedAt: `2026-01-0${n}T00:00:00.000Z`, players }));
    const r = D.deriveRoster([
      g(1, [P("a", "top")]), g(2, [P("a", "top")]), g(3, [P("a", "top")]),
      g(4, [P("a", "mid")]), g(5, [P("a", "mid"), P("b", "mid"), P("c", "top")]),
    ]);
    // (a,top)=3 first; then (a,mid)=2 skipped (a taken); (b,mid)=1 and (c,top)=1 (top taken) -> b mid
    expect(ids(r)).toEqual(["top:Namea", "mid:Nameb", "null:Namec"]);
  });
  it("tie on count: the player whose latest game is later wins the role", () => {
    const g1 = entry(game({ playedAt: "2026-01-01T00:00:00.000Z", players: [P("a", "top")] }));
    const g2 = entry(game({ playedAt: "2026-01-05T00:00:00.000Z", players: [P("b", "top")] }));
    expect(ids(D.deriveRoster([g1, g2]))).toEqual(["top:Nameb", "null:Namea"]);
  });
  it("tie on count and latest game: player key ascending wins", () => {
    const t = "2026-01-01T00:00:00.000Z";
    const r = D.deriveRoster([entry(game({ playedAt: t, players: [P("zed", "top"), P("amy", "top")] }))]);
    expect(ids(r)).toEqual(["top:Nameamy", "null:Namezed"]);
  });
  it("a null playedAt counts as the oldest", () => {
    const g1 = entry(game({ playedAt: null, players: [P("a", "top")] }));
    const g2 = entry(game({ playedAt: "2026-01-01T00:00:00.000Z", players: [P("b", "top")] }));
    expect(ids(D.deriveRoster([g1, g2]))).toEqual(["top:Nameb", "null:Namea"]);
  });
  it("a null lane counts toward games played but no role: such a player is bench", () => {
    const r = D.deriveRoster([
      entry(game({ players: [P("a", null), P("b", "top")] })),
      entry(game({ players: [P("a", null)] })),
    ]);
    expect(ids(r)).toEqual(["top:Nameb", "null:Namea"]);
  });
  it("lane counts across games decide (a played mid once and top twice -> top)", () => {
    const r = D.deriveRoster([
      entry(game({ playedAt: "2026-01-01T00:00:00.000Z", players: [P("a", "mid")] })),
      entry(game({ playedAt: "2026-01-02T00:00:00.000Z", players: [P("a", "top")] })),
      entry(game({ playedAt: "2026-01-03T00:00:00.000Z", players: [P("a", "top")] })),
    ]);
    expect(ids(r)).toEqual(["top:Namea"]);
  });
  it("bench is ordered by games played, then latest game, then key", () => {
    const e = (n, players) => entry(game({ playedAt: `2026-01-0${n}T00:00:00.000Z`, players }));
    const r = D.deriveRoster([
      e(1, [P("s1", "top"), P("b1", null), P("b2", null), P("b3", null), P("b4", null)]),
      e(2, [P("s1", "top"), P("b1", null), P("b2", null), P("b3", null)]),
      e(3, [P("b3", null), P("b4", null)]),
    ]);
    // s1 starter. games: b3=3, b1=2 (latest 2), b2=2 (latest 2), b4=2 (latest 3)
    expect(ids(r)).toEqual(["top:Names1", "null:Nameb3", "null:Nameb4", "null:Nameb1", "null:Nameb2"]);
  });
  it("total roster is capped at 10: starters first, then the best of the bench", () => {
    const players = [...five("s"), ...Array.from({ length: 9 }, (_, i) => P(`b${i}`, null))];
    const r = D.deriveRoster([entry(game({ players: players.slice(0, 5) })), entry(game({ players: players.slice(5) , playedAt: "2026-01-02T00:00:00.000Z"}))]);
    expect(r).toHaveLength(10);
    expect(r.slice(0, 5).every((x) => x.role !== null)).toBe(true);
    expect(r.slice(5).every((x) => x.role === null)).toBe(true);
    expect(r.map((x) => x.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // b0..b4 (key order) are the ones kept of the nine equal bench players
    expect(r.slice(5).map((x) => x.gameName)).toEqual(["Nameb0", "Nameb1", "Nameb2", "Nameb3", "Nameb4"]);
  });
  it("a player with no Riot ID is left off until a game names them; the latest named game wins", () => {
    const e = (n, over) => entry(game({ playedAt: `2026-01-0${n}T00:00:00.000Z`, players: [P("a", "top", over)] }));
    expect(D.deriveRoster([e(1, { name: null, tag: null })])).toEqual([]);
    const r = D.deriveRoster([e(1, { name: "Old", tag: "O1" }), e(2, { name: "New", tag: "N1" }), e(3, { name: null, tag: null })]);
    expect(r).toEqual([{ role: "top", gameName: "New", tagLine: "N1", ordinal: 0 }]);
  });
  it("a game with only a name or only a tag does not provide a Riot ID", () => {
    const e = (n, over) => entry(game({ playedAt: `2026-01-0${n}T00:00:00.000Z`, players: [P("a", "top", over)] }));
    const r = D.deriveRoster([e(1, { name: "Old", tag: "O1" }), e(2, { name: "Half", tag: null })]);
    expect(r[0].gameName).toBe("Old");
  });
  it("Riot ID ties on playedAt: the later entry in the input wins; null playedAt is oldest", () => {
    const t = "2026-01-01T00:00:00.000Z";
    const a = entry(game({ playedAt: t, players: [P("a", "top", { name: "First", tag: "1" })] }));
    const b = entry(game({ playedAt: t, players: [P("a", "top", { name: "Second", tag: "2" })] }));
    expect(D.deriveRoster([a, b])[0].gameName).toBe("Second");
    expect(D.deriveRoster([b, a])[0].gameName).toBe("First");
    const old = entry(game({ playedAt: null, players: [P("a", "top", { name: "Undated", tag: "9" })] }));
    expect(D.deriveRoster([a, old])[0].gameName).toBe("First");
    expect(D.deriveRoster([old, a])[0].gameName).toBe("First");
  });
  it("Riot IDs are trimmed; over 64 / over 16 after trim leaves the player off; the limits themselves are kept", () => {
    const e = (over) => [entry(game({ players: [P("a", "top", over)] }))];
    expect(D.deriveRoster(e({ name: "  Padded  ", tag: " T " }))).toEqual([{ role: "top", gameName: "Padded", tagLine: "T", ordinal: 0 }]);
    expect(D.deriveRoster(e({ name: "n".repeat(64), tag: "t".repeat(16) }))).toHaveLength(1);
    expect(D.deriveRoster(e({ name: "n".repeat(65), tag: "t" }))).toEqual([]);
    expect(D.deriveRoster(e({ name: "n", tag: "t".repeat(17) }))).toEqual([]);
    expect(D.deriveRoster(e({ name: `  ${"n".repeat(64)}  `, tag: "t" }))).toHaveLength(1);
    expect(D.deriveRoster(e({ name: "   ", tag: "t" }))).toEqual([]);
  });
  it("participants with no playerKey are skipped", () => {
    const r = D.deriveRoster([entry(game({ players: [P(null, "top", { name: "Ghost", tag: "1" }), P("b", "mid")] }))]);
    expect(ids(r)).toEqual(["mid:Nameb"]);
  });
  it("games played counts entries, and a player is counted once per game", () => {
    // b is in two games, a in one: bench order b then a
    const r = D.deriveRoster([
      entry(game({ players: [P("a", null), P("b", null)] })),
      entry(game({ playedAt: "2026-01-02T00:00:00.000Z", players: [P("b", null)] })),
    ]);
    expect(ids(r)).toEqual(["null:Nameb", "null:Namea"]);
  });
  it("reads only the team's side: teamNumber against blueSideTeam", () => {
    const g = game({ blue: 2, players: [P("a", "top", { side: "red" }), P("b", "top", { side: "blue" })] });
    expect(ids(D.deriveRoster([entry(g, 1)]))).toEqual(["top:Namea"]);
    expect(ids(D.deriveRoster([entry(g, 2)]))).toEqual(["top:Nameb"]);
  });
  it("a team that played red in one game and blue in another keeps one player across both", () => {
    const g1 = game({ blue: 1, players: [P("a", "top", { side: "blue" }), P("x", "top", { side: "red" })] });
    const g2 = game({ blue: 2, playedAt: "2026-01-02T00:00:00.000Z", players: [P("a", "top", { side: "red" }), P("y", "top", { side: "blue" })] });
    expect(ids(D.deriveRoster([entry(g1, 1), entry(g2, 1)]))).toEqual(["top:Namea"]);
  });
  it("shuffling the input entries gives the same roster", () => {
    const e = (n, players) => entry(game({ playedAt: n === 0 ? null : `2026-01-0${n}T00:00:00.000Z`, players }));
    const entries = [
      e(1, [P("a", "top"), P("b", "mid"), P("c", null), P("d", "bot")]),
      e(2, [P("a", "top"), P("b", "top"), P("c", "mid"), P("e", "support")]),
      e(3, [P("a", "jungle"), P("b", "mid"), P("f", null)]),
      e(4, [P("g", "top"), P("b", "mid"), P("c", "mid")]),
      e(0, [P("h", "adc"), P("a", "top")]),
    ];
    const expected = D.deriveRoster(entries);
    expect(expected.length).toBeGreaterThan(5);
    const perms = [[...entries].reverse(), [entries[2], entries[4], entries[0], entries[3], entries[1]], [entries[4], entries[3], entries[2], entries[1], entries[0]]];
    for (const p of perms) expect(D.deriveRoster(p)).toEqual(expected);
  });
});

describe("teamRowFromRoster", () => {
  const tournament = { id: "t-1", region: "na1", source: "esclub" };
  const ref = (over = {}) => ({ externalId: "r1", externalOrgId: "o1", name: "Team", acronym: "TM", palette: { primary: "#111111", secondary: "#222222" }, ...over });

  it("builds the row", () => {
    expect(D.teamRowFromRoster(ref(), tournament)).toEqual({
      tournament_id: "t-1", source: "esclub", owner_id: null, external_id: "r1", external_org_id: "o1",
      name: "Team", acronym: "TM", colors: { primary: "#111111", secondary: "#222222" }, region: "na1",
    });
  });
  it("trims and cuts the name to 120", () => {
    expect(D.teamRowFromRoster(ref({ name: "  Padded  " }), tournament).name).toBe("Padded");
    expect(D.teamRowFromRoster(ref({ name: "x".repeat(130) }), tournament).name).toBe("x".repeat(120));
  });
  it("an empty name falls back to the acronym, then the external id", () => {
    expect(D.teamRowFromRoster(ref({ name: "   " }), tournament).name).toBe("TM");
    expect(D.teamRowFromRoster(ref({ name: "", acronym: null }), tournament).name).toBe("r1");
    expect(D.teamRowFromRoster(ref({ name: " ", acronym: "" }), tournament).name).toBe("r1");
  });
  it("acronym is null when empty or longer than 16; 16 is kept", () => {
    expect(D.teamRowFromRoster(ref({ acronym: "a".repeat(17) }), tournament).acronym).toBeNull();
    expect(D.teamRowFromRoster(ref({ acronym: "a".repeat(16) }), tournament).acronym).toBe("a".repeat(16));
    expect(D.teamRowFromRoster(ref({ acronym: "" }), tournament).acronym).toBeNull();
    expect(D.teamRowFromRoster(ref({ acronym: null }), tournament).acronym).toBeNull();
  });
  it("colors is null with no palette; region is the tournament's", () => {
    const row = D.teamRowFromRoster(ref({ palette: null }), { ...tournament, region: "euw1" });
    expect(row.colors).toBeNull();
    expect(row.region).toBe("euw1");
  });
  it("a non-esclub tournament throws TeamInvariantError", () => {
    expect(() => D.teamRowFromRoster(ref(), { ...tournament, source: "manual" })).toThrow(TeamInvariantError);
  });
  it("works on a fixture roster ref", () => {
    const row = D.teamRowFromRoster(group.series.teams[0], tournament);
    expect(row.external_id).toBe(group.series.teams[0].externalId);
    expect(row.name).toBe("Contingent Esports");
  });
});

describe("gameIsComplete and seriesCompleteness", () => {
  const side = (s) => ({ lane: null, playerKey: "k", gameName: null, tagLine: null, side: s });
  const g = (over = {}) => ({
    blueSideTeam: 1, winner: "blue",
    participants: { A: side("blue"), B: side("red") }, ...over,
  });

  it("a game needs a winner and a participant on each side", () => {
    expect(D.gameIsComplete(g())).toBe(true);
    expect(D.gameIsComplete(g({ winner: null }))).toBe(false);
    expect(D.gameIsComplete(g({ participants: {} }))).toBe(false);
    expect(D.gameIsComplete(g({ participants: { A: side("blue") } }))).toBe(false);
    expect(D.gameIsComplete(g({ participants: { A: side("red") } }))).toBe(false);
  });
  it("the fixture games are complete", () => {
    for (const x of [...group.series.games, ...bracket.series.games]) expect(D.gameIsComplete(x)).toBe(true);
  });

  const full = (over = {}, games = [g({ blueSideTeam: 1 }), g({ blueSideTeam: 1 })]) => ({
    series: { status: "finished", bestOf: 3, games, ...over },
    pending: [], failed: [],
  });
  it("a finished Bo3 won 2-0 is complete", () => {
    expect(D.seriesCompleteness(full())).toBe(true);
  });
  it("a Bo3 won 2-1 is complete; sides are mapped through blueSideTeam", () => {
    const games = [g({ blueSideTeam: 1, winner: "blue" }), g({ blueSideTeam: 2, winner: "blue" }), g({ blueSideTeam: 2, winner: "red" })];
    // team1: blue win, red win... game2 blue is team 2 -> team 2 wins; game3 red is team 1 -> team 1 wins => 2-1 team 1
    expect(D.seriesCompleteness(full({}, games))).toBe(true);
  });
  it("a Bo3 with one win each is not complete (no majority)", () => {
    const games = [g({ blueSideTeam: 1, winner: "blue" }), g({ blueSideTeam: 1, winner: "red" })];
    expect(D.seriesCompleteness(full({}, games))).toBe(false);
  });
  it("same-side wins in different games count for different teams", () => {
    // both games won by blue, but blue is a different team each time: 1-1
    const games = [g({ blueSideTeam: 1, winner: "blue" }), g({ blueSideTeam: 2, winner: "blue" })];
    expect(D.seriesCompleteness(full({}, games))).toBe(false);
  });
  it("Bo1 needs one win, Bo5 needs three", () => {
    expect(D.seriesCompleteness(full({ bestOf: 1 }, [g()]))).toBe(true);
    expect(D.seriesCompleteness(full({ bestOf: 5 }, [g(), g()]))).toBe(false);
    expect(D.seriesCompleteness(full({ bestOf: 5 }, [g(), g(), g()]))).toBe(true);
  });
  it("not finished, pending, failed, an incomplete game or no games is not complete", () => {
    expect(D.seriesCompleteness(full({ status: "in_progress" }))).toBe(false);
    expect(D.seriesCompleteness({ ...full(), pending: [{}] })).toBe(false);
    expect(D.seriesCompleteness({ ...full(), failed: [{}] })).toBe(false);
    expect(D.seriesCompleteness(full({}, [g(), g({ winner: null })]))).toBe(false);
    expect(D.seriesCompleteness(full({}, []))).toBe(false);
  });
  it("returns a boolean", () => {
    expect(D.seriesCompleteness(full())).toBe(true);
    expect(D.seriesCompleteness(full({ status: "upcoming" }))).toBe(false);
  });
  it("the fixture series: finished means complete only with a majority", () => {
    // both fixture Bo3s have two games; the winner of both?
    const wins = (s) => {
      const w = { 1: 0, 2: 0 };
      for (const x of s.games) w[x.winner === "blue" ? x.blueSideTeam : 3 - x.blueSideTeam]++;
      return Math.max(w[1], w[2]);
    };
    for (const r of [group, bracket]) {
      const expected = r.series.status === "finished" && wins(r.series) >= 2;
      expect(D.seriesCompleteness(r)).toBe(expected);
    }
  });
  it("a real normalised series with its status changed to in_progress is not complete", () => {
    const r = clone(group);
    r.series.status = "in_progress";
    expect(D.seriesCompleteness(r)).toBe(false);
  });
});

describe("planSeries", () => {
  const listed = (status) => ({ id_serie: "s1", awaiting_status: status });
  const mirrored = (over = {}) => ({ complete: false, team1_id: "a", team2_id: "b", ...over });

  it("a complete mirrored series is skipped and costs no members request", () => {
    expect(D.planSeries(listed("Finished"), mirrored({ complete: true }))).toEqual({ action: "skip", needsMembers: false });
    expect(D.planSeries(listed("StartPending"), mirrored({ complete: true }))).toEqual({ action: "skip", needsMembers: false });
  });
  it("a new upcoming series is stored and needs members (1 request)", () => {
    expect(D.planSeries(listed("StartPending"), null)).toEqual({ action: "store-upcoming", needsMembers: true });
  });
  it("a known upcoming series with teams costs nothing; one without teams asks again", () => {
    expect(D.planSeries(listed("InitiatePending"), mirrored())).toEqual({ action: "store-upcoming", needsMembers: false });
    expect(D.planSeries(listed("InitiatePending"), mirrored({ team1_id: null }))).toEqual({ action: "store-upcoming", needsMembers: true });
    expect(D.planSeries(listed("InitiatePending"), mirrored({ team2_id: null }))).toEqual({ action: "store-upcoming", needsMembers: true });
  });
  it("an in-progress or finished series that is not complete is fetched", () => {
    expect(D.planSeries(listed("EndPending"), null)).toEqual({ action: "fetch", needsMembers: true });
    expect(D.planSeries(listed("Finished"), mirrored())).toEqual({ action: "fetch", needsMembers: false });
    expect(D.planSeries(listed("Finished"), mirrored({ complete: false, team1_id: null }))).toEqual({ action: "fetch", needsMembers: true });
  });
  it("an unknown status throws EsclubProtocolChanged", () => {
    expect(() => D.planSeries(listed("Weird"), null)).toThrow(EsclubProtocolChanged);
  });
  it("a complete series never needs members, whatever the status (a complete one has teams)", () => {
    for (const s of ["InitiatePending", "TerminateDefault", "Finished"]) {
      expect(D.planSeries(listed(s), mirrored({ complete: true })).needsMembers).toBe(false);
    }
  });
});
