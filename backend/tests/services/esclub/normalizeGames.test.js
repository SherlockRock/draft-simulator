import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const N = require("../../../services/esclub/normalize");
const { EsclubProtocolChanged, EsclubUnknownChampion } = require("../../../services/esclub/errors");
const { getEffectivePickOrder, getPicksArrayIndex } = require("../../../utils/versusPickOrder");
const { championAliasForKey } = require("../../../utils/championKeys");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")).reply;
const clone = (o) => JSON.parse(JSON.stringify(o));

const rosters = Object.fromEntries(fx("team-rosters.json").teams.map((t) => [t.id_team_roster, N.normalizeTeamRoster(t)]));
const resources = fx("game-resources.json").resources;
const byRes = new Map(resources.map((r) => [r.id_game_resource, r]));

// The two real rosters of each Bo3, taken from the final choices (not hard-coded).
function load(dir) {
  const serie = fx(`${dir}/serie.json`).series[0];
  const matches = fx(`${dir}/matches.json`).matches;
  const drafts = {};
  const choices = {};
  const scores = {};
  for (const n of [0, 1]) {
    const m = matches.find((x) => x.number === n);
    drafts[m.id_match] = fx(`${dir}/draft-${n}.json`).drafts[0];
    choices[m.id_match] = fx(`${dir}/choices-${n}.json`).choices;
    scores[m.id_match] = fx(`${dir}/scores-${n}.json`).scores;
  }
  const ids = [...new Set(Object.values(choices).flat().filter((c) => c.is_final).map((c) => c.id_team_roster_source))];
  // team order: the order they appear in the rosters list (any fixed order will do)
  const order = Object.keys(rosters);
  const teams = ids.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((id) => rosters[id]);
  return { serie, matches, drafts, choices, scores, teams };
}
const input = (d, over = {}) => ({
  serie: d.serie, seasonId: "s", stageId: "st", teams: d.teams,
  matches: d.matches, drafts: d.drafts, choices: d.choices, resources, ...over,
});
const group = load("group-bo3");
const bracket = load("bracket-bo3");
const gm = (d, n) => d.matches.find((m) => m.number === n);

describe("fixture rosters", () => {
  it("each Bo3 has exactly two real rosters", () => {
    expect(group.teams.map((t) => t.name)).toEqual(["Contingent Esports", "Blue Otter"]);
    expect(bracket.teams.map((t) => t.name)).toEqual(["Contingent Esports", "Vancouver Impact"]);
  });
});

