import { describe, expect, test } from "vitest";
import type { NavigatorWeightedAssignment } from "../contexts/NavigatorContext";
import item5 from "./__fixtures__/navigator-item5-snapshot.json";
import item4 from "./__fixtures__/navigator-item4-snapshot.json";
import { NavigatorTreeNodeSchema } from "./navigatorTreeSchema";
import {
    NON_LISTED_FACTOR,
    PRIMARY_FACTOR,
    SECONDARY_FACTOR,
    emptyFanReason,
    formatRoleGap,
    listedAssignments,
    positionFactor,
    roleGap,
    roleLineForPick,
    roleOf,
    roleShift,
    solveRoles,
    topAssignment
} from "./navigatorRoles";

const RED_TOUR = ["Sejuani", "Sylas", "Lissandra", "Tristana"];
const BLUE_TOUR = ["Gragas", "Hecarim", "Akali", "Xayah", "Shen"];
const RED_ITEM4 = ["Ornn", "Sylas", "TwistedFate", "Ezreal"];
const BLUE_ITEM4 = ["Camille", "Elise", "Mel", "Xayah", "Sona"];
const RED_ITEM7 = ["Rengar", "Nidalee", "Yone", "Ezreal"];

const KEYS = ["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"];
function assignmentKey(w: NavigatorWeightedAssignment): string {
    return KEYS.map((k) => {
        if (k === "TOP") return `TOP=${w.assignment.TOP}`;
        if (k === "JUNGLE") return `JUNGLE=${w.assignment.JUNGLE}`;
        if (k === "MIDDLE") return `MIDDLE=${w.assignment.MIDDLE}`;
        if (k === "ADC") return `ADC=${w.assignment.ADC}`;
        return `SUPPORT=${w.assignment.SUPPORT}`;
    }).join(",");
}
/** Set equality on (assignment, weight) with |Δweight| < 1e-12 (design § 5). */
function expectSameDistribution(
    mine: NavigatorWeightedAssignment[],
    theirs: NavigatorWeightedAssignment[]
) {
    expect(mine.length).toBe(theirs.length);
    const byKey = new Map(mine.map((w) => [assignmentKey(w), w.weight]));
    expect(byKey.size).toBe(mine.length);
    for (const w of theirs) {
        const weight = byKey.get(assignmentKey(w));
        expect(weight, assignmentKey(w)).toBeDefined();
        expect(Math.abs((weight ?? NaN) - w.weight)).toBeLessThan(1e-12);
    }
}

describe("fixtures are the wire shape", () => {
    test("item5 and item4 trees parse under the tree schema", () => {
        expect(NavigatorTreeNodeSchema.parse(item5.tree).children).toHaveLength(8);
        expect(NavigatorTreeNodeSchema.parse(item4.tree).children).toHaveLength(8);
    });
});

describe("solveRoles — engine parity (role_solver.rs)", () => {
    test("constants match role_solver.rs", () => {
        expect([PRIMARY_FACTOR, SECONDARY_FACTOR, NON_LISTED_FACTOR]).toEqual([
            1.0, 0.4, 0.01
        ]);
        expect(positionFactor("support", ["support", "top"])).toBe(1.0);
        expect(positionFactor("top", ["support", "top"])).toBe(0.4);
        expect(positionFactor("adc", ["support", "top"])).toBe(0.01);
    });
    test("returns [] for 0 or more than 5 champions", () => {
        expect(solveRoles([])).toEqual([]);
        expect(solveRoles(["Ahri", "Ahri", "Ahri", "Ahri", "Ahri", "Ahri"])).toEqual([]);
    });
    test("P(5, n) entries, weights sum to 1", () => {
        expect(solveRoles(["Pantheon"]).length).toBe(5);
        expect(solveRoles(["Pantheon", "Ahri"]).length).toBe(20);
        const five = solveRoles(BLUE_TOUR);
        expect(five.length).toBe(120);
        expect(Math.abs(five.reduce((s, w) => s + w.weight, 0) - 1)).toBeLessThan(1e-12);
    });
    test("item5: every scenario's red and blue likely assignments", () => {
        expect(item5.scenarios.length).toBe(5);
        for (const scenario of item5.scenarios) {
            expectSameDistribution(
                solveRoles([...RED_TOUR, ...scenario.redPicks]),
                scenario.redLikelyAssignments
            );
            expectSameDistribution(
                solveRoles([...BLUE_TOUR, ...scenario.bluePicks]),
                scenario.blueLikelyAssignments
            );
        }
    });
    test("item4: every scenario's red and blue likely assignments", () => {
        expect(item4.scenarios.length).toBe(5);
        for (const scenario of item4.scenarios) {
            expectSameDistribution(
                solveRoles([...RED_ITEM4, ...scenario.redPicks]),
                scenario.redLikelyAssignments
            );
            expectSameDistribution(
                solveRoles([...BLUE_ITEM4, ...scenario.bluePicks]),
                scenario.blueLikelyAssignments
            );
        }
    });
});

