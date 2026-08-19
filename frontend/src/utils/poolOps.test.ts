import { describe, it, expect } from "vitest";
import {
    applyPoolChampionOp,
    diffRolePoolMaps,
    type PoolChampionOp
} from "@draft-sim/shared-types";
import type { RolePoolMap } from "@draft-sim/shared-types";

const base = (): RolePoolMap => ({
    top: ["Aatrox", "Gnar"],
    jungle: ["LeeSin"],
    mid: [],
    adc: ["Jinx"],
    support: []
});

describe("applyPoolChampionOp", () => {
    it("adds to the named bucket only, at the end", () => {
        const next = applyPoolChampionOp(base(), {
            type: "add",
            role: "mid",
            championId: "Ahri"
        });
        expect(next.mid).toEqual(["Ahri"]);
        expect(next.top).toEqual(["Aatrox", "Gnar"]);
    });

    // Idempotency (D4): the RESTRICTIVE half — a blind append would fail this.
    it("add dedupes: re-adding an existing champion changes nothing", () => {
        const next = applyPoolChampionOp(base(), {
            type: "add",
            role: "top",
            championId: "Aatrox"
        });
        expect(next).toEqual(base());
    });

    it("flex is a second add in another bucket, not a move", () => {
        const next = applyPoolChampionOp(base(), {
            type: "add",
            role: "jungle",
            championId: "Aatrox"
        });
        expect(next.jungle).toEqual(["LeeSin", "Aatrox"]);
        expect(next.top).toContain("Aatrox");
    });

    it("removes only the named bucket's entry", () => {
        const flexed = applyPoolChampionOp(base(), {
            type: "add",
            role: "jungle",
            championId: "Aatrox"
        });
        const next = applyPoolChampionOp(flexed, {
            type: "remove",
            role: "top",
            championId: "Aatrox"
        });
        expect(next.top).toEqual(["Gnar"]);
        expect(next.jungle).toContain("Aatrox");
    });

    it("remove of a missing champion is a no-op", () => {
        const next = applyPoolChampionOp(base(), {
            type: "remove",
            role: "mid",
            championId: "Ahri"
        });
        expect(next).toEqual(base());
    });

    it("never mutates its input", () => {
        const input = base();
        applyPoolChampionOp(input, { type: "add", role: "mid", championId: "Ahri" });
        expect(input).toEqual(base());
    });
});

describe("diffRolePoolMaps", () => {
    it("emits removes before adds, role-major in top/jungle/mid/adc/support order", () => {
        const after: RolePoolMap = {
            top: ["Gnar"], // removed Aatrox
            jungle: ["LeeSin"],
            mid: ["Ahri"], // added Ahri
            adc: ["Jinx", "Kaisa"], // added Kaisa
            support: []
        };
        expect(diffRolePoolMaps(base(), after)).toEqual([
            { type: "remove", role: "top", championId: "Aatrox" },
            { type: "add", role: "mid", championId: "Ahri" },
            { type: "add", role: "adc", championId: "Kaisa" }
        ] satisfies PoolChampionOp[]);
    });

    it("identical maps diff to zero ops", () => {
        expect(diffRolePoolMaps(base(), base())).toEqual([]);
    });

    it("replaying the diff over `before` reproduces `after` as sets", () => {
        const after: RolePoolMap = {
            top: [],
            jungle: ["Vi"],
            mid: ["Ahri"],
            adc: ["Jinx"],
            support: ["Thresh"]
        };
        let replayed = base();
        for (const op of diffRolePoolMaps(base(), after)) {
            replayed = applyPoolChampionOp(replayed, op);
        }
        for (const role of ["top", "jungle", "mid", "adc", "support"] as const) {
            expect([...replayed[role]].sort()).toEqual([...after[role]].sort());
        }
    });
});
