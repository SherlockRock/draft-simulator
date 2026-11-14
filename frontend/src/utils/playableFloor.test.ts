import { describe, expect, test, vi } from "vitest";

// Engine slice B (design F2, F11, T32): the 2 % own-games floor on `playable`, as the frontend's
// prune mirror reads it. The values are the 2026-11-12 floored table, so this reads that FROZEN copy
// (a byte copy of the committed champions.json); the live file's shape is playableFloor.live.test.ts.
// A separate file because one that mocks ../data/champions.json cannot also import the live file.
vi.mock("../data/champions.json", async () => ({
    default: (await import("./__fixtures__/champions-2026-11-12-floor.json")).default
}));
import { getChampionPlayable } from "./championRoles";
import { roleGap } from "./navigatorRoles";

describe("the floored playable set (frozen 2026-11-12)", () => {
    test("Lee Sin is jungle alone: his top (1.4 %) and mid (0.7 %) are under the floor", () => {
        expect(getChampionPlayable("LeeSin")).toEqual(["jungle"]);
    });

    test("Jinx + Kai'Sa cannot fill five roles: Kai'Sa's top (1.9 %) is under the floor", () => {
        expect(getChampionPlayable("Kaisa")).toEqual(["adc"]);
        expect(roleGap(["Jinx", "Kaisa"]).feasible).toBe(false);
    });

    test("Galio support, Locke adc and Locke top stay", () => {
        expect(getChampionPlayable("Galio")).toContain("support");
        expect(getChampionPlayable("Locke")).toContain("adc");
        expect(getChampionPlayable("Locke")).toContain("top");
    });
});
