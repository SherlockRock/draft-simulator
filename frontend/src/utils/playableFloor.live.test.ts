import { describe, expect, test } from "vitest";
import champions from "../data/champions.json";

// Engine slice B (design F2, T32): the live champions.json, read plainly (the frozen values are in
// playableFloor.test.ts). Shape only: no non-listed playable role is stored below the floor. The
// floor is read from `positionsSource.playableRule.minOwnShare`; a file without the rule or without
// `minOwnShare` (a later `--source ugg` refresh omits both) passes vacuously, and says so.
type Row = {
    id: string;
    positions?: string[];
    playable?: string[];
    positionShares?: Record<string, number>;
};
const rows = champions.champions as unknown as Row[];
const source = (
    champions as unknown as {
        positionsSource?: { playableRule?: { minOwnShare?: number } };
    }
).positionsSource;
const floor = source?.playableRule?.minOwnShare;

describe("the live champions.json's own-games floor", () => {
    test("no non-listed playable role is stored under playableRule.minOwnShare", () => {
        if (typeof floor !== "number") {
            // Vacuous: champions.json carries no playableRule.minOwnShare (a later `--source ugg` refresh).
            return;
        }
        let checked = 0;
        for (const row of rows) {
            if (
                !row.playable ||
                !row.positionShares ||
                Object.keys(row.positionShares).length !== 5
            )
                continue;
            for (const role of row.playable) {
                if ((row.positions ?? []).includes(role)) continue;
                expect(
                    row.positionShares[role],
                    `${row.id} ${role}`
                ).toBeGreaterThanOrEqual(floor);
                checked += 1;
            }
        }
        expect(checked).toBeGreaterThan(0);
    });
});
