import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { Op } from "sequelize";

const require = createRequire(import.meta.url);
const { Canvas, UserCanvas, CanvasGroup } = require("../../models/Canvas");
const sequelize = require("../../config/database");
const setupAssociations = require("../../models/associations");
const {
  visibleTeamsWhere,
  canSeeTeam,
  canLinkTeam,
  canEditRoster,
  assertTeamInvariants,
  TeamInvariantError,
} = require("../../services/teamAccess");

const pickup = (overrides = {}) => ({
  id: "team-1",
  source: "manual",
  owner_id: "user-1",
  tournament_id: null,
  ...overrides,
});
const imported = (overrides = {}) => ({
  id: "team-2",
  source: "esclub",
  owner_id: null,
  tournament_id: "t-1",
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("visibleTeamsWhere", () => {
  it("matches imported teams or the user's own", () => {
    expect(visibleTeamsWhere("user-1")).toEqual({
      [Op.or]: [{ source: "esclub" }, { owner_id: "user-1" }],
    });
  });

  it.each([null, undefined, ""])("matches nothing for %j", (userId) => {
    expect(visibleTeamsWhere(userId)).toEqual({ id: null });
  });
});

describe("canSeeTeam", () => {
  it("skips the canvas query when the owner asks", async () => {
    const spy = vi.spyOn(CanvasGroup, "findOne");
    expect(await canSeeTeam(pickup(), "user-1")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips the canvas query for an imported team and any signed-in user", async () => {
    const spy = vi.spyOn(CanvasGroup, "findOne");
    expect(await canSeeTeam(imported(), "user-9")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is false for anonymous without querying", async () => {
    const spy = vi.spyOn(CanvasGroup, "findOne");
    expect(await canSeeTeam(imported(), null)).toBe(false);
    expect(await canSeeTeam(pickup(), undefined)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs one query for someone else's pickup team and builds the expected where", async () => {
    const spy = vi.spyOn(CanvasGroup, "findOne").mockResolvedValue({ id: "g" });
    const tx = { id: "tx" };
    expect(await canSeeTeam(pickup(), "user-2", { transaction: tx })).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      attributes: ["id"],
      where: { [Op.or]: [{ team1_id: "team-1" }, { team2_id: "team-1" }] },
      include: [
        {
          model: Canvas,
          required: true,
          attributes: [],
          include: [
            {
              model: UserCanvas,
              required: true,
              attributes: [],
              where: { user_id: "user-2" },
            },
          ],
        },
      ],
      subQuery: false,
      transaction: tx,
    });
  });

  // Makes Sequelize render the real SQL with sequelize.query stubbed, so no
  // connection is ever opened. The options-only test above let an invalid
  // LIMIT-subquery shape through (nested hasMany include + findOne).
  describe("generated SQL", () => {
    it("is one inner-join query, with LIMIT 1 at the outer level", async () => {
      expect(sequelize.getDialect()).toBe("postgres");
      setupAssociations();
      const query = vi.spyOn(sequelize, "query").mockResolvedValue(null);
      const authenticate = vi.spyOn(sequelize, "authenticate");

      expect(await canSeeTeam(pickup(), "user-2")).toBe(false);

      expect(authenticate).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
      const sql = query.mock.calls[0][0];
      expect(typeof sql).toBe("string");
      expect(sql).toMatch(/^SELECT .* FROM "CanvasGroups" AS "CanvasGroup"/s);
      expect(sql).not.toMatch(/FROM \(SELECT/);
      expect(sql).toMatch(/INNER JOIN "Canvases" AS "Canvas" ON/);
      expect(sql).toMatch(/INNER JOIN "UserCanvases" AS "Canvas->UserCanvases"/);
      expect(sql).toMatch(/"Canvas->UserCanvases"\."user_id" = 'user-2'/);
      expect(sql).toMatch(/"CanvasGroup"\."team1_id" = 'team-1'/);
      expect(sql).toMatch(/"CanvasGroup"\."team2_id" = 'team-1'/);
      expect(sql).toMatch(/LIMIT 1;?$/);
    });
  });

  it("is false when no linked group is on one of the user's canvases", async () => {
    vi.spyOn(CanvasGroup, "findOne").mockResolvedValue(null);
    expect(await canSeeTeam(pickup(), "user-2")).toBe(false);
  });
});

describe("canLinkTeam", () => {
  it("allows the owner of a pickup team", () => {
    expect(canLinkTeam(pickup(), "user-1")).toBe(true);
  });
  it("allows any signed-in user for an imported team", () => {
    expect(canLinkTeam(imported(), "user-9")).toBe(true);
  });
  it("refuses someone else's pickup team", () => {
    expect(canLinkTeam(pickup(), "user-2")).toBe(false);
  });
  it.each([null, undefined])("refuses %j, even for an imported team", (u) => {
    expect(canLinkTeam(imported(), u)).toBe(false);
    expect(canLinkTeam(pickup({ owner_id: null }), u)).toBe(false);
  });
});

describe("canEditRoster", () => {
  it("allows the owner of a manual team", () => {
    expect(canEditRoster(pickup(), "user-1")).toBe(true);
  });
  it("refuses another user", () => {
    expect(canEditRoster(pickup(), "user-2")).toBe(false);
  });
  it("refuses an imported team for everyone", () => {
    expect(canEditRoster(imported(), "user-1")).toBe(false);
    expect(canEditRoster(imported(), "user-9")).toBe(false);
  });
  it("refuses an esclub team even if it wrongly has an owner", () => {
    expect(canEditRoster(imported({ owner_id: "user-1" }), "user-1")).toBe(false);
  });
  it("refuses a missing user, including when owner_id is null", () => {
    expect(canEditRoster(pickup(), null)).toBe(false);
    expect(canEditRoster(pickup({ owner_id: null }), undefined)).toBe(false);
  });
});

describe("assertTeamInvariants", () => {
  const tournament = (source, id = "t-1") => ({ id, source });

  it("accepts a pickup team with no tournament", () => {
    expect(() => assertTeamInvariants(pickup(), null)).not.toThrow();
    expect(() => assertTeamInvariants(pickup(), undefined)).not.toThrow();
  });
  it("accepts an esclub team with no owner in an esclub tournament", () => {
    expect(() => assertTeamInvariants(imported(), tournament("esclub"))).not.toThrow();
  });
  it("accepts a manual team in a manual tournament", () => {
    expect(() =>
      assertTeamInvariants(pickup({ tournament_id: "t-1" }), tournament("manual")),
    ).not.toThrow();
  });

  const codeOf = (fn) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(TeamInvariantError);
      return e.code;
    }
    return null;
  };

  it("rejects an esclub team with an owner", () => {
    expect(
      codeOf(() =>
        assertTeamInvariants(imported({ owner_id: "user-1" }), tournament("esclub")),
      ),
    ).toBe("ESCLUB_TEAM_HAS_OWNER");
  });
  it("rejects an esclub team with no tournament", () => {
    expect(
      codeOf(() => assertTeamInvariants(imported({ tournament_id: null }), null)),
    ).toBe("ESCLUB_TEAM_NEEDS_ESCLUB_TOURNAMENT");
  });
  it("rejects an esclub team in a manual tournament", () => {
    expect(codeOf(() => assertTeamInvariants(imported(), tournament("manual")))).toBe(
      "ESCLUB_TEAM_NEEDS_ESCLUB_TOURNAMENT",
    );
  });
  it("rejects a manual team in an esclub tournament", () => {
    expect(
      codeOf(() =>
        assertTeamInvariants(pickup({ tournament_id: "t-1" }), tournament("esclub")),
      ),
    ).toBe("MANUAL_TEAM_NEEDS_MANUAL_TOURNAMENT");
  });
  it("rejects a tournament_id with no tournament", () => {
    expect(
      codeOf(() => assertTeamInvariants(pickup({ tournament_id: "t-1" }), null)),
    ).toBe("TOURNAMENT_MISMATCH");
  });
  it("rejects a tournament whose id differs from tournament_id", () => {
    expect(
      codeOf(() =>
        assertTeamInvariants(
          pickup({ tournament_id: "t-1" }),
          tournament("manual", "t-2"),
        ),
      ),
    ).toBe("TOURNAMENT_MISMATCH");
  });
  it("rejects a tournament passed for a team with no tournament_id", () => {
    expect(
      codeOf(() => assertTeamInvariants(pickup(), tournament("manual"))),
    ).toBe("TOURNAMENT_MISMATCH");
  });
  it("rejects an unknown source", () => {
    expect(codeOf(() => assertTeamInvariants(pickup({ source: "x" }), null))).toBe(
      "UNKNOWN_SOURCE",
    );
  });
});
