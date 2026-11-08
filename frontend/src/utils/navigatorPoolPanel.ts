import type { Role, RolePoolMap } from "@draft-sim/shared-types";
import type { NavigatorTreeNode } from "../contexts/NavigatorContext";
import { normalizeName } from "./championNameResolver";
import { ROLES, championsInRole } from "./championRoles";
import { rankedTiles } from "./navigatorPalette";
import { otherSide, seatMarginals, topSeating, type Side } from "./navigatorSeats";

// Navigator UX push design § 5 (pool panel) and § 6 (search, highlight, arrows): the pure rules
// behind NavigatorPoolPanel.tsx, so the component only renders them.

export type PoolView = "yours" | "enemy" | "all";

export interface PoolTurn {
    slot: number;
    type: "ban" | "pick";
    side: Side;
    /** 2 at a pair-start slot (7, 9, 17): the panel collects two champions. */
    collect: 1 | 2;
    /** Pair-pending: the confirmed half, so ranked tiles are its partners. */
    partnerOf: string | null;
}

/** U11: `yours` on our pick turn; `enemy` on any ban turn and on the opponent's pick turn. */
export function defaultPoolView(
    turn: { type: "ban" | "pick"; side: Side } | null,
    ourSide: Side
): PoolView {
    if (!turn) return "yours";
    if (turn.type === "ban") return "enemy";
    return turn.side === ourSide ? "yours" : "enemy";
}

export function poolSideFor(view: PoolView, ourSide: Side): Side | null {
    if (view === "yours") return ourSide;
    if (view === "enemy") return otherSide(ourSide);
    return null;
}

export interface PoolTile {
    championId: string;
    name: string;
    score: number | null;
    rank: number | null;
    disabled: boolean;
}
export type PoolColumnStatus =
    | { kind: "open" }
    | { kind: "taken"; occupant: string; pct: number };
export interface PoolColumn {
    role: Role;
    status: PoolColumnStatus;
    /** Open columns are lit; filled ones dimmed (design § 5). */
    lit: boolean;
    tiles: PoolTile[];
}

export interface PoolColumnsInput {
    /** The side's display buckets, or null for the `all` view (championsInRole). */
    display: RolePoolMap | null;
    /** The confirmed picks of the side whose seating lights the columns. */
    picks: readonly string[];
    fan: readonly NavigatorTreeNode[];
    partnerOf: string | null;
    unavailable: ReadonlySet<string>;
    nameOf: (id: string) => string;
}

/** Five columns in seat order; tiles = engine candidates first in engine order (score badge),
 *  then the rest alphabetically; used / excluded champions and the pair partner disabled. */
export function poolColumns(input: PoolColumnsInput): PoolColumn[] {
    const seating = topSeating(input.picks);
    const marginals = seatMarginals(input.picks);
    const ranked = new Map(
        rankedTiles(input.fan, input.partnerOf).map((t) => [
            t.championId,
            { score: t.score, rank: t.rank }
        ])
    );
    return ROLES.map((role): PoolColumn => {
        const occupant = seating?.[role] ?? null;
        const status: PoolColumnStatus =
            occupant === null
                ? { kind: "open" }
                : {
                      kind: "taken",
                      occupant,
                      pct: Math.round((marginals.get(occupant)?.[role] ?? 0) * 100)
                  };
        const bucket = input.display ? input.display[role] : championsInRole(role);
        const tiles = [...new Set(bucket)].map((championId): PoolTile => {
            const r = ranked.get(championId);
            return {
                championId,
                name: input.nameOf(championId),
                score: r?.score ?? null,
                rank: r?.rank ?? null,
                disabled:
                    input.unavailable.has(championId) || championId === input.partnerOf
            };
        });
        tiles.sort((a, b) => {
            if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
            if (a.rank !== null) return -1;
            if (b.rank !== null) return 1;
            return a.name.localeCompare(b.name);
        });
        return { role, status, lit: status.kind === "open", tiles };
    });
}

/** 0 = the normalised name or id STARTS with the query, 1 = contains it; absent = no match.
 *  Empty for an empty query (nothing is filtered then). */
