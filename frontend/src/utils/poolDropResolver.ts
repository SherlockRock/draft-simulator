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
    // `index` is an INSERTION point in the row's current bucket: 0 is before
    // the first tile, bucket.length is after the last. The preview draws its
    // caret at the same index, so the two can never disagree.
    | { kind: "role-row"; placementId: string; role: Role; index: number }
    | { kind: "off-card" };

export type PoolDropResult =
    | { kind: "none" } // unchanged
    | { kind: "reorder"; ops: [PoolChampionOp] } // within one row
    | { kind: "move"; ops: PoolChampionOp[] } // across rows
    | { kind: "remove"; ops: [PoolChampionOp] }; // drag off card

/** The bucket as it would read with `championId` inserted at `index`. */
const withInsertedAt = (
    bucket: string[],
    championId: string,
    index: number
): string[] => {
    const without = bucket.filter((id) => id !== championId);
    // The caret index is measured against the bucket WITH the dragged tile in
    // it, so removing the tile first shifts every later slot down by one.
    const from = bucket.indexOf(championId);
    const adjusted = from !== -1 && from < index ? index - 1 : index;
    const clamped = Math.max(0, Math.min(without.length, adjusted));
    return [...without.slice(0, clamped), championId, ...without.slice(clamped)];
};

const sameOrder = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Resolves an in-place portrait drag within a pool card.
 *
 * `targetChampions` is the CURRENT `RolePoolMap` of the target's placement —
 * for an `off-card` target, or a cross-card target this slice defers, it is
 * never read, so callers may pass whatever map they have in scope (e.g. the
 * dragged card's own).
 *
 * Cases:
 *  - row -> same row, arrangement unchanged -> none
 *  - row -> same row, moved                 -> reorder (whole bucket)
 *  - row -> other row                       -> move: [remove, add] plus a
 *    trailing reorder when the caret is not at the end, because `add` appends
 *    and the preview promised a specific slot
 *  - row -> other row already containing it -> the add would dedupe, so
 *    [remove] plus a reorder when the caret asks for a different slot
 *  - row -> off-card                        -> remove
 *  - cross-CARD (different placementId)     -> none (named deferral:
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

    const targetBucket = targetChampions[target.role];
    const desired = withInsertedAt(targetBucket, source.championId, target.index);

    if (target.role === source.role) {
        if (sameOrder(targetBucket, desired)) return { kind: "none" };
        return {
            kind: "reorder",
            ops: [{ type: "reorder", role: target.role, championIds: desired }]
        };
    }

    const ops: PoolChampionOp[] = [
        { type: "remove", role: source.role, championId: source.championId }
    ];
    const alreadyThere = targetBucket.includes(source.championId);
    if (!alreadyThere) {
        ops.push({ type: "add", role: target.role, championId: source.championId });
    }

    // Where those ops alone would leave the target bucket: an add appends, and
    // a champion already present does not move.
    const settled = alreadyThere ? targetBucket : [...targetBucket, source.championId];
    if (!sameOrder(settled, desired)) {
        ops.push({ type: "reorder", role: target.role, championIds: desired });
    }

    if (ops.length === 1) {
        return { kind: "remove", ops: [ops[0]] };
    }
    return { kind: "move", ops };
};
