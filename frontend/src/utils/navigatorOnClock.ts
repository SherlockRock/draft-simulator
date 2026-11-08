import type { Side } from "./navigatorSeats";
import { TURN_SEQUENCE } from "./turnSequence";

/** The slots lit by the turn on the clock: both halves of a duo turn, else the one slot. */
export const turnSlotsAt = (slot: number | null): number[] => {
    if (slot === null) return [];
    const turn = TURN_SEQUENCE[slot];
    if (!turn) return [];
    return turn.pairStart ? [slot, slot + 1] : [slot];
};

/** Design § 2: the on-the-clock surfaces are pale and side-coloured (sky stays the selection colour).
 *  Literal class strings so Tailwind's scan of src/** finds them. */
export const ON_CLOCK: Record<
    Side,
    {
        tick: string;
        row: string;
        ring: string;
        text: string;
        tint: string;
        button: string;
    }
> = {
    blue: {
        tick: "bg-blue-200 shadow-[0_0_0_2px_rgba(191,219,254,0.35)]",
        row: "border-blue-200 shadow-[0_0_0_2px_rgba(191,219,254,0.25)]",
        ring: "border-blue-200",
        text: "text-blue-200",
        tint: "bg-blue-200/[0.03]",
        button: "bg-blue-200 text-black"
    },
    red: {
        tick: "bg-red-200 shadow-[0_0_0_2px_rgba(254,202,202,0.35)]",
        row: "border-red-200 shadow-[0_0_0_2px_rgba(254,202,202,0.25)]",
        ring: "border-red-200",
        text: "text-red-200",
        tint: "bg-red-200/[0.03]",
        button: "bg-red-200 text-black"
    }
};
