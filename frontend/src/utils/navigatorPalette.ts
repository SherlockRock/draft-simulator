import type { NavigatorTreeNode } from "../contexts/NavigatorContext";

export type PaletteCommandId =
    | "pick"
    | "explore"
    | "top-line"
    | "undo"
    | "clear"
    | "pools"
    | "rebucket"
    | "export";

export interface PaletteCommand {
    id: PaletteCommandId;
    label: string;
    hint: string | null;
    /** `›` commands: which right-pane stage Enter opens. */
    opensPane: "champions" | "canvas" | null;
    /** Non-null renders the row disabled with this hint (design § 6). */
    disabledReason: string | null;
}

export interface PaletteContext {
    turn: { slot: number; type: "ban" | "pick" } | null;
    slotLabel: string;
    isOurTurn: boolean;
    hasFan: boolean;
    lastEventChampionName: string | null;
    hasSelection: boolean;
    /** Between games: the draft is completed, or the active draft has no events yet. */
    canEditPools: boolean;
    stale: boolean;
}

/** Design § 6 commands table, in its order. */
export function buildPaletteCommands(ctx: PaletteContext): PaletteCommand[] {
    const out: PaletteCommand[] = [];
    if (ctx.turn) {
        out.push({
            id: "pick",
            label: `${ctx.turn.type === "ban" ? "Ban" : "Pick"} for ${ctx.slotLabel}`,
            hint: ctx.isOurTurn ? "our turn" : "opponent's turn",
            opensPane: "champions",
            disabledReason: null
        });
        out.push({
            id: "explore",
            label: "Explore line for…",
            hint: "select, don't commit",
            opensPane: "champions",
            disabledReason: ctx.hasFan ? null : "no candidates"
        });
        out.push({
            id: "top-line",
            label: "Follow the top line",
            hint: "#1 at every turn",
            opensPane: null,
            disabledReason: ctx.hasFan ? null : "no candidates"
        });
    }
    out.push({
        id: "undo",
        label: "Undo last",
        hint: ctx.lastEventChampionName ?? "nothing to undo",
        opensPane: null,
        disabledReason: ctx.lastEventChampionName ? null : "nothing to undo"
    });
    out.push({
        id: "clear",
        label: "Clear selection",
        hint: null,
        opensPane: null,
        disabledReason: ctx.hasSelection ? null : "nothing selected"
    });
    out.push({
        id: "pools",
        label: "Edit pools",
        hint: null,
        opensPane: null,
        disabledReason: ctx.canEditPools ? null : "between games"
    });
    if (ctx.stale) {
        out.push({
            id: "rebucket",
            label: "Re-bucket saved pool from current roles",
            hint: "stale buckets",
            opensPane: null,
            disabledReason: ctx.canEditPools ? null : "between games"
        });
    }
    out.push({
        id: "export",
        label: "Export selected line to canvas",
        hint: null,
        opensPane: "canvas",
        disabledReason: ctx.hasSelection ? null : "select a line first"
    });
    return out;
}

export function filterPaletteCommands(
    commands: readonly PaletteCommand[],
    query: string
): PaletteCommand[] {
    const q = query.trim().toLowerCase();
    if (q === "") return [...commands];
    return commands.filter((c) => c.label.toLowerCase().includes(q));
}

export function cycleIndex(current: number, delta: number, length: number): number {
    if (length <= 0) return 0;
    return (((current + delta) % length) + length) % length;
}

export interface RankedTile {
    championId: string;
    score: number;
    rank: number;
}

/** Column-0 nodes → ranked tiles for the champion pane. Single nodes give one
 *  tile each. Pair nodes give one tile per champion (first occurrence keeps the
 *  rank and score). With `partnerOf` (second half of a pair being collected, or
 *  the confirmed half in pair-pending) only pairs containing it count and it is
 *  excluded. */
export function rankedTiles(
    fan: readonly NavigatorTreeNode[],
    partnerOf: string | null
): RankedTile[] {
    const out: RankedTile[] = [];
    const seen = new Set<string>();
    fan.forEach((node, i) => {
        if (partnerOf !== null && !node.championIds.includes(partnerOf)) return;
        for (const championId of node.championIds) {
            if (championId === partnerOf || seen.has(championId)) continue;
            seen.add(championId);
            out.push({ championId, score: node.scores.composite, rank: i + 1 });
        }
    });
    return out;
}
