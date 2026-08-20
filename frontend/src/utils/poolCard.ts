import type { Role, RolePoolMap, PoolChampionOp } from "@draft-sim/shared-types";
import { applyPoolChampionOp } from "@draft-sim/shared-types";
import { ROLES } from "./championRoles";
import { champions as catalogChampions } from "./constants";

/** World px. Fixed in v1 — no resize slice is committed, so no stored size
 *  (design §1.3/§7); fits 8 portrait tiles per row. */
export const POOL_CARD_WIDTH = 440;
export const POOL_PORTRAIT_PX = 40;

export const flexRolesByChampion = (map: RolePoolMap): Map<string, Role[]> => {
    const roleLists = new Map<string, Role[]>();
    for (const role of ROLES) {
        for (const championId of map[role]) {
            const existing = roleLists.get(championId);
            if (existing) existing.push(role);
            else roleLists.set(championId, [role]);
        }
    }
    const flexOnly = new Map<string, Role[]>();
    for (const [championId, roles] of roleLists) {
        if (roles.length > 1) flexOnly.set(championId, roles);
    }
    return flexOnly;
};

export const poolChampionTotal = (map: RolePoolMap): number => {
    const unique = new Set<string>();
    for (const role of ROLES) {
        for (const championId of map[role]) unique.add(championId);
    }
    return unique.size;
};

/**
 * Per-bucket availability for `PoolChampionPicker`'s "+" tile (design D3): a
 * champion already in THIS role greys out, but stays pickable for any OTHER
 * role — that's how flexing (the amber flex badge) happens. Extracted out of
 * the picker's `isAvailable` closure so the rule is unit-testable without a
 * Solid render harness, same reasoning as `commitPoolNameEdit`'s doc.
 */
export const poolChampionIsAvailable = (
    champions: RolePoolMap,
    role: Role,
    championId: string
): boolean => !champions[role].includes(championId);

/** Drops champion ids that no longer exist in the live catalog (e.g. a saved
 *  pool captured before a champion was removed/renamed upstream) and reports
 *  how many were dropped so the caller can toast about it. Lifted from
 *  `SavedPoolDropdown.tsx` (navigator) so the canvas creation flow can reuse
 *  the exact same dropped-count semantics — navigator behavior unchanged. */
export const sanitizeAgainstCatalog = (
    map: RolePoolMap
): { champions: RolePoolMap; droppedCount: number } => {
    const validIds = new Set(catalogChampions.map((c) => c.id));
    let dropped = 0;
    const next: RolePoolMap = {
        top: [],
        jungle: [],
        mid: [],
        adc: [],
        support: []
    };
    for (const role of ROLES) {
        for (const id of map[role] ?? []) {
            if (validIds.has(id)) {
                next[role].push(id);
            } else {
                dropped += 1;
            }
        }
    }
    return { champions: next, droppedCount: dropped };
};

/**
 * The pool-name input's blur/Enter commit path, extracted so the
 * read-before-clear ordering is unit-testable without a DOM: `PoolNameInput`
 * (`CanvasPoolCard.tsx`) has no render-test harness in this repo, and the
 * ordering itself can't be proven by reading the JSX. `value` is passed as
 * the signal accessor (not a pre-read string) so this reads it BEFORE
 * calling `onCancelRename` — clearing the renaming flag unmounts the input
 * via the card's `<Show>`, and calling `onCancelRename` first would risk
 * reading a value from a component already torn down, or (if a resync
 * effect were ever added here) a value clobbered by it. This is the
 * `solidjs_blur_commit_ordering` scar's fix shape, applied verbatim even
 * though this specific input has no resync effect to trip over.
 *
 * `wasCancelled` guards a SECOND hazard, runtime-confirmed in the browser:
 * pressing Escape calls `onCancelRename()` directly, which unmounts this
 * input via the card's `<Show>` — and removing a focused element from the
 * DOM fires a native `blur` event synchronously, running this function a
 * second time with the (untouched) typed value. Without this guard that
 * second run committed the rename right after Escape cancelled it. Checked
 * FIRST, before the read, so a cancelled edit short-circuits entirely; the
 * normal (non-cancelled) path's read-then-clear-then-commit order is
 * unchanged.
 */
export const commitPoolNameEdit = (
    value: () => string,
    placementId: string,
    onCancelRename: () => void,
    onCommitRename: (placementId: string, name: string) => void,
    wasCancelled: () => boolean
): void => {
    if (wasCancelled()) return;
    const typed = value();
    onCancelRename();
    onCommitRename(placementId, typed);
};

/** Just enough of `CanvasPoolPlacement` for the rename guard below — keeps
 *  the helper decoupled from the full wire schema. */
export type PoolRenameTarget = { id: string; Pool: { name: string } };

/**
 * Guard + optimistic write + dispatch for a pool rename, extracted from
 * `Canvas.tsx`'s `handlePoolRename` so the branch logic is unit-testable
 * without mounting the canvas. No-ops (no store write, no request) when the
 * placement is unknown, the trimmed name is empty, or the name is unchanged
 * from the pool's current name. Otherwise the optimistic write always runs
 * BEFORE the local/remote dispatch — same lesson as the draft-name field:
 * rename must not wait on the socket echo, or the input shows the stale
 * name until it arrives.
 */
