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

// ---------------------------------------------------------------------------
// Task 6: the visibility matrix (design decisions 6-10, fix 4/5, D4/Q4).
// Expected values are written out literally below; nothing is computed from the
// functions under test. Each cell is its own `it`.
//
// Notes on scope:
// - "list" is eligibility for the user's lists (visibleTeamsWhere). GET
//   /api/teams narrows it further (Q2: owned non-archived pickup teams + teams
//   of the user's non-archived tournaments); Task 7's route tests cover that.
// - "link" is a NEW link onto a group. Passing an unchanged id through on the
//   same canvas is T0's rule in resolveTeamLinkUpdate, tested in Task 7.
// - "link-elsewhere" is the canvas member linking the team on a different
//   canvas. It pins fix 4: canvas-derived read never grants link.
// - Anonymous is false everywhere. Public-share canvas payloads are unchanged
//   and not widened by this module.
// ---------------------------------------------------------------------------
describe("visibility matrix", () => {
  const OWNER = "owner";
  const OTHER = "other";
  const MEMBER = "member";
  const ACTORS = {
    owner: OWNER,
    "other signed-in user": OTHER,
    "canvas member": MEMBER,
    anonymous: null,
  };
  const CELLS = ["list", "read", "link", "link-elsewhere", "roster read", "roster edit"];

  const TEAMS = {
    "pickup (owned)": {
      id: "m-1",
      source: "manual",
      owner_id: OWNER,
      tournament_id: null,
    },
    "pickup (someone else's)": {
      id: "m-2",
      source: "manual",
      owner_id: "stranger",
      tournament_id: null,
    },
    imported: {
      id: "m-3",
      source: "esclub",
      owner_id: null,
      tournament_id: "esclub-t",
    },
    "manual-tournament team": {
      id: "m-4",
      source: "manual",
      owner_id: OWNER,
      tournament_id: "manual-t",
    },
  };

  // [list, read, link, link-elsewhere, roster read, roster edit]
  const T = true;
  const F = false;
  const EXPECTED = {
    "pickup (owned)": {
      owner: [T, T, T, T, T, T],
      "other signed-in user": [F, F, F, F, F, F],
      "canvas member": [F, T, F, F, T, F],
      anonymous: [F, F, F, F, F, F],
    },
    // The actor "owner" does not own this team, so owner = no rights.
    "pickup (someone else's)": {
      owner: [F, F, F, F, F, F],
      "other signed-in user": [F, F, F, F, F, F],
      "canvas member": [F, T, F, F, T, F],
      anonymous: [F, F, F, F, F, F],
    },
    // Any signed-in user sees and links it; nobody edits it (fix 5).
    imported: {
      owner: [T, T, T, T, T, F],
      "other signed-in user": [T, T, T, T, T, F],
      "canvas member": [T, T, T, T, T, F],
      anonymous: [F, F, F, F, F, F],
    },
    // D4/Q4: owner-only, like a pickup team.
    "manual-tournament team": {
      owner: [T, T, T, T, T, T],
      "other signed-in user": [F, F, F, F, F, F],
      "canvas member": [F, T, F, F, T, F],
      anonymous: [F, F, F, F, F, F],
    },
  };

  // Exactly the shapes visibleTeamsWhere can produce: Op.or of equality
  // objects, or { id: null }.
  const matches = (where, team) =>
    Reflect.ownKeys(where).every((key) =>
      key === Op.or
        ? where[Op.or].some((clause) => matches(clause, team))
        : team[key] === where[key],
    );

  // Mocked canvas lookup: a link is found exactly when the actor is the member
  // of the canvas the team is linked on.
  const mockCanvasLookup = () =>
    vi.spyOn(CanvasGroup, "findOne").mockImplementation(async (options) => {
      const userId = options.include[0].include[0].where.user_id;
      return userId === MEMBER ? { id: "group-1" } : null;
    });

  const cases = [];
  for (const [kind, team] of Object.entries(TEAMS)) {
    for (const [actor, userId] of Object.entries(ACTORS)) {
      CELLS.forEach((cell, i) => {
        cases.push({
          name: `${kind} × ${actor} × ${cell} → ${EXPECTED[kind][actor][i] ? "✔" : "✘"}`,
          kind,
          actor,
          cell,
          team,
          userId,
          expected: EXPECTED[kind][actor][i],
        });
      });
    }
  }

  it("covers every cell: 4 kinds × 4 actors × 6 cells = 96", () => {
    expect(Object.keys(TEAMS)).toHaveLength(4);
    expect(Object.keys(ACTORS)).toHaveLength(4);
    expect(CELLS).toHaveLength(6);
    for (const kind of Object.keys(TEAMS)) {
      expect(Object.keys(EXPECTED[kind]).sort()).toEqual(Object.keys(ACTORS).sort());
      for (const actor of Object.keys(ACTORS)) {
        expect(EXPECTED[kind][actor]).toHaveLength(CELLS.length);
      }
    }
    expect(cases).toHaveLength(96);
    expect(new Set(cases.map((c) => c.name)).size).toBe(96);
  });

  it.each(cases)("$name", async ({ cell, team, userId, expected }) => {
    if (cell === "list") {
      expect(matches(visibleTeamsWhere(userId), team)).toBe(expected);
    } else if (cell === "read" || cell === "roster read") {
      const spy = mockCanvasLookup();
      expect(await canSeeTeam(team, userId)).toBe(expected);
      // The canvas query is made only when own right does not already decide:
      // never for anonymous, owners or esclub teams.
      const ownRight = userId !== null && (team.source === "esclub" || team.owner_id === userId);
      expect(spy).toHaveBeenCalledTimes(userId === null || ownRight ? 0 : 1);
    } else if (cell === "link" || cell === "link-elsewhere") {
      const spy = mockCanvasLookup();
      expect(canLinkTeam(team, userId)).toBe(expected);
      expect(spy).not.toHaveBeenCalled();
    } else {
      expect(canEditRoster(team, userId)).toBe(expected);
    }
  });
});
