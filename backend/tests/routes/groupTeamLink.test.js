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

  describe("with the group's current links", () => {
    const current = { team1_id: "t-owner", team2_id: null };

    it("passes an unowned id equal to the current one in the same slot", () => {
      expect(
        resolveTeamLinkUpdate({ team1_id: "t-owner" }, owned, current),
      ).toEqual({ updates: { team1_id: "t-owner" } });
    });
    it("refuses an unowned id equal to the other slot's current id", () => {
      expect(
        resolveTeamLinkUpdate({ team2_id: "t-owner" }, owned, current).error,
      ).toBe("team2_id must reference a team you own");
    });
    it("refuses an unowned id that is not current", () => {
      expect(
        resolveTeamLinkUpdate({ team1_id: "t-other" }, owned, current).error,
      ).toBe("team1_id must reference a team you own");
    });
    it("still refuses a non-string", () => {
      expect(
        resolveTeamLinkUpdate({ team1_id: 5 }, owned, current).error,
      ).toBe("team1_id must be a team id string or null");
    });
  });
});
