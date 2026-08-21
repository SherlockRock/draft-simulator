import { describe, it, expect, vi } from "vitest";
import {
    commitPoolChampionOp,
    commitPoolDrag,
    commitPoolNameEdit,
    commitPoolRename,
    commitPoolReplace,
    flexRolesByChampion,
    insertionIndexFromRects,
    poolChampionIsAvailable,
    poolChampionTotal,
    poolDragPosition,
    poolGrabOffset,
    poolRoleGridEntries,
    resolveOverlayApply,
    sanitizeAgainstCatalog,
    type PoolChampionOpTarget,
    type PoolRenameTarget
} from "./poolCard";
import { championsInRole } from "./championRoles";
import { pushPendingOp } from "./poolBroadcastMerge";
import type { PoolChampionOp, RolePoolMap } from "@draft-sim/shared-types";

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
    // value changes once "cleared" — swapping the read and the cancel call
    // in the implementation would make this see the post-clear value and
    // fail.
    it("reads the typed value before clearing the rename flag, not after", () => {
        let cleared = false;
        const value = () => (cleared ? "STALE" : "New Pool Name");
        const onCancelRename = vi.fn(() => {
            cleared = true;
        });
        const onCommitRename = vi.fn();

        commitPoolNameEdit(
            value,
            "placement-1",
            onCancelRename,
            onCommitRename,
            () => false
        );

        expect(onCommitRename).toHaveBeenCalledWith("placement-1", "New Pool Name");
    });

    it("cancels before committing, on the normal (non-cancelled) path", () => {
        const order: string[] = [];
        const onCancelRename = vi.fn(() => order.push("cancel"));
        const onCommitRename = vi.fn(() => order.push("commit"));

        commitPoolNameEdit(
            () => "x",
            "placement-1",
            onCancelRename,
            onCommitRename,
            () => false
        );

        expect(order).toEqual(["cancel", "commit"]);
    });

    // Runtime-confirmed regression: Escape sets its own cancelled flag and
    // calls onCancelRename() directly, which unmounts the input via the
    // card's <Show>. Removing a focused element fires a native `blur`
    // synchronously, so this function runs a SECOND time right after Escape
    // — with the guard, that second run must no-op instead of committing.
    it("no-ops when already cancelled — does not commit, does not re-cancel", () => {
        const onCancelRename = vi.fn();
        const onCommitRename = vi.fn();

        commitPoolNameEdit(
            () => "typed before Escape",
            "placement-1",
            onCancelRename,
            onCommitRename,
            () => true
        );

        expect(onCommitRename).not.toHaveBeenCalled();
        expect(onCancelRename).not.toHaveBeenCalled();
    });

    // Models the full runtime sequence end to end using the real function
    // for both calls: Escape (cancel flag set, onCancelRename called once)
    // immediately followed by the native blur it triggers (onBlur calling
    // commitPoolNameEdit again). Restrictive against the pre-fix code: with
    // no `wasCancelled` guard this called onCommitRename with the typed
    // text and onCancelRename a second time.
    it("models Escape -> unmount -> native blur: cancels once, never commits", () => {
        let cancelled = false;
        const onCancelRename = vi.fn();
        const onCommitRename = vi.fn();

        // Escape handler, as wired in PoolNameInput.
        cancelled = true;
        onCancelRename();

        // The blur the unmount fires, as wired in PoolNameInput's onBlur.
        commitPoolNameEdit(
            () => "typed before Escape",
            "placement-1",
            onCancelRename,
            onCommitRename,
            () => cancelled
        );

        expect(onCommitRename).not.toHaveBeenCalled();
        expect(onCancelRename).toHaveBeenCalledTimes(1);
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
        const localRename = vi.fn();
        const refreshFromLocal = vi.fn();
        const run = (placementId: string, rawName: string) =>
            commitPoolRename({
                pools,
                placementId,
                rawName,
                setName,
                isLocalMode,
                mutate,
                localRename,
                refreshFromLocal
            });
        return { setName, isLocalMode, mutate, localRename, refreshFromLocal, run };
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

    it("writes the store optimistically but skips the server mutation in local mode", () => {
        const pools = [target("Scrim pool")];
        const setName = vi.fn();
        const isLocalMode = vi.fn(() => true);
        const mutate = vi.fn();
        const localRename = vi.fn();
        const refreshFromLocal = vi.fn();
        commitPoolRename({
            pools,
            placementId: "placement-1",
            rawName: "Renamed pool",
            setName,
            isLocalMode,
            mutate,
            localRename,
            refreshFromLocal
        });
        expect(setName).toHaveBeenCalledWith("placement-1", "Renamed pool");
        expect(mutate).not.toHaveBeenCalled();
    });

    it("dispatches localRenamePool + refreshFromLocal in local mode instead of the server mutation", () => {
        const pools = [target("Scrim pool")];
        const setName = vi.fn();
        const isLocalMode = vi.fn(() => true);
        const mutate = vi.fn();
        const localRename = vi.fn();
        const refreshFromLocal = vi.fn();
        commitPoolRename({
            pools,
            placementId: "placement-1",
            rawName: "Renamed pool",
            setName,
            isLocalMode,
            mutate,
            localRename,
            refreshFromLocal
        });
        expect(localRename).toHaveBeenCalledWith({
            placementId: "placement-1",
            name: "Renamed pool"
        });
        expect(refreshFromLocal).toHaveBeenCalledOnce();
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
            mutate,
            localRename: vi.fn(),
            refreshFromLocal: vi.fn()
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
    it("dispatches the server mutation in non-local mode", () => {
        const mutate = vi.fn();
        const localMove = vi.fn();
        const refreshFromLocal = vi.fn();
        commitPoolDrag({
            placementId: "placement-1",
            positionX: 40,
            positionY: 60,
            isLocalMode: () => false,
            mutate,
            localMove,
            refreshFromLocal
        });
        expect(mutate).toHaveBeenCalledWith({
            placementId: "placement-1",
            positionX: 40,
            positionY: 60
        });
        expect(localMove).not.toHaveBeenCalled();
        expect(refreshFromLocal).not.toHaveBeenCalled();
    });

    it("dispatches localMovePool + refreshFromLocal in local mode instead of the server mutation", () => {
        const mutate = vi.fn();
        const localMove = vi.fn();
        const refreshFromLocal = vi.fn();
        commitPoolDrag({
            placementId: "placement-1",
            positionX: 40,
            positionY: 60,
            isLocalMode: () => true,
            mutate,
            localMove,
            refreshFromLocal
        });
        expect(mutate).not.toHaveBeenCalled();
        expect(localMove).toHaveBeenCalledWith({
            placementId: "placement-1",
            positionX: 40,
            positionY: 60
        });
        expect(refreshFromLocal).toHaveBeenCalledOnce();
    });
});

describe("poolChampionIsAvailable", () => {
    // The picker's D3 flex rule: a champion in THIS role's bucket greys out
    // (already added here), but a champion in a DIFFERENT role's bucket
    // stays pickable — that's how one champion ends up flexed across roles.
    it("greys out a champion already in the target role", () => {
        const champions: RolePoolMap = {
            top: [],
            jungle: [],
            mid: ["Ahri"],
            adc: [],
            support: []
        };
        expect(poolChampionIsAvailable(champions, "mid", "Ahri")).toBe(false);
    });

    it("stays available for a champion sitting in a DIFFERENT role's bucket", () => {
        const champions: RolePoolMap = {
            top: ["Ahri"],
            jungle: [],
            mid: [],
            adc: [],
            support: []
        };
        expect(poolChampionIsAvailable(champions, "mid", "Ahri")).toBe(true);
    });

    it("is available when the champion is in no bucket at all", () => {
        const champions: RolePoolMap = {
            top: [],
            jungle: [],
            mid: [],
            adc: [],
            support: []
        };
        expect(poolChampionIsAvailable(champions, "mid", "Ahri")).toBe(true);
    });
});

describe("commitPoolChampionOp", () => {
    const target = (champions: RolePoolMap): PoolChampionOpTarget => ({
        id: "placement-1",
        Pool: { champions }
    });

    const emptyMap: RolePoolMap = {
        top: [],
        jungle: [],
        mid: [],
        adc: [],
        support: []
    };

    const addOp: PoolChampionOp = { type: "add", role: "mid", championId: "Ahri" };

    // DI harness mirroring commitPoolRename/commitPoolDrag's shape above.
    // pendingOps is a plain in-memory map standing in for Canvas.tsx's
    // non-reactive pendingPoolOps, so getPendingOps/setPendingOps read back
    // real state instead of just recording calls.
    const harness = (pools: PoolChampionOpTarget[], canEditValue = true) => {
        const setChampions = vi.fn();
        const isLocalMode = vi.fn(() => false);
        const localOp = vi.fn();
        const emit = vi.fn();
        const pendingOps = new Map<string, PoolChampionOp[]>();
        const getPendingOps = vi.fn((id: string) => pendingOps.get(id) ?? []);
        const setPendingOps = vi.fn((id: string, ops: PoolChampionOp[]) =>
            pendingOps.set(id, ops)
        );
        const canEdit = vi.fn(() => canEditValue);
        const run = (placementId: string, op: PoolChampionOp) =>
            commitPoolChampionOp({
                pools,
                placementId,
                op,
                canEdit,
                setChampions,
                isLocalMode,
                localOp,
                getPendingOps,
                setPendingOps,
                pushPendingOp,
                emit
            });
        return {
            setChampions,
            isLocalMode,
            localOp,
            emit,
            pendingOps,
            canEdit,
            run
        };
    };

    it("no-ops when editing is not allowed", () => {
        const { setChampions, emit, localOp, run } = harness([target(emptyMap)], false);
        run("placement-1", addOp);
        expect(setChampions).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        expect(localOp).not.toHaveBeenCalled();
    });

    it("no-ops on an unknown placement", () => {
        const { setChampions, emit, run } = harness([target(emptyMap)]);
        run("placement-missing", addOp);
        expect(setChampions).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });

    it("applies the op through applyPoolChampionOp and writes the result optimistically", () => {
        const { setChampions, run } = harness([target(emptyMap)]);
        run("placement-1", addOp);
        expect(setChampions).toHaveBeenCalledWith("placement-1", {
            ...emptyMap,
            mid: ["Ahri"]
        });
    });

    it("re-adding an already-present champion no-ops the bucket (idempotent set semantics)", () => {
        const withAhri = { ...emptyMap, mid: ["Ahri"] };
        const { setChampions, run } = harness([target(withAhri)]);
        run("placement-1", addOp);
        expect(setChampions).toHaveBeenCalledWith("placement-1", {
            ...withAhri
        });
    });

    it("removing a champion not present no-ops the bucket", () => {
        const { setChampions, run } = harness([target(emptyMap)]);
        run("placement-1", { type: "remove", role: "mid", championId: "Ahri" });
        expect(setChampions).toHaveBeenCalledWith("placement-1", emptyMap);
    });

    it("removing a champion present in a role shrinks that bucket", () => {
        const withAhri = { ...emptyMap, mid: ["Ahri", "Akali"] };
        const { setChampions, run } = harness([target(withAhri)]);
        run("placement-1", { type: "remove", role: "mid", championId: "Ahri" });
        expect(setChampions).toHaveBeenCalledWith("placement-1", {
            ...emptyMap,
            mid: ["Akali"]
        });
    });

    it("socket mode: queues the pending op and emits, skips localOp", () => {
        const { setChampions, localOp, emit, pendingOps, run } = harness([
            target(emptyMap)
        ]);
        run("placement-1", addOp);
        expect(setChampions).toHaveBeenCalled();
        expect(localOp).not.toHaveBeenCalled();
        expect(emit).toHaveBeenCalledWith({ placementId: "placement-1", op: addOp });
        expect(pendingOps.get("placement-1")).toEqual([addOp]);
    });

    it("socket mode: a later op on the same (role, championId) collapses the pending queue to one entry", () => {
        const { pendingOps, run } = harness([target(emptyMap)]);
        run("placement-1", addOp);
        run("placement-1", { type: "remove", role: "mid", championId: "Ahri" });
        expect(pendingOps.get("placement-1")).toEqual([
            { type: "remove", role: "mid", championId: "Ahri" }
        ]);
    });

    it("local mode: dispatches localOp, never touches pendingOps or emit", () => {
        const pools = [target(emptyMap)];
        const setChampions = vi.fn();
        const isLocalMode = vi.fn(() => true);
        const localOp = vi.fn();
        const emit = vi.fn();
        const getPendingOps = vi.fn(() => []);
        const setPendingOps = vi.fn();
        commitPoolChampionOp({
            pools,
            placementId: "placement-1",
            op: addOp,
            canEdit: () => true,
            setChampions,
            isLocalMode,
            localOp,
            getPendingOps,
            setPendingOps,
            pushPendingOp,
            emit
        });
        expect(setChampions).toHaveBeenCalledWith("placement-1", {
            ...emptyMap,
            mid: ["Ahri"]
        });
        expect(localOp).toHaveBeenCalledWith({ placementId: "placement-1", op: addOp });
        expect(setPendingOps).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });

    it("writes the store optimistically before checking local mode (optimistic write happens first)", () => {
        const order: string[] = [];
        const setChampions = vi.fn(() => order.push("setChampions"));
        const isLocalMode = vi.fn(() => {
            order.push("isLocalMode");
            return true;
        });
        const localOp = vi.fn(() => order.push("localOp"));
        commitPoolChampionOp({
            pools: [target(emptyMap)],
            placementId: "placement-1",
            op: addOp,
            canEdit: () => true,
            setChampions,
            isLocalMode,
            localOp,
            getPendingOps: () => [],
            setPendingOps: vi.fn(),
            pushPendingOp,
            emit: vi.fn()
        });
        expect(order).toEqual(["setChampions", "isLocalMode", "localOp"]);
    });
});

describe("commitPoolReplace", () => {
    const replacement: RolePoolMap = {
        top: ["Aatrox"],
        jungle: [],
        mid: ["Ahri"],
        adc: [],
        support: []
    };

    // DI harness mirroring commitPoolDrag's shape. pendingOps is a real
    // in-memory map (not just a spy) so the queue-clear assertions read back
    // actual state, same reasoning as commitPoolChampionOp's harness above.
    const harness = (seedPending: PoolChampionOp[] = []) => {
        const setChampions = vi.fn();
        const isLocalMode = vi.fn(() => false);
        const localReplace = vi.fn();
        const refreshFromLocal = vi.fn();
        const emit = vi.fn();
        const pendingOps = new Map<string, PoolChampionOp[]>([
            ["placement-1", seedPending]
        ]);
        const clearPendingOps = vi.fn((id: string) => pendingOps.set(id, []));
        const run = () =>
            commitPoolReplace({
                placementId: "placement-1",
                champions: replacement,
                setChampions,
                clearPendingOps,
                isLocalMode,
                localReplace,
                refreshFromLocal,
                emit
            });
        return {
            setChampions,
            isLocalMode,
            localReplace,
            refreshFromLocal,
            emit,
            pendingOps,
            clearPendingOps,
            run
        };
    };

    it("clears a non-empty pending-ops queue for the placement", () => {
        const pending: PoolChampionOp[] = [
            { type: "add", role: "mid", championId: "Zed" }
        ];
        const { pendingOps, clearPendingOps, run } = harness(pending);
        expect(pendingOps.get("placement-1")).toEqual(pending);
        run();
        expect(clearPendingOps).toHaveBeenCalledWith("placement-1");
        expect(pendingOps.get("placement-1")).toEqual([]);
    });

    it("writes the optimistic champions map, then dispatches the server mutation in non-local mode", () => {
        const { setChampions, localReplace, refreshFromLocal, emit, run } = harness();
        run();
        expect(setChampions).toHaveBeenCalledWith("placement-1", replacement);
        expect(emit).toHaveBeenCalledWith({
            placementId: "placement-1",
            champions: replacement
        });
        expect(localReplace).not.toHaveBeenCalled();
        expect(refreshFromLocal).not.toHaveBeenCalled();
    });

    it("dispatches localReplacePool + refreshFromLocal in local mode instead of the server mutation", () => {
        const { setChampions, isLocalMode, localReplace, refreshFromLocal, emit, run } =
            harness();
        isLocalMode.mockReturnValue(true);
        run();
        expect(setChampions).toHaveBeenCalledWith("placement-1", replacement);
        expect(localReplace).toHaveBeenCalledWith({
            placementId: "placement-1",
            champions: replacement
        });
        expect(refreshFromLocal).toHaveBeenCalledOnce();
        expect(emit).not.toHaveBeenCalled();
    });

    it("clears the queue and writes optimistic state BEFORE branching local/remote", () => {
        const order: string[] = [];
        const pendingOps = new Map<string, PoolChampionOp[]>([
            ["placement-1", [{ type: "add", role: "mid", championId: "Zed" }]]
        ]);
        commitPoolReplace({
            placementId: "placement-1",
            champions: replacement,
            clearPendingOps: (id) => {
                order.push("clearPendingOps");
                pendingOps.set(id, []);
            },
            setChampions: () => order.push("setChampions"),
            isLocalMode: () => {
                order.push("isLocalMode");
                return false;
            },
            localReplace: () => order.push("localReplace"),
            refreshFromLocal: () => order.push("refreshFromLocal"),
            emit: () => order.push("emit")
        });
        expect(order).toEqual(["clearPendingOps", "setChampions", "isLocalMode", "emit"]);
    });
});

describe("resolveOverlayApply", () => {
    const emptyMap: RolePoolMap = {
        top: [],
        jungle: [],
        mid: [],
        adc: [],
        support: []
    };

    it("replaces with the staged map when an import happened this session, even with no diff", () => {
        // A REPLACE intent must fire even if the imported champions happen
        // to equal the opening snapshot — this is a value comparison
        // (diffRolePoolMaps) never runs on the replace path, unlike ops.
        const decision = resolveOverlayApply({
            importedThisSession: true,
            opening: emptyMap,
            staged: emptyMap
        });
        expect(decision).toEqual({ kind: "replace", champions: emptyMap });
    });

    it("replaces with the staged map when an import happened and changed the pool", () => {
        const staged: RolePoolMap = { ...emptyMap, mid: ["Ahri"] };
        const decision = resolveOverlayApply({
            importedThisSession: true,
            opening: emptyMap,
            staged
        });
        expect(decision).toEqual({ kind: "replace", champions: staged });
    });

    it("sends diff-as-ops when no import happened this session", () => {
        const staged: RolePoolMap = { ...emptyMap, mid: ["Ahri"] };
        const decision = resolveOverlayApply({
            importedThisSession: false,
            opening: emptyMap,
            staged
        });
        expect(decision).toEqual({
            kind: "ops",
            ops: [{ type: "add", role: "mid", championId: "Ahri" }]
        });
    });

    it("is a noop when no import happened and staged is unchanged from opening", () => {
        const decision = resolveOverlayApply({
            importedThisSession: false,
            opening: emptyMap,
            staged: { ...emptyMap }
        });
        expect(decision).toEqual({ kind: "noop" });
    });

    // THE downgrade rule (import -> manual tweak -> apply sends ops, not
    // replace): PoolOverlayEditor clears `importedThisSession` on every
    // accordion change (setRoleChampions), so by the time Apply runs after
    // an import followed by a manual edit, the flag this function sees is
    // already false — modeling that here pins the "import stops being the
    // intent" rule at the decision boundary, restrictive against a version
    // of this function that ignored the flag and always replaced after any
    // import ever happened in the session.
    it("downgrades to diff-as-ops when a manual edit followed the import (flag already cleared)", () => {
        // opening: what the overlay saw when it mounted, before the import.
        const opening: RolePoolMap = { ...emptyMap, top: ["Aatrox"] };
        // staged: after import replaced the map, then a manual accordion
        // edit added one more champion on top of the imported set.
        const staged: RolePoolMap = { ...emptyMap, top: ["Aatrox"], mid: ["Ahri"] };
        const decision = resolveOverlayApply({
            importedThisSession: false,
            opening,
            staged
        });
        expect(decision).toEqual({
            kind: "ops",
            ops: [{ type: "add", role: "mid", championId: "Ahri" }]
        });
    });
});

describe("poolRoleGridEntries", () => {
    // "Ahri" is an established meta mid pick used across this suite
    // (poolOps.test.ts, poolChampionIsAvailable above). "Aatrox" is a meta
    // TOP pick, not mid — used here as the off-meta-for-this-role case.
    it("with an empty bucket, returns exactly the meta-role catalog in catalog order", () => {
        const entries = poolRoleGridEntries("mid", []);
        expect(entries.map((e) => e.id)).toEqual(championsInRole("mid"));
    });

    it("puts a bucket entry FIRST even when it's already in the meta-role list, with no duplicate", () => {
        const entries = poolRoleGridEntries("mid", ["Ahri"]);
        expect(entries[0].id).toBe("Ahri");
        expect(entries.filter((e) => e.id === "Ahri")).toHaveLength(1);
    });

    it("surfaces an off-meta bucket champion (in the catalog, not in this role) before the meta remainder", () => {
        const entries = poolRoleGridEntries("mid", ["Aatrox"]);
        expect(entries[0]).toMatchObject({ id: "Aatrox", img: expect.any(String) });
        // Not duplicated into the meta-role remainder either.
        expect(entries.filter((e) => e.id === "Aatrox")).toHaveLength(1);
    });

    it("gives an off-catalog bucket id a synthetic img:null tile instead of hiding it", () => {
        const entries = poolRoleGridEntries("mid", ["NotARealChampion12345"]);
        const synthetic = entries.find((e) => e.id === "NotARealChampion12345");
        expect(synthetic).toEqual({
            id: "NotARealChampion12345",
            name: "NotARealChampion12345",
            img: null
        });
    });

    it("orders bucket-catalog, then bucket-off-catalog, then the meta-role remainder", () => {
        const entries = poolRoleGridEntries("mid", ["Aatrox", "NotARealChampion12345"]);
        expect(entries[0].id).toBe("Aatrox");
        expect(entries[1]).toEqual({
            id: "NotARealChampion12345",
            name: "NotARealChampion12345",
            img: null
        });
        // Everything after index 1 is the meta-role remainder: real mid
        // picks, none of which are the two bucket ids above.
        const remainder = entries.slice(2).map((e) => e.id);
        expect(remainder).toEqual(championsInRole("mid").filter((id) => id !== "Aatrox"));
    });
});

describe("insertionIndexFromRects", () => {
    // Three 40px tiles at 0, 40, 80 — midpoints 20, 60, 100.
    const rects = [
        { left: 0, width: 40 },
        { left: 40, width: 40 },
        { left: 80, width: 40 }
    ];

    it("names slot 0 anywhere left of the first tile's midpoint", () => {
        expect(insertionIndexFromRects(rects, -10)).toBe(0);
        expect(insertionIndexFromRects(rects, 19)).toBe(0);
    });

    it("flips at each midpoint, not at the tile borders", () => {
        expect(insertionIndexFromRects(rects, 21)).toBe(1);
        expect(insertionIndexFromRects(rects, 59)).toBe(1);
        expect(insertionIndexFromRects(rects, 61)).toBe(2);
    });

    it("names the trailing slot beyond the last midpoint", () => {
        expect(insertionIndexFromRects(rects, 101)).toBe(3);
        expect(insertionIndexFromRects(rects, 9999)).toBe(3);
    });

    it("an empty row has exactly one slot", () => {
        expect(insertionIndexFromRects([], 42)).toBe(0);
    });
});
