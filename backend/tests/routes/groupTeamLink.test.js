import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveTeamLinkUpdate } = require("../../routes/canvas");

const owned = new Set(["team-a", "team-b"]);

describe("resolveTeamLinkUpdate", () => {
  it("ignores absent team fields", () => {
    expect(resolveTeamLinkUpdate({}, owned)).toEqual({ updates: {} });
  });
  it("links an owned team", () => {
    expect(resolveTeamLinkUpdate({ team1_id: "team-a" }, owned)).toEqual({
      updates: { team1_id: "team-a" },
    });
  });
  it("unlinks with null", () => {
    expect(resolveTeamLinkUpdate({ team2_id: null }, owned)).toEqual({
      updates: { team2_id: null },
    });
  });
  it("handles both fields at once", () => {
    expect(
      resolveTeamLinkUpdate({ team1_id: "team-a", team2_id: null }, owned),
    ).toEqual({ updates: { team1_id: "team-a", team2_id: null } });
  });
  it("rejects a team the user does not own", () => {
    expect(resolveTeamLinkUpdate({ team1_id: "team-x" }, owned).error).toBe(
      "team1_id must reference a team you own",
    );
  });
  it("rejects a non-string, non-null team id", () => {
    expect(resolveTeamLinkUpdate({ team1_id: 5 }, owned).error).toBeTruthy();
  });
});