describe("group Bo3", () => {
  const r = N.normalizeSeries(input(group));
  it("keeps game 0 and game 1, nothing pending, skipped or failed", () => {
    expect(r.series.games.map((g) => g.number)).toEqual([0, 1]);
    expect(r.pending).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toEqual([]);
  });
  it("fills all 20 slots with catalog aliases, placed by the pick order", () => {
    for (const g of r.series.games) {
      expect(g.picks).toHaveLength(20);
      expect(g.picks.every((p) => typeof p === "string" && p !== "")).toBe(true);
      expect(new Set(g.picks).size).toBe(20);
      // re-derive each slot from the raw final choices
      const order = getEffectivePickOrder(g.firstPick);
      const fin = group.choices[g.externalMatchId].filter((c) => c.is_final);
      for (const c of fin) {
        const alias = championAliasForKey(byRes.get(c.id_game_resource).id_external);
        expect(g.picks[getPicksArrayIndex(c.number, g.firstPick)]).toBe(alias);
        expect(order[c.number].type).toBe(c.type_choice === "BanCharacter" ? "ban" : "pick");
      }
    }
  });
  it("sides, first pick and the game-0 slots", () => {
    const [g0, g1] = r.series.games;
    expect(g0.firstPick).toBe("blue");
    expect(g0.blueSideTeam).toBe(1);
    expect(g0.picks.slice(10, 13)).toEqual(["Syndra", "Nautilus", "Qiyana"]);
    expect(g0.picks[0]).toBe("Karma");
    expect(g0.picks[5]).toBe("Lux");
    expect(g1.firstPick).toBe("blue");
    expect(g1.blueSideTeam).toBe(1);
    expect(g0.playedAt).toBe(new Date(gm(group, 0).time_start * 1000).toISOString());
  });
  it("winners agree with the scores fixtures through blueSideTeam", () => {
    for (const g of r.series.games) {
      const winRoster = group.scores[g.externalMatchId].find((s) => s.score === 1).id_team_roster;
      const winnerTeam = group.teams.findIndex((t) => t.externalId === winRoster) + 1;
      const winningSide = g.blueSideTeam === winnerTeam ? "blue" : "red";
      expect(g.winner).toBe(winningSide);
    }
  });
  it("game 1 has 10 participants, game 0 has 9 and one unmatched (Xin Zhao drafted, Vi played)", () => {
    const [g0, g1] = r.series.games;
    expect(Object.keys(g1.participants)).toHaveLength(10);
    expect(g1.unmatchedParticipants).toBe(0);
    expect(Object.keys(g0.participants)).toHaveLength(9);
    expect(g0.unmatchedParticipants).toBe(1);
    expect(g0.participants.XinZhao).toBeUndefined();
    expect(g0.participants.Vi).toBeUndefined();
    expect(g0.participants.Olaf).toBeDefined();
  });
  it("participants carry lane, fake key and Riot ID", () => {
    const g1 = r.series.games[1];
    const lanes = Object.values(g1.participants).map((p) => p.lane).sort();
    expect(lanes).toEqual(["bot", "bot", "jungle", "jungle", "mid", "mid", "support", "support", "top", "top"]);
    for (const p of Object.values(g1.participants)) {
      expect(p.playerKey).toMatch(/^fake-oauth-/);
      expect(p.gameName).toMatch(/^Player\d{2}$/);
      expect(p.tagLine).toMatch(/^T\d{2}$/);
    }
    expect(g1.participants.Gnar.lane).toBe("top");
  });
  it("participants come only from the picking roster's side", () => {
    // Swap the sides of two same-champion participants: no longer matched.
    const d = clone(group);
    const lol = gm(d, 1).config.integrations[0].LeagueOfLegends;
    lol.participants.forEach((p) => { p.side = p.side === 1 ? 2 : 1; });
    // Every participant now on the wrong side: rosters resolve to swapped sides,
    // and PickSide (red for 06e5) disagrees.
    expect(() => N.normalizeSeries(input(d))).toThrow(EsclubProtocolChanged);
  });
});

