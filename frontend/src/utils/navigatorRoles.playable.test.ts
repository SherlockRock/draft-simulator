import { describe, expect, test, vi } from "vitest";

// champion-role-shares design § 5.2 (D9): the gap strip follows the engine's prune — `playable`,
// the listed roles plus every role above the refresh's pick-count floor — and `must` / `maybe`
// are read over the playable assignments with the MOST listed placements. These pins encode
// the 16.19 table the refresh wrote on 2026-10-10 (Kai'Sa playable top/jungle/mid, Ashe playable
// support, Jhin playable top/mid, Jinx bottom alone), so they read that FROZEN copy; the live
// file follows the latest patch and would move them every refresh. The sister file
// navigatorRoles.test.ts keeps the 2026-09-05 table (no `playable`), where every function below
// falls back to the listed roles and the engine-parity snapshots were recorded.
vi.mock("../data/champions.json", async () => ({
    default: (await import("./__fixtures__/champions-2026-10-10-shares.json")).default
}));
import {
    getChampionPlayable,
    getChampionRoles,
    getChampionShares
} from "./championRoles";
import {
    emptyFanReason,
    formatRoleGap,
    playableAssignments,
    roleGap,
    roleLineForPick,
    solveRoles
} from "./navigatorRoles";

const RED_TOUR = ["Sejuani", "Sylas", "Lissandra", "Tristana"];

describe("getChampionPlayable / getChampionShares (championRoles.ts)", () => {
    test("playable is the engine's legality set; positions stay the UI's set", () => {
        expect(getChampionRoles("Kaisa")).toEqual(["adc"]);
        expect(getChampionPlayable("Kaisa")).toEqual(["top", "jungle", "mid", "adc"]);
        expect(getChampionRoles("Jinx")).toEqual(["adc"]);
        expect(getChampionPlayable("Jinx")).toEqual(["adc"]);
        expect(getChampionPlayable("Ashe")).toEqual(["adc", "support"]);
        expect(getChampionPlayable("Nobody")).toEqual([]);
    });
    test("shares carry all five roles, 3 dp, keyed by Role; the largest is the denominator", () => {
        expect(getChampionShares("Kaisa")).toEqual({
            top: 0.019,
            jungle: 0.006,
            mid: 0.017,
            adc: 0.957,
            support: 0.001
        });
        expect(getChampionShares("Jinx")).toEqual({
            top: 0,
            jungle: 0,
            mid: 0.001,
            adc: 0.998,
            support: 0
        });
        expect(getChampionShares("Nobody")).toBeNull();
    });
});

