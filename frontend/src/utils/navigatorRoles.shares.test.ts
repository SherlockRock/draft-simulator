import { describe, expect, test, vi } from "vitest";
import type { NavigatorWeightedAssignment } from "../contexts/NavigatorContext";

// champion-role-shares slice B: the engine-parity pin of the SHARE-RATIO path. The two snapshots
// were captured by scripts/model/capture_navigator_parity_snapshots.cjs from the engine-node
// binding built on this branch, on the 2026-10-10 table (five-role shares + playable) — the same
// two smoke states navigatorRoles.test.ts reads on the 2026-09-05 table, where every champion
// falls back to the category factors. Both pins stay: that file proves the fallback branch, this
// one the ratio. `redLikelyAssignments` / `blueLikelyAssignments` are role_solver::solve's output
// for the side's picks after the scenario's leaf picks; |Δweight| < 1e-12 is the parity bound
// (design § 5) — the TypeScript and the Rust compute the factor in the same operation order, so a
// disagreement is an order change on one side, never a tolerance question.
vi.mock("../data/champions.json", async () => ({
    default: (await import("./__fixtures__/champions-2026-10-10-shares.json")).default
}));
import item4 from "./__fixtures__/navigator-item4-shares-snapshot.json";
import item5 from "./__fixtures__/navigator-item5-shares-snapshot.json";
import { getChampionShares } from "./championRoles";
import { NavigatorTreeNodeSchema } from "./navigatorTreeSchema";
import { SHARE_EPSILON, positionFactor, solveRoles } from "./navigatorRoles";

const RED_TOUR = ["Sejuani", "Sylas", "Lissandra", "Tristana"];
const BLUE_TOUR = ["Gragas", "Hecarim", "Akali", "Xayah", "Shen"];
const RED_ITEM4 = ["Ornn", "Sylas", "TwistedFate", "Ezreal"];
const BLUE_ITEM4 = ["Camille", "Elise", "Mel", "Xayah", "Sona"];

function assignmentKey(w: NavigatorWeightedAssignment): string {
    const a = w.assignment;
    return `TOP=${a.TOP},JUNGLE=${a.JUNGLE},MIDDLE=${a.MIDDLE},ADC=${a.ADC},SUPPORT=${a.SUPPORT}`;
}
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

describe("the captures are the wire shape, from the shares table", () => {
    test("item5 and item4 trees parse under the tree schema; the table carries the shares", () => {
        // Five root children, not the 2026-09-05 captures' eight: at these two slot-19 states the
        // four support specialists bucket-2 appends are already the top of the fan once a support
        // filed under SUPPORT scores ×1.0 whatever its first listed position (task 2).
        expect(NavigatorTreeNodeSchema.parse(item5.tree).children).toHaveLength(5);
        expect(NavigatorTreeNodeSchema.parse(item4.tree).children).toHaveLength(5);
        expect(item5.scenarios).toHaveLength(5);
        expect(item4.scenarios).toHaveLength(5);
        // Sylas on 16.19: JUNGLE 0.455 / MIDDLE 0.407 / TOP 0.067 / SUPPORT 0.066 / BOTTOM 0.005,
        // listed JUNGLE and MIDDLE — his MIDDLE factor is 0.895, not 0.4; TOP 0.147, not 0.01.
        expect(getChampionShares("Sylas")).toEqual({
            top: 0.067,
            jungle: 0.455,
            mid: 0.407,
            adc: 0.005,
            support: 0.066
        });
        expect(positionFactor("jungle", "Sylas")).toBe(1.0);
        expect(positionFactor("mid", "Sylas")).toBe(
            Math.max(0.407, SHARE_EPSILON) / 0.455
        );
        expect(positionFactor("top", "Sylas")).toBe(
            Math.max(0.067, SHARE_EPSILON) / 0.455
        );
        expect(positionFactor("adc", "Sylas")).toBe(
            Math.max(0.005, SHARE_EPSILON) / 0.455
        );
    });
});

describe("solveRoles — engine parity (role_solver.rs) on the shares table", () => {
    test("item5: every scenario's red and blue likely assignments", () => {
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
    test("the distributions are not the category ones: a secondary weighs its ratio", () => {
        // Pantheon (TOP 0.392 / SUPPORT 0.376) on the tour's red side: under the category factors
        // his support placements summed to a 0.4-weighted share of the mass; under the ratio they
        // sum to 0.959 of his top placements' mass — the parity above is of THIS distribution.
        const weighted = solveRoles([...RED_TOUR, "Pantheon"]);
        const mass = (role: "TOP" | "SUPPORT") =>
            weighted
                .filter((w) => w.assignment[role] === "Pantheon")
                .reduce((s, w) => s + w.weight, 0);
        expect(mass("SUPPORT") / mass("TOP")).toBeGreaterThan(0.5);
    });
});