describe("topAssignment / roleOf / roleShift", () => {
    test("tour red 4 picks", () => {
        const top = topAssignment(RED_TOUR);
        expect(top).not.toBeNull();
        expect(top && roleOf(top.assignment, "Sejuani")).toBe("jungle");
        expect(top && roleOf(top.assignment, "Sylas")).toBe("mid");
        expect(top && roleOf(top.assignment, "Lissandra")).toBe("top");
        expect(top && roleOf(top.assignment, "Tristana")).toBe("adc");
        expect(top && roleOf(top.assignment, "Pantheon")).toBeNull();
    });
    test("Pantheon fills support without moving anyone", () => {
        expect(roleShift(RED_TOUR, [...RED_TOUR, "Pantheon"])).toBeNull();
    });
    test("Gangplank takes top and moves Sylas mid → support", () => {
        expect(roleShift(RED_TOUR, [...RED_TOUR, "Gangplank"])).toEqual({
            championId: "Sylas",
            from: "mid",
            to: "support"
        });
    });
    test("topAssignment of [] is null", () => {
        expect(topAssignment([])).toBeNull();
    });
});

describe("roleLineForPick (design § 2 role line)", () => {
    test("single pick node", () => {
        expect(roleLineForPick(RED_TOUR, ["Pantheon"])).toEqual({
            roles: ["support"],
            shift: null
        });
        const gp = roleLineForPick(RED_TOUR, ["Gangplank"]);
        expect(gp.roles).toEqual(["top"]);
        expect(gp.shift).toEqual({ championId: "Sylas", from: "mid", to: "support" });
    });
    test("pair node reports both roles", () => {
        const line = roleLineForPick(["Gragas"], ["Hecarim", "Akali"]);
        expect(line.roles).toEqual(["jungle", "mid"]);
    });
    test("a confirmed half already in the side picks is not double counted", () => {
        const line = roleLineForPick(["Gragas", "Hecarim"], ["Hecarim", "Akali"]);
        expect(line.roles).toEqual(["jungle", "mid"]);
    });
    test("a non-empty wire distribution wins over the local solve, by max weight not by position", () => {
        const wire: NavigatorWeightedAssignment[] = [
            {
                assignment: {
                    TOP: "Lissandra",
                    JUNGLE: "Sejuani",
                    MIDDLE: "Sylas",
                    ADC: "Tristana",
                    SUPPORT: "Pantheon"
                },
                weight: 0.2
            },
            {
                assignment: {
                    TOP: "Pantheon",
                    JUNGLE: "Sejuani",
                    MIDDLE: "Lissandra",
                    ADC: "Tristana",
                    SUPPORT: "Sylas"
                },
                weight: 0.8
            }
        ];
        const line = roleLineForPick(RED_TOUR, ["Pantheon"], wire);
        expect(line.roles).toEqual(["top"]);
        expect(line.shift).toEqual({ championId: "Sylas", from: "mid", to: "support" });
    });
});

describe("roleGap — feasibility.rs semantics (listed roles only)", () => {
    test("tour state at Red Pick 4: red needs ADC + one of the rest; blue needs ADC + Sup", () => {
        expect(roleGap(["Sejuani", "Sylas", "Lissandra"])).toEqual({
            feasible: true,
            must: ["adc"],
            maybe: ["top", "jungle", "mid", "support"]
        });
        expect(roleGap(["Gragas", "Hecarim", "Akali"])).toEqual({
            feasible: true,
            must: ["adc", "support"],
            maybe: []
        });
    });
    test("five feasible picks cover everything", () => {
        expect(roleGap(BLUE_TOUR)).toEqual({ feasible: true, must: [], maybe: [] });
    });
    test("item7 red is infeasible (two jungle-only picks)", () => {
        expect(roleGap(RED_ITEM7).feasible).toBe(false);
        expect(listedAssignments(RED_ITEM7)).toEqual([]);
    });
    test("item4 red: jungle or support still open", () => {
        expect(roleGap(RED_ITEM4)).toEqual({
            feasible: true,
            must: [],
            maybe: ["jungle", "support"]
        });
    });
    test("zero picks: every role open in every assignment", () => {
        expect(roleGap([])).toEqual({
            feasible: true,
            must: ["top", "jungle", "mid", "adc", "support"],
            maybe: []
        });
    });
});

describe("formatRoleGap / emptyFanReason (design § 4 strings)", () => {
    test("must joined with +, maybe joined with or", () => {
        expect(formatRoleGap(roleGap(["Sejuani", "Sylas", "Lissandra"]), 3)).toBe(
            "ADC + Top or Jg or Mid or Sup"
        );
        expect(formatRoleGap(roleGap(["Gragas", "Hecarim", "Akali"]), 3)).toBe(
            "ADC + Sup"
        );
        expect(formatRoleGap(roleGap(BLUE_TOUR), 5)).toBe("all five covered");
        expect(formatRoleGap(roleGap(RED_ITEM7), 4)).toBe("cannot complete five roles");
        expect(formatRoleGap(roleGap([]), 0)).toBe("all five open");
    });
    test("names the first infeasible side with its picks, else the pool hint", () => {
        const nameOf = (id: string) => id;
        expect(
            emptyFanReason(
                ["Jayce", "Diana", "Talon", "Jhin", "Xerath"],
                RED_ITEM7,
                nameOf
            )
        ).toBe("red cannot fill five roles with Rengar, Nidalee, Yone, Ezreal");
        expect(emptyFanReason(BLUE_TOUR, RED_TOUR, nameOf)).toBe(
            "engine returned no candidates — check the search pool"
        );
    });
});