describe("bracket Bo3", () => {
  const r = N.normalizeSeries(input(bracket));
  it("game 1 normalises: no PickSide rows, Riot IDs null, keys present, flipped sides", () => {
    expect(bracket.choices[gm(bracket, 1).id_match].some((c) => c.type_choice === "PickSide")).toBe(false);
    const g1 = r.series.games.find((g) => g.number === 1);
    expect(g1).toBeDefined();
    expect(g1.blueSideTeam).toBe(1); // Contingent (teams[0]) on blue in game 1, Vancouver in game 0
    expect(g1.firstPick).toBe("blue");
    for (const p of Object.values(g1.participants)) {
      expect(p.gameName).toBeNull();
      expect(p.tagLine).toBeNull();
      expect(p.playerKey).toMatch(/^fake-oauth-/);
    }
    expect(Object.keys(g1.participants)).toHaveLength(10);
  });
  it("game 0 has a skipped ban (a final Placeholder ban, choice 0): that slot is empty and the game is kept", () => {
    const fin = bracket.choices[gm(bracket, 0).id_match].filter((c) => c.is_final);
    const first = fin.find((c) => c.number === 0);
    expect(first.type_choice).toBe("BanCharacter");
    expect(byRes.get(first.id_game_resource).id_external).toBe("-1");
    expect(r.failed).toEqual([]);
    expect(r.series.games.map((g) => g.number)).toEqual([0, 1]);
    const g0 = r.series.games[0];
    const empty = getPicksArrayIndex(0, g0.firstPick);
    expect(g0.picks[empty]).toBe("");
    expect(g0.picks.filter((p) => p === "")).toHaveLength(1);
    // every other slot is the champion esclub recorded for it
    for (const c of fin.filter((x) => x.number !== 0)) {
      expect(g0.picks[getPicksArrayIndex(c.number, g0.firstPick)]).toBe(championAliasForKey(byRes.get(c.id_game_resource).id_external));
    }
    expect(new Set(g0.picks).size).toBe(20);
    expect(g0.blueSideTeam).toBe(2);
    expect(Object.keys(g0.participants)).toHaveLength(10);
  });
  it("with that ban replaced by a real champion, game 0 normalises and sides flip between games", () => {
    const d = clone(bracket);
    const id0 = gm(d, 0).id_match;
    const lux = resources.find((x) => x.id_external === "99");
    const used = new Set(d.choices[id0].filter((c) => c.is_final).map((c) => c.id_game_resource));
    const spare = resources.find((x) => x.type_resource === "Character" && championAliasForKey(x.id_external) && !used.has(x.id_game_resource) && x !== lux);
    for (const c of d.choices[id0]) if (c.is_final && c.number === 0) c.id_game_resource = spare.id_game_resource;
    const out = N.normalizeSeries(input(d));
    expect(out.failed).toEqual([]);
    const [g0, g1] = out.series.games;
    expect([g0.number, g1.number]).toEqual([0, 1]);
    expect(g0.blueSideTeam).not.toBe(g1.blueSideTeam);
    expect(g0.picks[0]).toBe(championAliasForKey(spare.id_external));
    expect(g0.blueSideTeam).toBe(2);
    expect(g1.blueSideTeam).toBe(1);
    expect(g0.firstPick).toBe("blue"); // choice 0 came from the blue roster in both games
    expect(g1.firstPick).toBe("blue");
    for (const g of [g0, g1]) {
      const winRoster = d.scores[g.externalMatchId].find((s) => s.score === 1).id_team_roster;
      const winnerTeam = d.teams.findIndex((t) => t.externalId === winRoster) + 1;
      expect(g.winner).toBe(g.blueSideTeam === winnerTeam ? "blue" : "red");
    }
  });
});

