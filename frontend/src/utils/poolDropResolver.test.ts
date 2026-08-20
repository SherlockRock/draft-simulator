import { describe, it, expect } from "vitest";
import { resolvePoolDrop } from "./poolDropResolver";
import { EMPTY_ROLE_POOL_MAP } from "@draft-sim/shared-types";
import type { RolePoolMap } from "@draft-sim/shared-types";

const PLACEMENT_A = "placement-a";
const PLACEMENT_B = "placement-b";

const mapWith = (overrides: Partial<RolePoolMap>): RolePoolMap => ({
    ...EMPTY_ROLE_POOL_MAP,
    ...overrides
});

describe("resolvePoolDrop", () => {
    it("row -> other row (not already containing) resolves to a move: remove then add", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const target = {
            kind: "role-row" as const,
            placementId: PLACEMENT_A,
            role: "jungle" as const
        };
        const targetChampions = mapWith({ top: ["Aatrox"], jungle: [] });

        const result = resolvePoolDrop({ source, target, targetChampions });

        expect(result).toEqual({
            kind: "move",
            ops: [
                { type: "remove", role: "top", championId: "Aatrox" },
                { type: "add", role: "jungle", championId: "Aatrox" }
            ]
        });
    });

    it("row -> same row resolves to none (unchanged)", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const target = {
            kind: "role-row" as const,
            placementId: PLACEMENT_A,
            role: "top" as const
        };
        const targetChampions = mapWith({ top: ["Aatrox"] });

        const result = resolvePoolDrop({ source, target, targetChampions });

        expect(result).toEqual({ kind: "none" });
    });

    it("row -> row already containing the champion resolves to remove only (the add would dedupe)", () => {
        // Aatrox is flexed into both top and jungle already; dragging the top
        // tile onto the jungle row must not double the champion into jungle —
        // the preview (and the outcome) is just the removal from top.
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const target = {
            kind: "role-row" as const,
            placementId: PLACEMENT_A,
            role: "jungle" as const
        };
        const targetChampions = mapWith({ top: ["Aatrox"], jungle: ["Aatrox"] });

        const result = resolvePoolDrop({ source, target, targetChampions });

        expect(result).toEqual({
            kind: "remove",
            ops: [{ type: "remove", role: "top", championId: "Aatrox" }]
        });
    });

    it("row -> off-card resolves to remove", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const target = { kind: "off-card" as const };
        const targetChampions = mapWith({ top: ["Aatrox"] });

        const result = resolvePoolDrop({ source, target, targetChampions });

        expect(result).toEqual({
            kind: "remove",
            ops: [{ type: "remove", role: "top", championId: "Aatrox" }]
        });
    });

    it("cross-CARD drag (different placementId) resolves to none — pool-to-pool transfer is deferred", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const target = {
            kind: "role-row" as const,
            placementId: PLACEMENT_B,
            role: "top" as const
        };
        const targetChampions = mapWith({ top: [] });

        const result = resolvePoolDrop({ source, target, targetChampions });

        expect(result).toEqual({ kind: "none" });
    });
});
