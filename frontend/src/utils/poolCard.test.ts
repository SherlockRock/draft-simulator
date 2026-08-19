import { describe, it, expect, vi } from "vitest";
import {
    commitPoolDrag,
    commitPoolNameEdit,
    commitPoolRename,
    flexRolesByChampion,
    poolChampionTotal,
    poolDragPosition,
    poolGrabOffset,
    sanitizeAgainstCatalog,
    type PoolRenameTarget
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

describe("commitPoolNameEdit", () => {
    // The RESTRICTIVE half (solidjs_blur_commit_ordering): `value` is read
    // BEFORE `onCancelRename` fires. Modeled as an accessor whose return
    // value changes once "cancelled" — swapping the read and the cancel
    // call in the implementation would make this see the post-cancel value
    // and fail.
    it("reads the typed value before cancelling, not after", () => {
        let cancelled = false;
        const value = () => (cancelled ? "STALE" : "New Pool Name");
        const onCancelRename = vi.fn(() => {
            cancelled = true;
        });
        const onCommitRename = vi.fn();

        commitPoolNameEdit(value, "placement-1", onCancelRename, onCommitRename);

        expect(onCommitRename).toHaveBeenCalledWith("placement-1", "New Pool Name");
    });

    it("cancels before committing", () => {
        const order: string[] = [];
        const onCancelRename = vi.fn(() => order.push("cancel"));
        const onCommitRename = vi.fn(() => order.push("commit"));

        commitPoolNameEdit(() => "x", "placement-1", onCancelRename, onCommitRename);

        expect(order).toEqual(["cancel", "commit"]);
    });
});

describe("commitPoolRename", () => {
    const target = (name: string): PoolRenameTarget => ({
        id: "placement-1",
        Pool: { name }
    });

    const harness = (pools: PoolRenameTarget[]) => {
        const setName = vi.fn();
        const isLocalMode = vi.fn(() => false);
        const mutate = vi.fn();
        const run = (placementId: string, rawName: string) =>
            commitPoolRename({
                pools,
                placementId,
                rawName,
                setName,
                isLocalMode,
                mutate
            });
        return { setName, isLocalMode, mutate, run };
    };

    it("no-ops on an unknown placement", () => {
        const { setName, mutate, run } = harness([target("Scrim pool")]);
        run("placement-missing", "New name");
        expect(setName).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
    });

    it("no-ops on an empty (whitespace-only) name", () => {
        const { setName, mutate, run } = harness([target("Scrim pool")]);
        run("placement-1", "   ");
        expect(setName).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
    });

    it("no-ops when the trimmed name is unchanged", () => {
        const { setName, mutate, run } = harness([target("Scrim pool")]);
        run("placement-1", "  Scrim pool  ");
        expect(setName).not.toHaveBeenCalled();
        expect(mutate).not.toHaveBeenCalled();
    });

    it("writes the store optimistically and dispatches the mutation in non-local mode", () => {
        const { setName, mutate, run } = harness([target("Scrim pool")]);
        run("placement-1", "  Renamed pool  ");
        expect(setName).toHaveBeenCalledWith("placement-1", "Renamed pool");
        expect(mutate).toHaveBeenCalledWith({
            placementId: "placement-1",
            name: "Renamed pool"
        });
    });

    it("writes the store optimistically but skips the mutation in local mode", () => {
        const pools = [target("Scrim pool")];
        const setName = vi.fn();
        const isLocalMode = vi.fn(() => true);
        const mutate = vi.fn();
        commitPoolRename({
            pools,
            placementId: "placement-1",
            rawName: "Renamed pool",
            setName,
            isLocalMode,
            mutate
        });
        expect(setName).toHaveBeenCalledWith("placement-1", "Renamed pool");
        expect(mutate).not.toHaveBeenCalled();
    });

    it("writes the store before checking local mode (optimistic write happens first)", () => {
        const order: string[] = [];
        const setName = vi.fn(() => order.push("setName"));
        const isLocalMode = vi.fn(() => {
            order.push("isLocalMode");
            return false;
        });
        const mutate = vi.fn(() => order.push("mutate"));
        commitPoolRename({
            pools: [target("Scrim pool")],
            placementId: "placement-1",
            rawName: "Renamed pool",
            setName,
            isLocalMode,
            mutate
        });
        expect(order).toEqual(["setName", "isLocalMode", "mutate"]);
    });
});

describe("poolGrabOffset", () => {
    it("returns the vector from the mousedown point back to the placement's position", () => {
        const placement = { positionX: 100, positionY: 200 };
        expect(poolGrabOffset(placement, 130, 215)).toEqual({
            offsetX: 30,
            offsetY: 15
        });
    });

    it("is zero when the mousedown lands exactly on the placement's position", () => {
        const placement = { positionX: 50, positionY: 60 };
        expect(poolGrabOffset(placement, 50, 60)).toEqual({
            offsetX: 0,
            offsetY: 0
        });
    });
});

describe("poolDragPosition", () => {
    it("is the inverse of poolGrabOffset — recovers the original position", () => {
        const placement = { positionX: 100, positionY: 200 };
        const { offsetX, offsetY } = poolGrabOffset(placement, 130, 215);
        // Same world point fed back through the offset recovers positionX/Y.
        expect(poolDragPosition(130, 215, offsetX, offsetY)).toEqual({
            positionX: 100,
            positionY: 200
        });
    });

    it("tracks a later mousemove point by the recorded offset", () => {
        const placement = { positionX: 100, positionY: 200 };
        const { offsetX, offsetY } = poolGrabOffset(placement, 130, 215);
        // Cursor moved +50/-15 in world space; the card should move with it.
        expect(poolDragPosition(180, 200, offsetX, offsetY)).toEqual({
            positionX: 150,
            positionY: 185
        });
    });
});

describe("commitPoolDrag", () => {
    it("dispatches the mutation in non-local mode", () => {
        const mutate = vi.fn();
        commitPoolDrag({
            placementId: "placement-1",
            positionX: 40,
            positionY: 60,
            isLocalMode: () => false,
            mutate
        });
        expect(mutate).toHaveBeenCalledWith({
            placementId: "placement-1",
            positionX: 40,
            positionY: 60
        });
    });

    it("skips the mutation in local mode", () => {
        const mutate = vi.fn();
        commitPoolDrag({
            placementId: "placement-1",
            positionX: 40,
            positionY: 60,
            isLocalMode: () => true,
            mutate
        });
        expect(mutate).not.toHaveBeenCalled();
    });
});