describe("synthetic variants", () => {
  const run = (mutate, base = group) => {
    const d = clone(base);
    mutate(d);
    return N.normalizeSeries(input(d));
  };
  const id0 = gm(group, 0).id_match;
  const id1 = gm(group, 1).id_match;

  it("blind draft is skipped before any other check, even with garbage choices and an odd type_fearless", () => {
    const r = run((d) => {
      d.drafts[id0].is_blind = true;
      d.drafts[id0].type_fearless = "SoftBoth";
      d.choices[id0] = [{ nonsense: true }];
    });
    expect(r.skipped).toEqual([{ externalMatchId: id0, number: 0, reason: "blind draft" }]);
    expect(r.series.games.map((g) => g.number)).toEqual([1]);
    expect(r.series.draftType).toBe("fearless");
  });
  it("a blind draft cannot make the series' draft type disagree", () => {
    const r = run((d) => {
      d.drafts[id0].is_blind = true;
      d.drafts[id0].type_fearless = "None";
    });
    expect(r.series.draftType).toBe("fearless");
  });
  it("only blind drafts -> draftType null", () => {
    const r = run((d) => {
      for (const id of [id0, id1]) { d.drafts[id].is_blind = true; d.drafts[id].type_fearless = "SoftBoth"; }
    });
    expect(r.series.draftType).toBeNull();
    expect(r.skipped).toHaveLength(2);
  });
  it("19 final choices -> pending (draft incomplete)", () => {
    const r = run((d) => {
      d.choices[id1] = d.choices[id1].filter((c) => !(c.is_final && c.number === 19));
    });
    expect(r.pending).toEqual([{ externalMatchId: id1, number: 1, reason: "draft incomplete" }]);
    expect(r.series.games.map((g) => g.number)).toEqual([0]);
  });
  it("two final choices with the same number -> EsclubProtocolChanged", () => {
    expect(() => run((d) => {
      const dup = clone(d.choices[id1].find((c) => c.is_final && c.number === 18));
      d.choices[id1].push(dup);
    })).toThrow(EsclubProtocolChanged);
  });
  it("a final choice numbered above 19 -> EsclubProtocolChanged", () => {
    expect(() => run((d) => {
      const extra = clone(d.choices[id1].find((c) => c.is_final && c.number === 19));
      extra.number = 20;
      d.choices[id1].push(extra);
    })).toThrow(EsclubProtocolChanged);
  });
  it("no participants but a PickSide row -> normalised from it", () => {
    const withP = N.normalizeSeries(input(group));
    for (const n of [0, 1]) {
      const r = run((d) => { gm(d, n).config.integrations[0].LeagueOfLegends.participants = []; });
      const g = r.series.games.find((x) => x.number === n);
      const ref = withP.series.games.find((x) => x.number === n);
      expect(g.blueSideTeam).toBe(ref.blueSideTeam);
      expect(g.firstPick).toBe(ref.firstPick);
      expect(g.picks).toEqual(ref.picks);
      expect(g.participants).toEqual({});
      expect(g.unmatchedParticipants).toBe(0);
    }
  });
  it("no participants and no PickSide row -> pending (sides unknown)", () => {
    const r = run((d) => { gm(d, 0).config.integrations[0].LeagueOfLegends.participants = []; }, bracket);
    expect(r.pending).toEqual([{ externalMatchId: gm(bracket, 0).id_match, number: 0, reason: "sides unknown" }]);
  });
  const sideRes = (ext) => resources.find((x) => x.type_resource === "Side" && x.id_external === ext).id_game_resource;
  const noParticipants = (d, id) => { d.matches.find((m) => m.id_match === id).config.integrations[0].LeagueOfLegends.participants = []; };
  it("a changed unlocked PickSide hover does not matter when participants decide", () => {
    const ref = N.normalizeSeries(input(group)).series.games[0];
    const r = run((d) => {
      for (const c of d.choices[id0]) if (c.type_choice === "PickSide" && !c.is_locked) c.id_game_resource = sideRes("2");
    });
    expect(r.series.games[0]).toEqual(ref);
  });
  it("an unlocked hover alone never decides sides (no participants -> pending)", () => {
    const r = run((d) => {
      noParticipants(d, id0);
      d.choices[id0] = d.choices[id0].filter((c) => !(c.type_choice === "PickSide" && c.is_locked));
    });
    expect(r.pending).toEqual([{ externalMatchId: id0, number: 0, reason: "sides unknown" }]);
  });
  it("both rosters' locked rows on the same side, no participants -> pending, not a throw", () => {
    const r = run((d) => {
      noParticipants(d, id0);
      const row = d.choices[id0].find((c) => c.type_choice === "PickSide" && c.is_locked);
      const otherRoster = d.choices[id0].find((c) => c.is_final && c.id_team_roster_source !== row.id_team_roster_source).id_team_roster_source;
      d.choices[id0].push({ ...row, id_team_roster_source: otherRoster });
    });
    expect(r.pending).toEqual([{ externalMatchId: id0, number: 0, reason: "sides unknown" }]);
  });
  it("self-contradicting locked rows with participants present: participants decide", () => {
    const ref = N.normalizeSeries(input(group)).series.games[0];
    const r = run((d) => {
      const row = d.choices[id0].find((c) => c.type_choice === "PickSide" && c.is_locked);
      d.choices[id0].push({ ...row, id_game_resource: sideRes("2") });
    });
    expect(r.series.games[0]).toEqual(ref);
  });
  it("locked PickSide rows contradicting participants -> EsclubProtocolChanged", () => {
    expect(() => run((d) => {
      for (const c of d.choices[id0]) if (c.type_choice === "PickSide" && c.is_locked) c.id_game_resource = sideRes("2");
    })).toThrow(EsclubProtocolChanged);
  });
  it("participants and PickSide disagreeing -> EsclubProtocolChanged", () => {
    expect(() => run((d) => {
      for (const c of d.choices[id0]) {
        if (c.type_choice === "PickSide") c.id_game_resource = resources.find((x) => x.type_resource === "Side" && x.id_external === "2").id_game_resource;
      }
    })).toThrow(EsclubProtocolChanged);
  });
  it("a choice by the wrong roster for its turn -> EsclubProtocolChanged", () => {
    expect(() => run((d) => {
      const c = d.choices[id1].find((x) => x.is_final && x.number === 2);
      const other = d.choices[id1].find((x) => x.is_final && x.number === 1);
      c.id_team_roster_source = other.id_team_roster_source;
    })).toThrow(EsclubProtocolChanged);
  });
  it("a ban where the order says pick -> EsclubProtocolChanged", () => {
    expect(() => run((d) => {
      d.choices[id1].find((x) => x.is_final && x.number === 6).type_choice = "BanCharacter";
    })).toThrow(EsclubProtocolChanged);
  });
  it("a roster outside the series' teams -> EsclubProtocolChanged", () => {
    const d = clone(group);
    expect(() => N.normalizeSeries(input(d, { teams: [rosters[Object.keys(rosters)[2]], group.teams[0]] }))).toThrow(EsclubProtocolChanged);
  });
  it("a skipped ban anywhere in the draft is an empty slot; the rest of the game is unchanged", () => {
    const ref = N.normalizeSeries(input(group)).series.games[1];
    const placeholder = resources.find((x) => x.id_external === "-1").id_game_resource;
    for (const n of [3, 13, 15]) {
      const r = run((d) => { d.choices[id1].find((x) => x.is_final && x.number === n).id_game_resource = placeholder; });
      expect(r.failed).toEqual([]);
      const g = r.series.games[1];
      const slot = getPicksArrayIndex(n, g.firstPick);
      expect(g.picks[slot]).toBe("");
      expect(g.picks.map((p, i) => (i === slot ? ref.picks[i] : p))).toEqual(ref.picks);
      expect({ ...g, picks: ref.picks }).toEqual(ref);
    }
  });
  it("two skipped bans leave two empty slots", () => {
    const placeholder = resources.find((x) => x.id_external === "-1").id_game_resource;
    const r = run((d) => {
      for (const n of [0, 1]) d.choices[id1].find((x) => x.is_final && x.number === n).id_game_resource = placeholder;
    });
    expect(r.failed).toEqual([]);
    expect(r.series.games[1].picks.filter((p) => p === "")).toHaveLength(2);
  });
  it("a Placeholder pick fails that game only (EsclubUnknownChampion in failed), nothing blanked", () => {
    const r = run((d) => {
      const c = d.choices[id1].find((x) => x.is_final && x.number === 10);
      c.id_game_resource = resources.find((x) => x.id_external === "-1").id_game_resource;
    });
    expect(r.series.games.map((g) => g.number)).toEqual([0]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toBeInstanceOf(EsclubUnknownChampion);
    expect(r.failed[0].number).toBe(1);
  });
  it("an unknown numeric key fails that game", () => {
    const fake = { id_game_resource: "res-x", id_external: "999999", type_resource: "Character", name: "X" };
    const d = clone(group);
    d.choices[id1].find((x) => x.is_final && x.number === 10).id_game_resource = "res-x";
    const r = N.normalizeSeries(input(d, { resources: [...resources, fake] }));
    expect(r.failed.map((f) => f.number)).toEqual([1]);
  });
  it("winner_side 3 -> EsclubProtocolChanged", () => {
    expect(() => run((d) => { gm(d, 0).config.integrations[0].LeagueOfLegends.winner_side = 3; })).toThrow(EsclubProtocolChanged);
  });
  it("winner_side 2 -> red; null -> null", () => {
    const r = run((d) => { gm(d, 0).config.integrations[0].LeagueOfLegends.winner_side = 2; });
    expect(r.series.games[0].winner).toBe("red");
    const n = run((d) => { gm(d, 0).config.integrations[0].LeagueOfLegends.winner_side = null; });
    expect(n.series.games[0].winner).toBeNull();
  });
  it("is_done false -> winner null (even with winner_side set, or an odd one)", () => {
    const r = run((d) => {
      const l = gm(d, 0).config.integrations[0].LeagueOfLegends;
      l.is_done = false;
      l.winner_side = 1;
    });
    expect(r.series.games[0].winner).toBeNull();
  });
  it("lane mapping: null -> null, unknown string -> EsclubProtocolChanged", () => {
    const r = run((d) => { gm(d, 1).config.integrations[0].LeagueOfLegends.participants[0].lane_team = null; });
    expect(Object.values(r.series.games[1].participants).filter((p) => p.lane === null)).toHaveLength(1);
    expect(() => run((d) => { gm(d, 1).config.integrations[0].LeagueOfLegends.participants[0].lane_team = "Fill"; })).toThrow(EsclubProtocolChanged);
  });
  it("gameName and tagLine are both set or both null", () => {
    const r = run((d) => { gm(d, 1).config.integrations[0].LeagueOfLegends.participants[0].tag_riot = null; });
    const p = Object.values(r.series.games[1].participants).find((x) => x.gameName === null);
    expect(p.tagLine).toBeNull();
    expect(Object.values(r.series.games[1].participants).filter((x) => x.gameName === null)).toHaveLength(1);
  });
  it("time_start null -> playedAt null", () => {
    const r = run((d) => { gm(d, 1).time_start = null; });
    expect(r.series.games[1].playedAt).toBeNull();
  });
  it("games come out in number order whatever the input order", () => {
    const d = clone(group);
    d.matches.reverse();
    expect(N.normalizeSeries(input(d)).series.games.map((g) => g.number)).toEqual([0, 1]);
  });
  it("a match with no draft yet is pending", () => {
    const r = run((d) => { delete d.drafts[id1]; });
    expect(r.pending).toEqual([{ externalMatchId: id1, number: 1, reason: "no draft yet" }]);
  });
  it("blueSideTeam flips when the teams are given in the other order", () => {
    const d = clone(group);
    const r = N.normalizeSeries(input(d, { teams: [...group.teams].reverse() }));
    expect(r.series.games.map((g) => g.blueSideTeam)).toEqual([2, 2]);
  });
  it("a red-first-pick game places slots by getPicksArrayIndex", () => {
    // Flip every side everywhere: participants and the PickSide rows' sides.
    const r = run((d) => {
      for (const id of [id0, id1]) {
        gm(d, d.matches.find((m) => m.id_match === id).number).config.integrations[0].LeagueOfLegends.participants.forEach((p) => { p.side = p.side === 1 ? 2 : 1; });
        for (const c of d.choices[id]) {
          if (c.type_choice === "PickSide") {
            const cur = byRes.get(c.id_game_resource).id_external;
            c.id_game_resource = resources.find((x) => x.type_resource === "Side" && x.id_external !== cur).id_game_resource;
          }
        }
      }
    });
    for (const g of r.series.games) {
      expect(g.firstPick).toBe("red");
      expect(g.blueSideTeam).toBe(2);
      for (const c of group.choices[g.externalMatchId].filter((x) => x.is_final)) {
        expect(g.picks[getPicksArrayIndex(c.number, "red")]).toBe(championAliasForKey(byRes.get(c.id_game_resource).id_external));
      }
    }
  });
});
