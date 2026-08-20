import type { PoolChampionOp, Role, RolePoolMap } from "@draft-sim/shared-types";

/**
 * The drag-preview-resolver technique (house rule, precedent:
 * `resolveGridDrop` in `gridLayout.ts`): ONE pure function computes the
 * drop outcome, and BOTH the mousemove preview and the mouseup commit call
 * it — so the preview painted mid-drag can never lie about what mouseup
 * will actually do.
 */
export type PoolDragSource = {
    placementId: string;
    role: Role;
    championId: string;
};

export type PoolDropTarget =
    | { kind: "role-row"; placementId: string; role: Role }
    | { kind: "off-card" };

export type PoolDropResult =
    | { kind: "none" } // same bucket, or unchanged
    | { kind: "move"; ops: [PoolChampionOp, PoolChampionOp] } // remove+add
    | { kind: "remove"; ops: [PoolChampionOp] }; // drag off card

/**
 * Resolves an in-place portrait drag within a pool card.
 *
 * `targetChampions` is the CURRENT `RolePoolMap` of the target's placement
 * (only consulted for a same-placement `role-row` target, to detect the
 * champion is already flexed into that row) — for an `off-card` target, or
 * a cross-card target this slice defers, it is never read, so callers may
 * pass whatever map they have in scope (e.g. the dragged card's own).
 *
 * Five cases (design, verbatim):
 *  - row -> other row, not already there  -> move: [remove, add]
 *  - row -> same row                      -> none
 *  - row -> row already containing it     -> remove only (the add would
 *    dedupe — the preview must match the outcome, so the resolver omits it
 *    rather than emitting a no-op add)
 *  - row -> off-card                      -> remove
 *  - cross-CARD (different placementId)   -> none (named deferral:
 *    pool-to-pool portrait transfer)
 */
export const resolvePoolDrop = (args: {
    source: PoolDragSource;
    target: PoolDropTarget;
    targetChampions: RolePoolMap;
}): PoolDropResult => {
    const { source, target, targetChampions } = args;

    if (target.kind === "off-card") {
        return {
            kind: "remove",
            ops: [{ type: "remove", role: source.role, championId: source.championId }]
        };
    }

    if (target.placementId !== source.placementId) {
        return { kind: "none" };
    }

    if (target.role === source.role) {
        return { kind: "none" };
    }

    if (targetChampions[target.role].includes(source.championId)) {
        return {
            kind: "remove",
            ops: [{ type: "remove", role: source.role, championId: source.championId }]
        };
    }

    return {
        kind: "move",
        ops: [
            { type: "remove", role: source.role, championId: source.championId },
            { type: "add", role: target.role, championId: source.championId }
        ]
    };
};
