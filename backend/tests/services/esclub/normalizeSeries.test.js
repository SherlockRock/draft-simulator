import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const N = require("../../../services/esclub/normalize");
const { EsclubProtocolChanged, EsclubUnsupported } = require("../../../services/esclub/errors");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/esclub");
const fx = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")).reply;

const rosters = fx("team-rosters.json").teams.map(N.normalizeTeamRoster);
const teams = [rosters[0], rosters[1]];

function input(dir, extra = {}) {
  const serie = fx(`${dir}/serie.json`).series[0];
  return { serie, seasonId: "season-1", stageId: "stage-1", teams, matches: [], drafts: {}, choices: {}, resources: [], ...extra };
}
function draftsOf(dir) {
  const out = {};
  for (const n of [0, 1]) {
    const d = fx(`${dir}/draft-${n}.json`).drafts[0];
    out[d.id_match] = d;
  }
  return out;
}

describe("normalizeStatus", () => {
  it.each([
    ["InitiatePending", "upcoming"], ["InitiateDefault", "upcoming"],
    ["StartPending", "upcoming"], ["StartDefault", "upcoming"],
    ["TerminatePending", "in_progress"], ["TerminateDefault", "in_progress"],
    ["EndPending", "in_progress"], ["EndDefault", "in_progress"],
    ["FinalizePending", "in_progress"], ["FinalizeDefault", "in_progress"],
    ["Finished", "finished"],
  ])("%s -> %s", (v, want) => expect(N.normalizeStatus(v)).toBe(want));

  it.each(["Cancelled", "", null, undefined, "finished", "toString", "__proto__"])("%s is a protocol change", (v) => {
    expect(() => N.normalizeStatus(v)).toThrow(EsclubProtocolChanged);
  });
});

describe("normalizeDraftType", () => {
  it("maps HardPick and None", () => {
    expect(N.normalizeDraftType("HardPick")).toBe("fearless");
    expect(N.normalizeDraftType("None")).toBe("standard");
  });
  it.each(["SoftPick", "SoftBan", "SoftBoth", "HardBan", "HardBoth", "Other", null, "toString"])("%s is unsupported", (v) => {
    expect(() => N.normalizeDraftType(v)).toThrow(EsclubUnsupported);
  });
});

describe("normalizeTeamRoster", () => {
  it("reads acronym and palette from extra", () => {
    const row = fx("team-rosters.json").teams[0];
    expect(N.normalizeTeamRoster(row)).toEqual({
      externalId: row.id_team_roster,
      externalOrgId: row.id_team_organisation,
      name: row.name,
      acronym: row.extra.acronym,
      palette: { primary: row.extra.palette.primary, secondary: row.extra.palette.secondary },
    });
  });
  it("gives null acronym and palette when extra has none", () => {
    expect(N.normalizeTeamRoster({ id_team_roster: "r", id_team_organisation: "o", name: "X", extra: {} })).toEqual({
      externalId: "r", externalOrgId: "o", name: "X", acronym: null, palette: null,
    });
  });
});

describe("normalizeSeries", () => {
  it("normalises the group Bo3", () => {
    const inp = input("group-bo3", { drafts: draftsOf("group-bo3") });
    const { series, pending, skipped } = N.normalizeSeries(inp);
    expect(series).toMatchObject({
      source: "esclub",
      externalId: "11f1c28a-af6b-071b-93aa-058d0cf4fd47",
      seasonId: "season-1",
      stageId: "stage-1",
      status: "finished",
      bestOf: 3,
      draftType: "fearless",
      startsAt: new Date(1794366000 * 1000).toISOString(), // time_start_agreed
      teams,
      games: [],
    });
    expect(pending).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("normalises the bracket Bo3 (forced start time wins)", () => {
    const { series } = N.normalizeSeries(input("bracket-bo3", { drafts: draftsOf("bracket-bo3") }));
    expect(series).toMatchObject({
      externalId: "11f18dd3-3fd7-6e6c-9281-a4e63dbef157",
      status: "finished",
      bestOf: 3,
      draftType: "fearless",
      startsAt: new Date(1787270422 * 1000).toISOString(),
    });
  });

  it("falls back agreed -> default -> null for the start time", () => {
    const base = input("group-bo3").serie;
    const at = (o) => N.normalizeSeries(input("group-bo3", { serie: { ...base, time_start_forced: null, time_start_agreed: null, time_start_default: null, ...o } })).series.startsAt;
    expect(at({ time_start_default: 60 })).toBe("1970-01-01T00:01:00.000Z");
    expect(at({ time_start_agreed: 60, time_start_default: 120 })).toBe("1970-01-01T00:01:00.000Z");
    expect(at({ time_start_forced: 0, time_start_agreed: 60 })).toBe("1970-01-01T00:00:00.000Z");
    expect(at({})).toBeNull();
  });

  it("has draftType null with no drafts", () => {
    expect(N.normalizeSeries(input("group-bo3")).series.draftType).toBeNull();
  });

  it("rejects drafts of different types", () => {
    const d = draftsOf("group-bo3");
    const [a, b] = Object.keys(d);
    d[b] = { ...d[b], type_fearless: "None" };
    expect(a).not.toBe(b);
    expect(() => N.normalizeSeries(input("group-bo3", { drafts: d }))).toThrow(EsclubProtocolChanged);
  });

  it("fails on an unsupported draft type and an unknown status", () => {
    const d = draftsOf("group-bo3");
    const k = Object.keys(d)[0];
    d[k] = { ...d[k], type_fearless: "SoftPick" };
    expect(() => N.normalizeSeries(input("group-bo3", { drafts: d }))).toThrow(EsclubUnsupported);
    const base = input("group-bo3");
    expect(() => N.normalizeSeries({ ...base, serie: { ...base.serie, awaiting_status: "Weird" } })).toThrow(EsclubProtocolChanged);
  });

  it("needs two distinct teams", () => {
    expect(() => N.normalizeSeries(input("group-bo3", { teams: [teams[0], teams[0]] }))).toThrow(EsclubProtocolChanged);
    expect(() => N.normalizeSeries(input("group-bo3", { teams: [teams[0]] }))).toThrow(EsclubProtocolChanged);
  });
});
