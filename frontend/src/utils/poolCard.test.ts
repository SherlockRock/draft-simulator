import { describe, it, expect } from "vitest";
import { flexRolesByChampion, poolChampionTotal } from "./poolCard";
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