export const commitPoolRename = (params: {
    pools: PoolRenameTarget[];
    placementId: string;
    rawName: string;
    setName: (placementId: string, name: string) => void;
    isLocalMode: () => boolean;
    mutate: (args: { placementId: string; name: string }) => void;
    localRename: (args: { placementId: string; name: string }) => void;
    refreshFromLocal: () => void;
}): void => {
    const name = params.rawName.trim();
    const placement = params.pools.find((p) => p.id === params.placementId);
    if (!placement || name.length === 0 || name === placement.Pool.name) return;
    params.setName(params.placementId, name);
    if (params.isLocalMode()) {
        params.localRename({ placementId: params.placementId, name });
        params.refreshFromLocal();
        return;
    }
    params.mutate({ placementId: params.placementId, name });
};

/**
 * Grab-offset math for a pool drag: the vector from the mousedown's world
 * point back to the placement's stored position, recorded once at
 * mousedown. Pools carry no `group_id` (unlike drafts/annotations), so this
 * is the offset math alone — no group-relative conversion to fold in.
 */
export const poolGrabOffset = (
    placement: { positionX: number; positionY: number },
    worldX: number,
    worldY: number
): { offsetX: number; offsetY: number } => ({
    offsetX: worldX - placement.positionX,
    offsetY: worldY - placement.positionY
});

/**
 * Inverse of `poolGrabOffset`: applies the recorded offset to the current
 * mousemove's world point to get the placement's new position. Called on
 * every pool drag mousemove.
 */
export const poolDragPosition = (
    worldX: number,
    worldY: number,
    offsetX: number,
    offsetY: number
): { positionX: number; positionY: number } => ({
    positionX: worldX - offsetX,
    positionY: worldY - offsetY
});

/**
 * Guard + dispatch for a pool drag commit, extracted from Canvas.tsx's pool
 * mouseup handler so the local/remote branch is unit-testable without
 * mounting the canvas. Mirrors `commitPoolRename`'s shape: the optimistic
 * store write already landed during mousemove (the relay is paint-only —
 * this is the durable write), so this function only decides whether to hit
 * the network.
 */
export const commitPoolDrag = (params: {
    placementId: string;
    positionX: number;
    positionY: number;
    isLocalMode: () => boolean;
    mutate: (args: { placementId: string; positionX: number; positionY: number }) => void;
    localMove: (args: {
        placementId: string;
        positionX: number;
        positionY: number;
    }) => void;
    refreshFromLocal: () => void;
}): void => {
    if (params.isLocalMode()) {
        params.localMove({
            placementId: params.placementId,
            positionX: params.positionX,
            positionY: params.positionY
        });
        params.refreshFromLocal();
        return;
    }
    params.mutate({
        placementId: params.placementId,
        positionX: params.positionX,
        positionY: params.positionY
    });
};

/** Just enough of `CanvasPoolPlacement` for `commitPoolChampionOp` below —
 *  keeps the helper decoupled from the full wire schema, same shape as
 *  `PoolRenameTarget`. */
export type PoolChampionOpTarget = { id: string; Pool: { champions: RolePoolMap } };

/**
 * Guard + optimistic apply + local/remote dispatch for a single per-role add
 * or remove, extracted from Canvas.tsx's `handlePoolChampionOp` so the
 * ordering is unit-testable without mounting the canvas — this is THE single
 * op path Task 15 (hover-× remove) and slice 4 reuse.
 *
 * No-ops (no store write, no dispatch) when editing is not allowed or the
 * placement is unknown — mirrors `commitPoolRename`'s guard shape.
 * Otherwise the optimistic write via `applyPoolChampionOp` always lands
 * BEFORE the local/remote dispatch, same lesson as `commitPoolRename` and
 * `commitPoolDrag`: the eventual `poolUpdate` broadcast reconciles to the
 * same value, so this is idempotent by construction and must not wait on
 * the echo.
 *
 * In socket mode the op is also queued via `getPendingOps`/`setPendingOps`
 * (backed by Canvas.tsx's plain, non-reactive `pendingPoolOps` map) BEFORE
 * emitting — `pushPendingOp` collapses per (role, champion) so the queue
 * holds only the user's LATEST intent per slot, replayed over any foreign
 * `poolUpdate` that interleaves before the server echoes this op back
 * (design §4.3; the sender is excluded from its own op broadcasts).
 */
export const commitPoolChampionOp = (params: {
    pools: PoolChampionOpTarget[];
    placementId: string;
    op: PoolChampionOp;
    canEdit: () => boolean;
    setChampions: (placementId: string, champions: RolePoolMap) => void;
    isLocalMode: () => boolean;
    localOp: (args: { placementId: string; op: PoolChampionOp }) => void;
    getPendingOps: (placementId: string) => PoolChampionOp[];
    setPendingOps: (placementId: string, ops: PoolChampionOp[]) => void;
    pushPendingOp: (pending: PoolChampionOp[], op: PoolChampionOp) => PoolChampionOp[];
    emit: (args: { placementId: string; op: PoolChampionOp }) => void;
}): void => {
    if (!params.canEdit()) return;
    const placement = params.pools.find((p) => p.id === params.placementId);
    if (!placement) return;
    const next = applyPoolChampionOp(placement.Pool.champions, params.op);
    params.setChampions(params.placementId, next);
    if (params.isLocalMode()) {
        params.localOp({ placementId: params.placementId, op: params.op });
        return;
    }
    params.setPendingOps(
        params.placementId,
        params.pushPendingOp(params.getPendingOps(params.placementId), params.op)
    );
    params.emit({ placementId: params.placementId, op: params.op });
};
