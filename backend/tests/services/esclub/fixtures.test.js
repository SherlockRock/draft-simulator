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
    expect(all.length).toBe(26);
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
