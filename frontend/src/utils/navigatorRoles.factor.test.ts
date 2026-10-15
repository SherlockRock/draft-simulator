import { describe, expect, test, vi } from "vitest";

// champion-role-shares design § 6 (D8 / U3): the frontend's `positionFactor` is role_solver.rs's —
// `max(share, ε) / max(shares)` for EVERY role, one max then one division, the category factors
// only without shares. A synthetic table, because the real one has no row whose first listed
// position is NOT its largest share (an override may produce one — design § 4.1) and no all-zero
// row (the loaders refuse one; a hand-written table could still carry it).
vi.mock("../data/champions.json", () => ({
    default: {
        champions: [
            // Pantheon on 16.19 (TOP 0.392 / SUPPORT 0.376, the near-tie that flipped a primary),
            // its positions REORDERED by an override: SUPPORT first, TOP's share larger.
            {
                id: "Pantheon",
                name: "Pantheon",
                positions: ["SUPPORT", "TOP"],
                positionShares: {
                    TOP: 0.392,
                    JUNGLE: 0.1,
                    MIDDLE: 0.05,
                    BOTTOM: 0,
                    SUPPORT: 0.376
                },
                playable: ["SUPPORT", "TOP", "JUNGLE"]
            },
            {
                id: "Jinx",
                name: "Jinx",
                positions: ["BOTTOM"],
                positionShares: { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 1, SUPPORT: 0 },
                playable: ["BOTTOM"]
            },
            {
                id: "Ashe",
                name: "Ashe",
                positions: ["BOTTOM"],
                positionShares: { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 1, SUPPORT: 0 },
                playable: ["BOTTOM"]
            },
            // A hand row: listed positions, no shares.
            { id: "Yone", name: "Yone", positions: ["MIDDLE", "TOP"] },
            // An all-zero row the loaders would refuse (a real name: constants.ts joins the table
            // to its generated champion list by name, so an invented one has no positions).
            {
                id: "Zoe",
                name: "Zoe",
                positions: ["MIDDLE"],
                positionShares: { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, SUPPORT: 0 }
            }
        ]
    }
}));
import { getChampionShares } from "./championRoles";
import {
    SHARE_EPSILON,
    positionFactor,
    solveRoles,
    topAssignment
} from "./navigatorRoles";

describe("positionFactor — role_solver.rs position_factor (champion-role-shares § 6)", () => {
    test("the share over the largest share, floored at ε, for every role", () => {
        expect(SHARE_EPSILON).toBe(0.001);
        expect(positionFactor("top", "Pantheon")).toBe(1.0);
        expect(positionFactor("support", "Pantheon")).toBe(
            Math.max(0.376, SHARE_EPSILON) / 0.392
        );
        expect(positionFactor("jungle", "Pantheon")).toBe(
            Math.max(0.1, SHARE_EPSILON) / 0.392
        );
        // An UNLISTED role reads its ratio too, never a category ...
        expect(positionFactor("mid", "Pantheon")).toBe(
            Math.max(0.05, SHARE_EPSILON) / 0.392
        );
        // ... and a never-played role weighs ε / max — never 0.
        expect(positionFactor("adc", "Pantheon")).toBe(SHARE_EPSILON / 0.392);
        expect(positionFactor("adc", "Pantheon")).toBeGreaterThan(0);
    });
    test("the denominator is the largest share, not the first listed position's", () => {
        // SUPPORT is listed first; the factor still peaks at 1.0 — at TOP — and never exceeds it.
        expect(getChampionShares("Pantheon")?.support).toBe(0.376);
        for (const role of ["top", "jungle", "mid", "adc", "support"] as const) {
            expect(positionFactor(role, "Pantheon")).toBeLessThanOrEqual(1.0);
        }
        expect(positionFactor("support", "Pantheon")).toBeLessThan(1.0);
    });
    test("no shares, or all-zero shares, read the category factors over the listed positions", () => {
        expect(getChampionShares("Yone")).toBeNull();
        expect(positionFactor("mid", "Yone")).toBe(1.0);
        expect(positionFactor("top", "Yone")).toBe(0.4);
        expect(positionFactor("adc", "Yone")).toBe(0.01);
        expect(positionFactor("mid", "Zoe")).toBe(1.0);
        expect(positionFactor("top", "Zoe")).toBe(0.01);
        expect(positionFactor("top", "Nobody")).toBe(0.01);
    });
    test("two pure marksmen still normalise and the top assignment is the first enumerated", () => {
        // Every assignment seats one of them off-role at ε: the weights still sum to 1, eight
        // assignments tie at the maximum and the first in enumeration order wins — Jinx TOP, Ashe
        // ADC (role_solver.rs's test of the same name).
        const weights = solveRoles(["Jinx", "Ashe"]).map((w) => w.weight);
        expect(Math.abs(weights.reduce((s, w) => s + w, 0) - 1)).toBeLessThan(1e-12);
        const max = Math.max(...weights);
        expect(weights.filter((w) => w === max)).toHaveLength(8);
        const top = topAssignment(["Jinx", "Ashe"]);
        expect(top?.assignment.TOP).toBe("Jinx");
        expect(top?.assignment.ADC).toBe("Ashe");
    });
    test("a shares-unknown champion beside a shared one keeps its category factors", () => {
        // Pantheon MID (0.05 / 0.392) + Yone TOP (0.4) vs Pantheon TOP (1.0) + Yone MID (1.0).
        const weights = solveRoles(["Pantheon", "Yone"]);
        const weight = (top: string, mid: string) =>
            weights.find((w) => w.assignment.TOP === top && w.assignment.MIDDLE === mid)
                ?.weight ?? NaN;
        const ratio = weight("Yone", "Pantheon") / weight("Pantheon", "Yone");
        expect(Math.abs(ratio - (0.05 / 0.392) * 0.4)).toBeLessThan(1e-12);
    });
});
