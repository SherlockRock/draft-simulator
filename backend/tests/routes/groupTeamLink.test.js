import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Team = require("../../models/Team");
const {
  resolveTeamLinkUpdate,
  loadLinkableTeamIds,
} = require("../../routes/canvas");

const linkable = new Set(["team-a", "team-b"]);

describe("resolveTeamLinkUpdate", () => {
  it("ignores absent team fields", () => {
    expect(resolveTeamLinkUpdate({}, linkable)).toEqual({ updates: {} });
  });
  it("links a linkable team", () => {
    expect(resolveTeamLinkUpdate({ team1_id: "team-a" }, linkable)).toEqual({
      updates: { team1_id: "team-a" },
    });
  });
  it("unlinks with null", () => {
    expect(resolveTeamLinkUpdate({ team2_id: null }, linkable)).toEqual({
      updates: { team2_id: null },
    });
  });
  it("handles both fields at once", () => {
    expect(
      resolveTeamLinkUpdate({ team1_id: "team-a", team2_id: null }, linkable),
    ).toEqual({ updates: { team1_id: "team-a", team2_id: null } });
  });
  it("rejects a team the user cannot link", () => {
    expect(resolveTeamLinkUpdate({ team1_id: "team-x" }, linkable).error).toBe(
      "team1_id must reference a team you can link",
    );
  });
  it("rejects a non-string, non-null team id", () => {
    expect(resolveTeamLinkUpdate({ team1_id: 5 }, linkable).error).toBeTruthy();
  });

  describe("with the group's current links", () => {
    const current = { team1_id: "t-owner", team2_id: null };

    it("passes an unlinkable id equal to the current one in the same slot", () => {
      expect(
        resolveTeamLinkUpdate({ team1_id: "t-owner" }, linkable, current),
      ).toEqual({ updates: { team1_id: "t-owner" } });
    });
    it("refuses an unlinkable id equal to the other slot's current id", () => {
      expect(
        resolveTeamLinkUpdate({ team2_id: "t-owner" }, linkable, current).error,
      ).toBe("team2_id must reference a team you can link");
    });
    it("refuses an unlinkable id that is not current", () => {
      expect(
        resolveTeamLinkUpdate({ team1_id: "t-other" }, linkable, current).error,
      ).toBe("team1_id must reference a team you can link");
    });
    it("still refuses a non-string", () => {
      expect(
        resolveTeamLinkUpdate({ team1_id: 5 }, linkable, current).error,
      ).toBe("team1_id must be a team id string or null");
    });
  });
});

describe("loadLinkableTeamIds", () => {
  const A = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const C = "33333333-3333-4333-8333-333333333333";
  const tx = { id: "tx" };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("makes one Team query for exactly the new ids, inside the transaction", async () => {
    const findAll = vi.spyOn(Team, "findAll").mockResolvedValue([
      { id: A, source: "manual", owner_id: "u1" },
      { id: B, source: "esclub", owner_id: null },
    ]);

    const ids = await loadLinkableTeamIds(
      { team1_id: A, team2_id: B },
      { team1_id: null, team2_id: null },
      "u1",
      tx,
    );

    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: [A, B] }, transaction: tx }),
    );
    expect(ids).toEqual(new Set([A, B]));
  });

  it("leaves a pass-through id (same slot) out of the query", async () => {
    const findAll = vi
      .spyOn(Team, "findAll")
      .mockResolvedValue([{ id: B, source: "esclub", owner_id: null }]);

    const ids = await loadLinkableTeamIds(
      { team1_id: A, team2_id: B },
      { team1_id: A, team2_id: null },
      "u1",
      tx,
    );

    expect(findAll.mock.calls[0][0].where).toEqual({ id: [B] });
    expect(ids).toEqual(new Set([B]));
  });

  it("asks the id in the other slot (a swap) like any new id", async () => {
    const findAll = vi.spyOn(Team, "findAll").mockResolvedValue([
      { id: A, source: "manual", owner_id: "someone-else" },
    ]);

    const ids = await loadLinkableTeamIds(
      { team1_id: null, team2_id: A },
      { team1_id: A, team2_id: null },
      "u1",
      tx,
    );

    expect(findAll.mock.calls[0][0].where).toEqual({ id: [A] });
    expect(ids.has(A)).toBe(false);
  });

  it("drops someone else's pickup team (seen only through a canvas)", async () => {
    vi.spyOn(Team, "findAll").mockResolvedValue([
      { id: C, source: "manual", owner_id: "someone-else" },
    ]);
    const ids = await loadLinkableTeamIds({ team1_id: C }, {}, "u1", tx);
    expect(ids.size).toBe(0);
  });

  it("does not query for null, absent, unchanged or malformed ids", async () => {
    const findAll = vi.spyOn(Team, "findAll");
    const ids = await loadLinkableTeamIds(
      { team1_id: null, team2_id: "not-a-uuid" },
      { team1_id: A },
      "u1",
      tx,
    );
    expect(findAll).not.toHaveBeenCalled();
    expect(ids.size).toBe(0);
  });
});
