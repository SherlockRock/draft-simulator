import { describe, it, expect } from "vitest";
import { resolvePoolDrop } from "./poolDropResolver";
import { EMPTY_ROLE_POOL_MAP, applyPoolChampionOp } from "@draft-sim/shared-types";
import type { RolePoolMap } from "@draft-sim/shared-types";

const PLACEMENT_A = "placement-a";
const PLACEMENT_B = "placement-b";

const mapWith = (overrides: Partial<RolePoolMap>): RolePoolMap => ({
    ...EMPTY_ROLE_POOL_MAP,
    ...overrides
});

const row = (role: "top" | "jungle", index: number, placementId = PLACEMENT_A) =>
    ({ kind: "role-row" as const, placementId, role, index });

describe("resolvePoolDrop", () => {
    it("row -> other row (not already containing) resolves to a move: remove then add", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const targetChampions = mapWith({ top: ["Aatrox"], jungle: [] });

        const result = resolvePoolDrop({
            source,
            target: row("jungle", 0),
            targetChampions
        });

        expect(result).toEqual({
            kind: "move",
            ops: [
                { type: "remove", role: "top", championId: "Aatrox" },
                { type: "add", role: "jungle", championId: "Aatrox" }
            ]
        });
    });

    it("row -> same row at the same position resolves to none (unchanged)", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const targetChampions = mapWith({ top: ["Aatrox", "Gnar"] });

        expect(
            resolvePoolDrop({ source, target: row("top", 0), targetChampions })
        ).toEqual({ kind: "none" });
        // Index 1 is "before Gnar", which for a tile already at 0 is the same
        // arrangement — a no-op must not emit an op that churns the version.
        expect(
            resolvePoolDrop({ source, target: row("top", 1), targetChampions })
        ).toEqual({ kind: "none" });
    });

    it("row -> same row at a new position resolves to a reorder carrying the whole bucket", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const targetChampions = mapWith({ top: ["Aatrox", "Gnar", "Sett"] });

        const result = resolvePoolDrop({
            source,
            target: row("top", 2),
            targetChampions
        });

        expect(result).toEqual({
            kind: "reorder",
            ops: [{ type: "reorder", role: "top", championIds: ["Gnar", "Aatrox", "Sett"] }]
        });
    });

    it("dragging the last tile to the front reorders to exactly that", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Sett"
        };
        const targetChampions = mapWith({ top: ["Aatrox", "Gnar", "Sett"] });

        const result = resolvePoolDrop({
            source,
            target: row("top", 0),
            targetChampions
        });

        expect(result).toEqual({
            kind: "reorder",
            ops: [{ type: "reorder", role: "top", championIds: ["Sett", "Aatrox", "Gnar"] }]
        });
    });

    // The preview draws an insertion point, so the drop has to honour it —
    // `add` appends, so landing mid-bucket needs the trailing reorder or the
    // preview would be lying about where the champion ends up.
    it("row -> other row at a mid-bucket index appends then reorders to land there", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const targetChampions = mapWith({
            top: ["Aatrox"],
            jungle: ["LeeSin", "Vi"]
        });

        const result = resolvePoolDrop({
            source,
            target: row("jungle", 1),
            targetChampions
        });

        expect(result).toEqual({
            kind: "move",
            ops: [
                { type: "remove", role: "top", championId: "Aatrox" },
                { type: "add", role: "jungle", championId: "Aatrox" },
                {
                    type: "reorder",
                    role: "jungle",
                    championIds: ["LeeSin", "Aatrox", "Vi"]
                }
            ]
        });
        expect(
            result.kind === "move" ? result.ops.reduce(applyPoolChampionOp, targetChampions) : null
        ).toEqual(mapWith({ top: [], jungle: ["LeeSin", "Aatrox", "Vi"] }));
    });

    it("row -> other row at the END needs no reorder, since add already appends", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const targetChampions = mapWith({
            top: ["Aatrox"],
            jungle: ["LeeSin", "Vi"]
        });

        const result = resolvePoolDrop({
            source,
            target: row("jungle", 2),
            targetChampions
        });

        expect(result).toEqual({
            kind: "move",
            ops: [
                { type: "remove", role: "top", championId: "Aatrox" },
                { type: "add", role: "jungle", championId: "Aatrox" }
            ]
        });
    });

    it("row -> row already containing the champion removes from the source and repositions in the target", () => {
        // Aatrox is flexed into both top and jungle; dragging the top tile onto
        // the jungle row must not double it into jungle — but it must still
        // land where it was dropped.
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const targetChampions = mapWith({
            top: ["Aatrox"],
            jungle: ["LeeSin", "Aatrox"]
        });

        const result = resolvePoolDrop({
            source,
            target: row("jungle", 0),
            targetChampions
        });

        expect(result).toEqual({
            kind: "move",
            ops: [
                { type: "remove", role: "top", championId: "Aatrox" },
                {
                    type: "reorder",
                    role: "jungle",
                    championIds: ["Aatrox", "LeeSin"]
                }
            ]
        });
    });

    it("row -> row already containing it, dropped where it already sits, is just the remove", () => {
        const source = {
            placementId: PLACEMENT_A,
            role: "top" as const,
            championId: "Aatrox"
        };
        const targetChampions = mapWith({
            top: ["Aatrox"],
            jungle: ["LeeSin", "Aatrox"]
        });

        const result = resolvePoolDrop({
            source,
            target: row("jungle", 2),
            targetChampions
        });

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
        const targetChampions = mapWith({ top: [] });

        const result = resolvePoolDrop({
            source,
            target: row("top", 0, PLACEMENT_B),
            targetChampions
        });

        expect(result).toEqual({ kind: "none" });
    });
});
