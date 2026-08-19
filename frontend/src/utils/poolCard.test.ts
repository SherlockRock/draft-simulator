import { describe, it, expect } from "vitest";
import {
    flexRolesByChampion,
    poolChampionTotal,
    sanitizeAgainstCatalog
} from "./poolCard";
import type { RolePoolMap } from "@draft-sim/shared-types";

const map: RolePoolMap = {
    top: ["Aatrox", "Gnar"],
    jungle: ["Aatrox", "LeeSin"],
    mid: [],
    adc: ["Jinx"],
    support: ["Aatrox"]
};

describe("flexRolesByChampion", () => {
    it("maps only multi-bucket champions, roles in canonical order", () => {
        const flex = flexRolesByChampion(map);
        expect(flex.get("Aatrox")).toEqual(["top", "jungle", "support"]);
        expect(flex.has("Gnar")).toBe(false);
        expect(flex.has("LeeSin")).toBe(false);
    });
});

describe("poolChampionTotal", () => {
    it("counts unique champions — flex duplicates count once", () => {
        expect(poolChampionTotal(map)).toBe(4); // Aatrox, Gnar, LeeSin, Jinx
    });
    it("empty map counts zero", () => {
        expect(
            poolChampionTotal({ top: [], jungle: [], mid: [], adc: [], support: [] })
        ).toBe(0);
    });
});

describe("sanitizeAgainstCatalog", () => {
    // Lifted from SavedPoolDropdown.tsx (Task 9) — dropped-count semantics
    // preserved verbatim; this proves the lift didn't change behavior.
    it("keeps valid ids and drops unknown ones, reporting the dropped count", () => {
        const withStaleId: RolePoolMap = {
            top: ["Aatrox", "NotARealChampion12345"],
            jungle: ["LeeSin"],
            mid: [],
            adc: ["Jinx", "AlsoNotReal"],
            support: []
        };
        const result = sanitizeAgainstCatalog(withStaleId);
        expect(result.droppedCount).toBe(2);
        expect(result.champions.top).toEqual(["Aatrox"]);
        expect(result.champions.jungle).toEqual(["LeeSin"]);
        expect(result.champions.adc).toEqual(["Jinx"]);
        expect(result.champions.mid).toEqual([]);
        expect(result.champions.support).toEqual([]);
    });

    it("an all-valid map reports zero dropped and is unchanged", () => {
        const clean: RolePoolMap = {
            top: ["Aatrox"],
            jungle: ["LeeSin"],
            mid: [],
            adc: ["Jinx"],
            support: []
        };
        const result = sanitizeAgainstCatalog(clean);
        expect(result.droppedCount).toBe(0);
        expect(result.champions).toEqual(clean);
    });
});
