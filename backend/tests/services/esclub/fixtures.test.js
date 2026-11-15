import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "esclub");

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

function participantsOf(fixture) {
  return (fixture.reply.matches ?? []).flatMap((m) =>
    (m.config?.integrations ?? []).flatMap((i) => i.LeagueOfLegends?.participants ?? [])
  );
}

const load = (rel) => JSON.parse(readFileSync(join(DIR, rel), "utf8"));

describe("esclub fixtures are anonymised", () => {
  const all = files(DIR).map((path) => ({ path, fixture: JSON.parse(readFileSync(path, "utf8")) }));

  it("every fixture has the recorded shape", () => {
    expect(all.length).toBe(32);
    for (const { fixture } of all) {
      expect(typeof fixture.request).toBe("string");
      expect(fixture.context).toBeTypeOf("object");
      expect(fixture.reply).toBeTypeOf("object");
    }
  });

  it("player keys, Riot IDs, encryption keys and Riot match ids are fakes", () => {
    let participants = 0;
    for (const { fixture } of all) {
      for (const match of fixture.reply.matches ?? []) {
        for (const integration of match.config?.integrations ?? []) {
          const lol = integration.LeagueOfLegends;
          if (!lol) continue;
          if (lol.key_encryption !== null) expect(lol.key_encryption).toMatch(/^fake-key-\d+$/);
          expect(lol.id_game).toBeLessThan(1000);
          if (lol.code_tournament != null) expect(lol.code_tournament).toMatch(/^fake-code-\d+$/);
        }
      }
      for (const p of participantsOf(fixture)) {
        participants += 1;
        expect(p.id_oauth_riot).toMatch(/^fake-oauth-\d+$/);
        expect(p.id_oauth_riot).toHaveLength(78);
        if (p.name_riot_game !== null) expect(p.name_riot_game).toMatch(/^Player\d{2}$/);
        if (p.tag_riot !== null) expect(p.tag_riot).toMatch(/^T\d{2}$/);
      }
    }
    expect(participants).toBe(40);
  });

  it("no player field or PUUID-length string escapes anywhere in any fixture", () => {
    const PLAYER_KEYS = new Set(["id_oauth_riot", "name_riot_game", "tag_riot", "key_encryption"]);
    const offences = [];
    const scan = (value, key, path) => {
      if (Array.isArray(value)) return value.forEach((v, i) => scan(v, key, `${path}[${i}]`));
      if (value && typeof value === "object") {
        return Object.entries(value).forEach(([k, v]) => scan(v, k, `${path}.${k}`));
      }
      if (typeof value !== "string") return;
      if (key === "id_user" && !/^(fake-user-|synthetic-user-)/.test(value)) offences.push(path);
      if (key === "id_oauth_external" && !value.startsWith("synthetic-")) offences.push(path);
      if (PLAYER_KEYS.has(key) && !/^(fake-oauth-|fake-key-|Player\d{2}$|T\d{2}$)/.test(value)) {
        offences.push(path);
      }
      // Champion art paths under game resources' `assets` are public media keys.
      const isAsset = path.includes(".assets.");
      if (value.length >= 60 && !isAsset && !value.startsWith("fake-oauth-")) offences.push(path);
    };
    for (const { path, fixture } of all) scan(fixture, null, path);
    expect(offences).toEqual([]);
  });

  it("the same player keeps the same fake key and Riot ID across a series", () => {
    const [g0, g1] = load("group-bo3/matches.json").reply.matches.map(
      (m) => m.config.integrations[0].LeagueOfLegends.participants
    );
    const keys0 = new Set(g0.map((p) => p.id_oauth_riot));
    const shared = g1.filter((p) => keys0.has(p.id_oauth_riot));
    expect(shared.length).toBeGreaterThan(0);
    for (const p of shared) {
      const same = g0.find((q) => q.id_oauth_riot === p.id_oauth_riot);
      expect(p.name_riot_game).toBe(same?.name_riot_game);
    }
  });

  it("keeps null Riot IDs null (the bracket series predates them)", () => {
    const ps = participantsOf(load("bracket-bo3/matches.json"));
    expect(ps).toHaveLength(20);
    expect(ps.every((p) => p.name_riot_game === null && p.tag_riot === null)).toBe(true);
  });
});

describe("esclub member fixtures (S2)", () => {
  const rostersOf = (fixture) => [...new Set(fixture.reply.members.map((m) => m.id_parent))];

  it("every member user id is a fake, recorded or synthetic", () => {
    for (const rel of ["group-bo3/members.json", "bracket-bo3/members.json"]) {
      const members = load(rel).reply.members;
      expect(members.length).toBeGreaterThan(0);
      for (const m of members) expect(m.id_user).toMatch(/^fake-user-\d{2}$/);
    }
  });

  it("the recorded reply names the group Bo3's two rosters, the one that made choice 0 first", () => {
    const members = load("group-bo3/members.json");
    expect(members.request).toBe("fetch-members-by-serie");
    expect(members.context).toEqual({ id_serie: load("group-bo3/serie.json").context.id_serie });
    expect(members.synthetic).toBeUndefined();
    const finals = load("group-bo3/choices-0.json").reply.choices.filter((c) => c.is_final);
    const sources = new Set(finals.map((c) => c.id_team_roster_source));
    const rosters = rostersOf(members);
    expect(rosters).toHaveLength(2);
    expect(rosters.every((r) => sources.has(r))).toBe(true);
    const choice0 = finals.find((c) => c.number === 0);
    expect(rosters[0]).toBe(choice0?.id_team_roster_source);
  });

  it("member records carry only the six recorded keys", () => {
    for (const rel of ["group-bo3/members.json", "bracket-bo3/members.json"]) {
      for (const m of load(rel).reply.members) {
        expect(Object.keys(m).sort()).toEqual(["id_parent", "id_user", "time_end", "time_start", "type_member", "type_parent"]);
      }
    }
  });

  it("the bracket's members file is marked synthetic", () => {
    expect(typeof load("bracket-bo3/members.json").synthetic).toBe("string");
  });

  it("the recorded fetch-group reply has the sibling list's item shape", () => {
    const group = load("group.json");
    const sibling = load("groups-of-round.json").reply.groups[0];
    expect(group.request).toBe("fetch-group");
    expect(group.context).toEqual({ id_group: sibling.id_group });
    expect(Object.keys(group.reply.groups[0]).sort()).toEqual(Object.keys(sibling).sort());
  });
});


it("linked-account fixtures are explicitly synthetic, including all Discord data", () => {
  const oauths = load("riot-oauths.json");
  expect(oauths.synthetic).toBeTypeOf("string");
  expect(oauths.context.id_user).toMatch(/^synthetic-user-/);
  for (const item of oauths.reply.oauths) {
    expect(item.id_oauth_external).toMatch(/^synthetic-/);
    if (item.type_oauth === "Discord") expect(item.name).toMatch(/^synthetic-/);
  }
  expect(load("name-members.json").synthetic).toBeTypeOf("string");
});
