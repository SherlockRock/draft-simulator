import type { ChampionStatEntry, Role } from "@draft-sim/shared-types";

export interface ChampRow {
    championId: string;
    games: number;
    wins: number;
}

export interface PlayerTotals {
    games: number;
    wins: number;
    losses: number;
    winrate: number;
}

export interface PlayerId {
    gameName: string;
    tagLine: string;
}

// Aggregate per-(champ, role) entries into per-champ totals, sorted by games
// played descending — op.gg's champion-list ordering.
export function aggregateChampRows(entries: ChampionStatEntry[]): ChampRow[] {
    const map = new Map<string, ChampRow>();
    for (const e of entries) {
        const row = map.get(e.championId) ?? {
            championId: e.championId,
            games: 0,
            wins: 0
        };
        row.games += e.games;
        row.wins += e.wins;
        map.set(e.championId, row);
    }
    return [...map.values()].sort((a, b) => b.games - a.games);
}

export function computeTotals(rows: ChampRow[]): PlayerTotals {
    const games = rows.reduce((s, r) => s + r.games, 0);
    const wins = rows.reduce((s, r) => s + r.wins, 0);
    return {
        games,
        wins,
        losses: games - wins,
        winrate: games ? Math.round((wins / games) * 100) : 0
    };
}

export function computeRoleDistribution(
    entries: ChampionStatEntry[]
): Record<Role, number> {
    const dist: Record<Role, number> = {
        top: 0,
        jungle: 0,
        mid: 0,
        adc: 0,
        support: 0
    };
    for (const e of entries) dist[e.role] += e.games;
    return dist;
}

export function winrateColor(wr: number): string {
    return wr >= 60 ? "text-orange-400" : wr >= 50 ? "text-blue-300" : "text-slate-400";
}

// URL encoding: each player → "gameName#tag" with both fields percent-encoded
// (so # and , inside a name don't break parsing), joined by commas. The router
// handles the outer URL encoding of the whole value.
export function serializePlayersParam(players: PlayerId[]): string {
    return players
        .filter((p) => p.gameName.trim() && p.tagLine.trim())
        .map(
            (p) =>
                `${encodeURIComponent(p.gameName.trim())}#${encodeURIComponent(
                    p.tagLine.trim()
                )}`
        )
        .join(",");
}

export function parsePlayersParam(raw: string): PlayerId[] {
    if (!raw) return [];
    const out: PlayerId[] = [];
    for (const chunk of raw.split(",")) {
        const hash = chunk.indexOf("#");
        if (hash === -1) continue;
        const gameName = decodeURIComponent(chunk.slice(0, hash));
        const tagLine = decodeURIComponent(chunk.slice(hash + 1));
        if (!gameName || !tagLine) continue;
        out.push({ gameName, tagLine });
    }
    return out;
}