export function matchQuery(
    query: string,
    tiles: readonly PoolTile[]
): Map<string, 0 | 1> {
    const q = normalizeName(query);
    const out = new Map<string, 0 | 1>();
    if (q === "") return out;
    for (const t of tiles) {
        const name = normalizeName(t.name);
        const id = normalizeName(t.championId);
        if (name.startsWith(q) || id.startsWith(q)) out.set(t.championId, 0);
        else if (name.includes(q) || id.includes(q)) {
            if (!out.has(t.championId)) out.set(t.championId, 1);
        }
    }
    return out;
}

/** The tiles the arrows walk: enabled ones, and with a query only the matches. */
export function visibleTiles(
    column: PoolColumn,
    matches: ReadonlyMap<string, 0 | 1>
): PoolTile[] {
    return column.tiles.filter(
        (t) => !t.disabled && (matches.size === 0 || matches.has(t.championId))
    );
}

export interface Highlight {
    col: number;
    idx: number;
}
export const TILES_PER_ROW = 5;

/** Design § 6: the first match in the first LIT column (a prefix match before a contains match);
 *  dim columns only when no lit column matches; null without a query. */
export function initialHighlight(
    columns: readonly PoolColumn[],
    matches: ReadonlyMap<string, 0 | 1>
): Highlight | null {
    if (matches.size === 0) return null;
    const order = [...columns.keys()].sort(
        (a, b) => Number(columns[b].lit) - Number(columns[a].lit) || a - b
    );
    for (const rank of [0, 1]) {
        for (const col of order) {
            const vis = visibleTiles(columns[col], matches);
            const idx = vis.findIndex((t) => matches.get(t.championId) === rank);
            if (idx >= 0) return { col, idx };
        }
    }
    return null;
}

export function highlightedId(
    columns: readonly PoolColumn[],
    matches: ReadonlyMap<string, 0 | 1>,
    h: Highlight | null
): string | null {
    if (!h) return null;
    const column = columns[h.col];
    if (!column) return null;
    return visibleTiles(column, matches)[h.idx]?.championId ?? null;
}

/** Left/right within the row, crossing columns at the edge (same row, clamped); up/down within
 *  the column. From null, the first visible tile of the first column that has one. */
export function moveHighlight(
    columns: readonly PoolColumn[],
    matches: ReadonlyMap<string, 0 | 1>,
    h: Highlight | null,
    dir: "left" | "right" | "up" | "down"
): Highlight | null {
    const lens = columns.map((c) => visibleTiles(c, matches).length);
    if (!h) {
        const col = lens.findIndex((n) => n > 0);
        return col === -1 ? null : { col, idx: 0 };
    }
    const len = lens[h.col] ?? 0;
    const row = Math.floor(h.idx / TILES_PER_ROW);
    if (dir === "down")
        return h.idx + TILES_PER_ROW < len
            ? { col: h.col, idx: h.idx + TILES_PER_ROW }
            : h;
    if (dir === "up")
        return h.idx - TILES_PER_ROW >= 0
            ? { col: h.col, idx: h.idx - TILES_PER_ROW }
            : h;
    if (dir === "right") {
        if (h.idx % TILES_PER_ROW < TILES_PER_ROW - 1 && h.idx + 1 < len)
            return { col: h.col, idx: h.idx + 1 };
        for (let col = h.col + 1; col < lens.length; col++)
            if (lens[col] > 0)
                return { col, idx: Math.min(row * TILES_PER_ROW, lens[col] - 1) };
        return h;
    }
    if (h.idx % TILES_PER_ROW > 0) return { col: h.col, idx: h.idx - 1 };
    for (let col = h.col - 1; col >= 0; col--)
        if (lens[col] > 0)
            return {
                col,
                idx: Math.min(row * TILES_PER_ROW + TILES_PER_ROW - 1, lens[col] - 1)
            };
    return h;
}

/** "Swain · ↵ picks" when exactly one champion matches (design § 6). */
export function singleMatchLabel(
    matches: ReadonlyMap<string, 0 | 1>,
    verb: "picks" | "bans",
    nameOf: (id: string) => string
): string | null {
    if (matches.size !== 1) return null;
    const [id] = matches.keys();
    return `${nameOf(id)} · ↵ ${verb}`;
}