describe("playableAssignments / roleGap — D9 over the maximally listed playable assignments", () => {
    test("Jinx + Kai'Sa: two bottom-listed picks are feasible through Kai'Sa's playable roles", () => {
        // Today's listed-only strip said "cannot complete five roles" here; v1.0's rule would have
        // said "all five covered". The listed count is 1 (Jinx) in every playable assignment, so all
        // three are maximal: support is open in each (must), top/jungle/mid in some (maybe).
        expect(playableAssignments(["Jinx", "Kaisa"])).toEqual([
            ["adc", "top"],
            ["adc", "jungle"],
            ["adc", "mid"]
        ]);
        expect(roleGap(["Jinx", "Kaisa"])).toEqual({
            feasible: true,
            must: ["support"],
            maybe: ["top", "jungle", "mid"]
        });
        expect(formatRoleGap(roleGap(["Jinx", "Kaisa"]), 2)).toBe(
            "Sup + Top or Jg or Mid"
        );
    });
    test("Jinx + Ashe: feasible only through Ashe at support — the real hole is top + jungle + mid", () => {
        expect(roleGap(["Jinx", "Ashe"])).toEqual({
            feasible: true,
            must: ["top", "jungle", "mid"],
            maybe: []
        });
        expect(formatRoleGap(roleGap(["Jinx", "Ashe"]), 2)).toBe("Top + Jg + Mid");
    });
    test("four bottom-listed picks (Jinx, Kai'Sa, Jhin, Ashe): one of top / jungle / mid stays open", () => {
        expect(roleGap(["Jinx", "Kaisa", "Jhin", "Ashe"])).toEqual({
            feasible: true,
            must: [],
            maybe: ["top", "jungle", "mid"]
        });
    });
    test("where a listed assignment exists the lists are today's: the tour's Red needs Sup", () => {
        // Sejuani jungle, Sylas mid, Lissandra top, Tristana adc is fully listed, so the wider
        // playable assignments (Sylas support, Lissandra support …) are not maximal and do not widen
        // the strip.
        expect(roleGap(RED_TOUR)).toEqual({
            feasible: true,
            must: ["support"],
            maybe: []
        });
        expect(formatRoleGap(roleGap(RED_TOUR), 4)).toBe("Sup");
        expect(roleGap(["Sejuani", "Sylas", "Lissandra"])).toEqual({
            feasible: true,
            must: ["adc", "support"],
            maybe: []
        });
    });
    test("the named residual (judge r1 M1): Draven + Ryze + Kai'Sa + Veigar reads a firm Sup", () => {
        // The single maximally listed assignment is Draven adc, Ryze top, Veigar mid and Kai'Sa
        // JUNGLE (her 0.6% role), so the strip says "Sup". It hides Veigar support + Draven top +
        // Kai'Sa adc — 3.3× the share product, Jungle open. D9 is kept (wrong on ≈ 6% of the real
        // listed-infeasible sides against ≈ 32% for a share tie-break); this pins the residual.
        expect(roleGap(["Draven", "Ryze", "Kaisa", "Veigar"])).toEqual({
            feasible: true,
            must: ["support"],
            maybe: []
        });
    });
    test("still infeasible: two picks playable in one role only", () => {
        expect(playableAssignments(["Jinx", "Aphelios"])).toEqual([]);
        expect(roleGap(["Jinx", "Aphelios"]).feasible).toBe(false);
        expect(formatRoleGap(roleGap(["Jinx", "Aphelios"]), 2)).toBe(
            "cannot complete five roles"
        );
    });
    test("emptyFanReason follows the prune: Jinx + Kai'Sa is no longer the named reason", () => {
        const nameOf = (id: string) => id;
        expect(emptyFanReason(["Jinx", "Kaisa"], ["Jinx", "Aphelios"], nameOf)).toBe(
            "red cannot fill five roles with Jinx, Aphelios"
        );
        expect(emptyFanReason(["Jinx", "Kaisa"], ["Jinx", "Ashe"], nameOf)).toBe(
            "engine returned no candidates — check the search pool"
        );
    });
});

describe("the slice-A artefact resolved (design § 5 / § 6): the role line reads the shares", () => {
    test("Jinx + Ashe: the line seats Ashe at support — the role the strip is feasible through", () => {
        // In slice A both were bottom-listed category 1.0s, every other placement weighed 0.01, and
        // the line took the first of eight ties: Jinx TOP, Ashe ADC — a role the strip called
        // `must`. With the shares (Jinx BOTTOM 0.998, Ashe BOTTOM 0.926 / SUPPORT 0.057) Ashe at
        // support outweighs every alternative: one maximum, no shift. Pinned as printed.
        const line = roleLineForPick(["Jinx"], ["Ashe"]);
        expect(line.roles).toEqual(["support"]);
        expect(line.shift).toBeNull();
        expect(roleGap(["Jinx", "Ashe"]).must).toEqual(["top", "jungle", "mid"]);
        const weights = solveRoles(["Jinx", "Ashe"]).map((w) => w.weight);
        expect(weights.filter((w) => w === Math.max(...weights))).toHaveLength(1);
        expect(Math.max(...weights)).toBeCloseTo(0.7130358485836049, 12);
    });
});
