import type { NavigatorEventData, NavigatorTreeNode } from "../contexts/NavigatorContext";
import { describeLine } from "./navigatorColumns";
import { turnLabel } from "./turnSequence";
import { getPicksArrayIndex } from "./versusPickOrder";

export const EXPORT_CANVAS_STORAGE_KEY = "navigator.exportCanvasId";
const CANVAS_PICKS_LENGTH = 20;

/** Design § 8: `Draft.picks` in the canvas index convention (canvasCardLayout.ts:
 *  blue bans 0–4, red bans 5–9, blue picks 10–14, red picks 15–19), which is
 *  exactly `getPicksArrayIndex(slot)` with blue first pick. Confirmed events
 *  first, then each selected node's champions at its slots; the rest "". */
export function lineToCanvasPicks(
    events: readonly NavigatorEventData[],
    nodes: readonly NavigatorTreeNode[]
): string[] {
    const picks: string[] = Array.from({ length: CANVAS_PICKS_LENGTH }, () => "");
    for (const e of events) {
        if (e.event_type !== "ban" && e.event_type !== "pick") continue;
        picks[getPicksArrayIndex(e.slot)] = e.champion_id;
    }
    for (const node of nodes) {
        node.slots.forEach((slot, i) => {
            const id = node.championIds[i];
            if (id !== undefined) picks[getPicksArrayIndex(slot)] = id;
        });
    }
    return picks;
}

export function exportDraftName(
    gameNumber: number,
    ourSide: "blue" | "red",
    lineChampionName: string
): string {
    return `Navigator G${gameNumber} — ${ourSide} line ${lineChampionName}`;
}

export function exportDraftDescription(args: {
    sessionLabel: string;
    gameNumber: number;
    /** Count of confirmed (ban/pick) events; slots are contiguous so the last one is count − 1. */
    confirmedCount: number;
    nodes: readonly NavigatorTreeNode[];
    nameOf: (id: string) => string;
}): string {
    const confirmed =
        args.confirmedCount === 0
            ? "Nothing confirmed"
            : `Confirmed through ${turnLabel(args.confirmedCount - 1)}`;
    const projected =
        args.nodes.length === 0
            ? "none"
            : describeLine(args.nodes, args.nameOf).join(" · ");
    return `Exported from Navigator session ${args.sessionLabel}, game ${args.gameNumber}. ${confirmed}. Projected: ${projected}`;
}
