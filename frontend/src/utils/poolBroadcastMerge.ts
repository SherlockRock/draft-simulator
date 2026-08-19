import type { PoolChampionOp, Pool } from "@draft-sim/shared-types";
import { applyPoolChampionOp } from "@draft-sim/shared-types";

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
