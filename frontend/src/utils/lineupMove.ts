import { ROLE_ORDER, type PlayerId } from "./playerStats";
import type { Role } from "@draft-sim/shared-types";

// Structurally identical to `MatchupSide` in RoleSlot.tsx and `ScoutSide` in
// rosterWriteBackState.ts, declared here so this module stays free of any
// component (and therefore JSX) import.
export type LineupSide = "you" | "enemy";

/** A side's five role slots plus its bench — the whole draggable surface. */
export interface Lineup {
    slots: (PlayerId | null)[];
    bench: PlayerId[];
}

export type LineupPosition =
    | { kind: "slot"; index: number }
    | { kind: "bench"; index: number };

/**
 * Every drop exchanges the two participants' positions.
 *
 * The two exceptions move rather than swap, because there is nothing to
 * exchange with: an EMPTY slot (the bench compacts behind the promoted player)
 * and the bench's APPEND target — an out-of-range index, addressed by dropping
 * on the bench container's empty area. Without the append target, demoting a
 * starter to an empty bench is unrepresentable, which is precisely the
 * transition the always-rendered bench exists to allow.
 *
 * Bench order is ordinal, so a swap deliberately leaves positions alone: the
 * second sub stays the second sub after a promotion.
 */
export function applyLineupMove(
    lineup: Lineup,
    from: LineupPosition,
    to: LineupPosition
): Lineup {
    if (from.kind === to.kind && from.index === to.index) return lineup;

    const slots = [...lineup.slots];
    const bench = [...lineup.bench];

    const source =
        from.kind === "slot" ? (slots[from.index] ?? null) : (bench[from.index] ?? null);
    if (!source) return lineup;

    if (to.kind === "slot") {
        if (to.index < 0 || to.index >= slots.length) return lineup;
        const displaced = slots[to.index];
        slots[to.index] = source;
        if (from.kind === "slot") {
            slots[from.index] = displaced;
        } else if (displaced) {
            // The displaced starter lands at the sub's own bench index.
            bench[from.index] = displaced;
        } else {
            bench.splice(from.index, 1);
        }
        return { slots, bench };
    }

    const appending = to.index < 0 || to.index >= bench.length;
    if (from.kind === "slot") {
        if (appending) {
            slots[from.index] = null;
            bench.push(source);
        } else {
            slots[from.index] = bench[to.index];
            bench[to.index] = source;
        }
        return { slots, bench };
    }

    if (appending) {
        bench.splice(from.index, 1);
        bench.push(source);
    } else {
        bench[from.index] = bench[to.index];
        bench[to.index] = source;
    }
    return { slots, bench };
}

/**
 * The drag payload carried in `text/plain`.
 *
 * A slot is addressed by ROLE (that is what the column knows) and a bench chip
 * by index. Anything else parses to null, so a stray drag from elsewhere in the
 * page can never be mistaken for a lineup move.
 */
export type DragOrigin = { kind: "slot"; role: Role } | { kind: "bench"; index: number };

export const dragPayload = (side: LineupSide, origin: DragOrigin): string =>
    origin.kind === "slot"
        ? `${side}:slot:${origin.role}`
        : `${side}:bench:${origin.index}`;

export const parseDragPayload = (
    raw: string
): { side: LineupSide; origin: DragOrigin } | null => {
    const parts = raw.split(":");
    if (parts.length !== 3) return null;
    const side = parts[0] === "you" || parts[0] === "enemy" ? parts[0] : null;
    if (!side) return null;
    if (parts[1] === "slot") {
        const role = ROLE_ORDER.find((r) => r === parts[2]) ?? null;
        return role ? { side, origin: { kind: "slot", role } } : null;
    }
    if (parts[1] === "bench") {
        const index = Number(parts[2]);
        return Number.isInteger(index) && index >= 0
            ? { side, origin: { kind: "bench", index } }
            : null;
    }
    return null;
};

/** A drag origin as a position in the lineup. */
export const positionOf = (origin: DragOrigin): LineupPosition =>
    origin.kind === "slot"
        ? { kind: "slot", index: ROLE_ORDER.indexOf(origin.role) }
        : { kind: "bench", index: origin.index };
