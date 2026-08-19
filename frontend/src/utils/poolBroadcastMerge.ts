import type { PoolChampionOp, Pool, CanvasPoolPlacement } from "@draft-sim/shared-types";
import { applyPoolChampionOp } from "@draft-sim/shared-types";
import { unwrap } from "solid-js/store";

/** True when the incoming map already shows the op's outcome. */
export const opReflected = (map: Pool["champions"], op: PoolChampionOp): boolean =>
    op.type === "add"
        ? map[op.role].includes(op.championId)
        : !map[op.role].includes(op.championId);

/**
 * Queue an emitted op, superseding any earlier pending op for the same
 * (role, championId) — the queue holds the user's LATEST intent per slot.
 * Without the collapse, outcome-based acknowledgement breaks on toggles:
 * pending [add X, remove X] against a payload lacking X would ack the remove
 * (already reflected) and replay the add, resurrecting a champion the user
 * just removed.
 */
export function pushPendingOp(
    pending: PoolChampionOp[],
    op: PoolChampionOp
): PoolChampionOp[] {
    return [
        ...pending.filter((p) => !(p.role === op.role && p.championId === op.championId)),
        op
    ];
}

/**
 * Replay this client's unacknowledged ops over an incoming full payload.
 * Ops already reflected are acknowledged (dropped); the rest are re-applied.
 * Sound ONLY over a pushPendingOp-collapsed queue (one op per role+champion —
 * so replay order is irrelevant and cross-slot ops commute).
 */
export function mergePoolBroadcast(
    incoming: Pool,
    pending: PoolChampionOp[]
): { pool: Pool; remaining: PoolChampionOp[] } {
    const remaining = pending.filter((op) => !opReflected(incoming.champions, op));
    const champions = remaining.reduce(applyPoolChampionOp, incoming.champions);
    return { pool: { ...incoming, champions }, remaining };
}

/**
 * Merge ONE placement row of a `canvasUpdate` snapshot against the row the
 * store currently holds.
 *
 * A snapshot is built BEFORE any concurrent champion op commits, so it must
 * not overwrite newer champion state: the row is version-guarded, and a
 * non-stale row additionally gets this client's unacknowledged ops replayed
 * on top (design §4.3).
 *
 * `current` is expected to be the LIVE STORE ROW (a Solid proxy) — the
 * unwrap() of store-sourced champion state happens HERE, inside the helper,
 * so the call site stays a plain map. Feeding a live proxy back into
 * reconcile is the pattern Solid warns about. unwrap() on a plain object is
 * the identity, so passing a detached row is equally safe.
 *
 * The caller writes `remaining` back into its pending queue for this row
 * unconditionally; on the stale branch that is the queue it passed in
 * (nothing is acknowledged by a payload that is behind).
 *
 * `isDragging` guards the row's POSITION specifically (Task 7 review
 * finding): a snapshot is built asynchronously and can land mid-drag,
 * carrying whatever positionX/Y the row had when the snapshot was taken —
 * which is stale the instant a local drag has moved it further. Applying
 * that stale position mid-drag snaps the dragged card back under the
 * cursor. When true (and a live `current` row exists to fall back to), the
 * merged row keeps `current`'s position instead of `incoming`'s, on BOTH
 * branches below — champions/version staleness and position staleness are
 * independent axes.
 */
export function mergePoolSnapshotRow(
    incoming: CanvasPoolPlacement,
    current: CanvasPoolPlacement | undefined,
    pending: PoolChampionOp[],
    isDragging = false
): { row: CanvasPoolPlacement; remaining: PoolChampionOp[] } {
    const position =
        isDragging && current
            ? { positionX: current.positionX, positionY: current.positionY }
            : { positionX: incoming.positionX, positionY: incoming.positionY };
    if (current && incoming.Pool.version <= current.Pool.version) {
        // Stale CHAMPIONS payload for this row. version is a champions
        // revision ONLY — renames broadcast snapshots without bumping it, so
        // discarding the whole incoming Pool here would swallow every rename.
        // Keep local champions+version, take everything else (name!, and every
        // placement field) from the incoming payload.
        return {
            row: {
                ...incoming,
                ...position,
                Pool: {
                    ...incoming.Pool,
                    champions: unwrap(current.Pool.champions),
                    version: current.Pool.version
                }
            },
            remaining: pending
        };
    }
    const { pool, remaining } = mergePoolBroadcast(incoming.Pool, pending);
    return { row: { ...incoming, ...position, Pool: pool }, remaining };
}
