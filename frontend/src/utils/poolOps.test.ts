import { describe, it, expect } from "vitest";
import {
    applyPoolChampionOp,
    applyPoolRoleOrder,
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

    // Was asserted as SETS before within-role ordering existed. Order is now
    // user-meaningful (priority/tier), so the diff has to reproduce `after`
    // EXACTLY — the sorted comparison would pass on a diff that scrambled
    // every bucket.
    it("replaying the diff over `before` reproduces `after` exactly, in order", () => {
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
        expect(replayed).toEqual(after);
    });

    it("a pure reorder emits one reorder op for that role and nothing else", () => {
        const after: RolePoolMap = { ...base(), top: ["Gnar", "Aatrox"] };
        expect(diffRolePoolMaps(base(), after)).toEqual([
            { type: "reorder", role: "top", championIds: ["Gnar", "Aatrox"] }
        ] satisfies PoolChampionOp[]);
    });

    it("membership changes that leave the surviving order intact emit no reorder", () => {
        // Removing Aatrox leaves [Gnar]; appending Ahri to mid leaves [Ahri].
        // Both match `after` already, so a reorder op would be redundant.
        const after: RolePoolMap = { ...base(), top: ["Gnar"], mid: ["Ahri"] };
        expect(diffRolePoolMaps(base(), after)).toEqual([
            { type: "remove", role: "top", championId: "Aatrox" },
            { type: "add", role: "mid", championId: "Ahri" }
        ] satisfies PoolChampionOp[]);
    });

    it("an add that must land mid-bucket emits the reorder after the add", () => {
        // add appends, so [Aatrox, Gnar] + Ahri = [Aatrox, Gnar, Ahri]; landing
        // Ahri in the middle needs the trailing reorder.
        const after: RolePoolMap = { ...base(), top: ["Aatrox", "Ahri", "Gnar"] };
        const ops = diffRolePoolMaps(base(), after);
        expect(ops).toEqual([
            { type: "add", role: "top", championId: "Ahri" },
            { type: "reorder", role: "top", championIds: ["Aatrox", "Ahri", "Gnar"] }
        ] satisfies PoolChampionOp[]);
        expect(ops.reduce(applyPoolChampionOp, base())).toEqual(after);
    });
});

describe("applyPoolRoleOrder", () => {
    it("permutes the named bucket to the given order", () => {
        const next = applyPoolRoleOrder(base(), "top", ["Gnar", "Aatrox"]);
        expect(next.top).toEqual(["Gnar", "Aatrox"]);
    });

    it("leaves every other bucket untouched", () => {
        const next = applyPoolRoleOrder(base(), "top", ["Gnar", "Aatrox"]);
        expect(next.jungle).toEqual(["LeeSin"]);
        expect(next.adc).toEqual(["Jinx"]);
    });

    // The whole reason order is a whole-bucket REPLACE rather than an index
    // move: a champion another client added while this reorder was in flight
    // must survive it. Index-based ops would have silently dropped them.
    it("appends bucket entries the op never mentioned (concurrent add survives)", () => {
        const withConcurrent = applyPoolChampionOp(base(), {
            type: "add",
            role: "top",
            championId: "Ahri"
        });
        const next = applyPoolRoleOrder(withConcurrent, "top", ["Gnar", "Aatrox"]);
        expect(next.top).toEqual(["Gnar", "Aatrox", "Ahri"]);
    });

    it("drops op entries no longer in the bucket (concurrent remove stays removed)", () => {
        const next = applyPoolRoleOrder(base(), "top", ["Gnar", "Ahri", "Aatrox"]);
        expect(next.top).toEqual(["Gnar", "Aatrox"]);
    });

    it("ignores duplicates in the op list", () => {
        const next = applyPoolRoleOrder(base(), "top", ["Gnar", "Gnar", "Aatrox"]);
        expect(next.top).toEqual(["Gnar", "Aatrox"]);
    });

    it("an empty order list leaves the bucket as-is", () => {
        expect(applyPoolRoleOrder(base(), "top", []).top).toEqual(["Aatrox", "Gnar"]);
    });

    it("never mutates its input", () => {
        const input = base();
        applyPoolRoleOrder(input, "top", ["Gnar", "Aatrox"]);
        expect(input).toEqual(base());
    });

    it("is reachable through applyPoolChampionOp's reorder case", () => {
        const next = applyPoolChampionOp(base(), {
            type: "reorder",
            role: "top",
            championIds: ["Gnar", "Aatrox"]
        });
        expect(next.top).toEqual(["Gnar", "Aatrox"]);
    });
});
