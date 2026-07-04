import type { ChampionStatEntry, PlayerScoutResult, Role } from "@draft-sim/shared-types";

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

export interface RoleStat {
    role: Role;
    games: number;
    wins: number;
}

export interface SharedChampSide {
    games: number;
    wins: number;
    roles: RoleStat[];
}

export interface SharedChamp {
    championId: string;
    you: SharedChampSide;
    enemy: SharedChampSide;
}

// Per-champ totals WITH the per-role breakdown (unlike aggregateChampRows,
// which collapses roles) — popovers need the any-role asymmetry.
function champSideDetail(entries: ChampionStatEntry[]): Map<string, SharedChampSide> {
    const map = new Map<string, SharedChampSide>();
    for (const e of entries) {
        const side = map.get(e.championId) ?? { games: 0, wins: 0, roles: [] };
        side.games += e.games;
        side.wins += e.wins;
        const rs = side.roles.find((r) => r.role === e.role);
        if (rs) {
            rs.games += e.games;
            rs.wins += e.wins;
        } else {
            side.roles.push({ role: e.role, games: e.games, wins: e.wins });
        }
        map.set(e.championId, side);
    }
    for (const side of map.values()) side.roles.sort((a, b) => b.games - a.games);
    return map;
}

// Champion-level intersection of two players' pools (any role — a Sylas ban
// denies both players wherever they play him). Sorted by combined games desc.
export function computeSharedChamps(
    you: ChampionStatEntry[],
    enemy: ChampionStatEntry[]
): SharedChamp[] {
    const yours = champSideDetail(you);
    const theirs = champSideDetail(enemy);
    const out: SharedChamp[] = [];
    for (const [championId, youSide] of yours) {
        const enemySide = theirs.get(championId);
        if (enemySide) out.push({ championId, you: youSide, enemy: enemySide });
    }
    return out.sort(
        (a, b) => b.you.games + b.enemy.games - (a.you.games + a.enemy.games)
    );
}

export interface AssignedPlayer {
    riotId: string;
    assignedRole: Role;
    entries: ChampionStatEntry[];
}

export interface FlexChampPlayer {
    riotId: string;
    assignedRole: Role;
    games: number;
    wins: number;
    roles: RoleStat[];
}

export interface FlexChamp {
    championId: string;
    players: FlexChampPlayer[];
}

// Champs appearing in 2+ teammates' pools (the within-team flex axis).
// Sorted by teammate count desc, then total games desc; players within a
// champ by games desc.
export function computeFlexChamps(team: (AssignedPlayer | null)[]): FlexChamp[] {
    const byChamp = new Map<string, FlexChampPlayer[]>();
    for (const p of team) {
        if (!p) continue;
        for (const [championId, side] of champSideDetail(p.entries)) {
            const list = byChamp.get(championId) ?? [];
            list.push({
                riotId: p.riotId,
                assignedRole: p.assignedRole,
                games: side.games,
                wins: side.wins,
                roles: side.roles
            });
            byChamp.set(championId, list);
        }
    }
    const totalGames = (players: FlexChampPlayer[]) =>
        players.reduce((s, p) => s + p.games, 0);
    return [...byChamp.entries()]
        .filter(([, players]) => players.length >= 2)
        .map(([championId, players]) => ({
            championId,
            players: [...players].sort((a, b) => b.games - a.games)
        }))
        .sort(
            (a, b) =>
                b.players.length - a.players.length ||
                totalGames(b.players) - totalGames(a.players)
        );
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

export const ROLE_ORDER: Role[] = ["top", "jungle", "mid", "adc", "support"];

// A team's five role slots in ROLE_ORDER; null = unfilled role.
export type TeamSlots = (PlayerScoutResult | null)[];

const resultEntries = (r: PlayerScoutResult): ChampionStatEntry[] =>
    r.status === "ok" ? r.envelope.entries : [];

// Proper 1:1 player→role assignment maximizing Σ games(player, assignedRole).
// ≤5 players × 5 roles → exhaustive over injective assignments (≤ 5! = 120),
// no assignment-problem library needed. Strict `>` keeps the FIRST optimum
// found, and roles are tried in ROLE_ORDER per player in input order, so ties
// resolve deterministically: earlier players take earlier roles. Errored /
// no-data players score 0 everywhere and therefore never displace a
// data-backed player from a scoring role.
export function autoAssignRoles(results: PlayerScoutResult[]): TeamSlots {
    const players = results.slice(0, ROLE_ORDER.length);
    const dists = players.map((r) => computeRoleDistribution(resultEntries(r)));

    let best: number[] = [];
    let bestScore = -1;
    const search = (playerIdx: number, remainingRoles: number[], acc: number[]): void => {
        if (playerIdx === players.length) {
            let score = 0;
            for (let p = 0; p < acc.length; p++) score += dists[p][ROLE_ORDER[acc[p]]];
            if (score > bestScore) {
                bestScore = score;
                best = [...acc];
            }
            return;
        }
        for (let i = 0; i < remainingRoles.length; i++) {
            search(
                playerIdx + 1,
                [...remainingRoles.slice(0, i), ...remainingRoles.slice(i + 1)],
                [...acc, remainingRoles[i]]
            );
        }
    };
    search(
        0,
        ROLE_ORDER.map((_, i) => i),
        []
    );

    const slots: TeamSlots = ROLE_ORDER.map(() => null);
    best.forEach((roleIdx, playerIdx) => {
        slots[roleIdx] = players[playerIdx];
    });
    return slots;
}

// The player's most-played role (most games), or null if no entries. Ties break
// toward the earlier role in top→jungle→mid→adc→support order.
export function computeMainRole(entries: ChampionStatEntry[]): Role | null {
    const dist = computeRoleDistribution(entries);
    let best: Role | null = null;
    let bestGames = 0;
    for (const role of ROLE_ORDER) {
        if (dist[role] > bestGames) {
            bestGames = dist[role];
            best = role;
        }
    }
    return best;
}

// URL encoding: each player → "gameName#tag" with both fields percent-encoded
// (so # and , inside a name don't break parsing), joined by commas. The router
// handles the outer URL encoding of the whole value.
const encodeChunk = (p: PlayerId): string =>
    `${encodeURIComponent(p.gameName.trim())}#${encodeURIComponent(p.tagLine.trim())}`;

const decodeChunk = (chunk: string): PlayerId | null => {
    const hash = chunk.indexOf("#");
    if (hash === -1) return null;
    const gameName = decodeURIComponent(chunk.slice(0, hash));
    const tagLine = decodeURIComponent(chunk.slice(hash + 1));
    if (!gameName || !tagLine) return null;
    return { gameName, tagLine };
};

export function serializePlayersParam(players: PlayerId[]): string {
    return players
        .filter((p) => p.gameName.trim() && p.tagLine.trim())
        .map(encodeChunk)
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

export type TeamParam =
    | { kind: "slots"; slots: (PlayerId | null)[] }
    | { kind: "list"; players: PlayerId[] };

// Matchup-mode team param: "s:" prefix + 5 comma-separated slots in ROLE_ORDER,
// empty slot = unfilled role — the role ASSIGNMENT itself is URL state, so
// drag fixes survive refresh/share. Slot-form is explicit because a 5-player
// list and a 5-slot assignment are otherwise byte-identical. ":" is always
// percent-encoded by encodeURIComponent inside names, so the prefix cannot
// collide with player data.
export function serializeTeamParam(slots: (PlayerId | null)[]): string {
    return `s:${slots.map((p) => (p ? encodeChunk(p) : "")).join(",")}`;
}

// "s:" prefix = slot-form, position = role. Anything else = an unordered list
// (legacy links, fresh pastes) that the caller auto-assigns and normalizes.
export function parseTeamParam(raw: string): TeamParam {
    if (!raw) return { kind: "list", players: [] };
    if (raw.startsWith("s:")) {
        const slots = raw
            .slice(2)
            .split(",")
            .map(decodeChunk)
            .slice(0, ROLE_ORDER.length);
        while (slots.length < ROLE_ORDER.length) {
            slots.push(null);
        }
        return { kind: "slots", slots };
    }
    return {
        kind: "list",
        players: raw
            .split(",")
            .map(decodeChunk)
            .filter((p): p is PlayerId => p !== null)
    };
}

// Query-key identity for a team: order- and case-insensitive, so dragging
// players between role slots NEVER refetches.
export function canonicalPlayersKey(players: PlayerId[]): string {
    return players
        .map((p) => `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`)
        .sort()
        .join(",");
}

// op.gg region path segment → our Riot platform code. Unknown codes fall back
// to null (the caller keeps the dropdown selection).
const OPGG_REGION_TO_RIOT: Record<string, string> = {
    na: "na1",
    euw: "euw1",
    eune: "eun1",
    kr: "kr",
    br: "br1",
    oce: "oc1",
    oc: "oc1"
};

export interface ParsedPlayersInput {
    // Region extracted from an op.gg URL, or null when the input is a plain
    // list (the caller then uses the region dropdown).
    region: string | null;
    players: PlayerId[];
}

// Parse a comma-separated "Name#TAG" list (gameName may contain spaces) into
// players. Raw user text — trims, drops malformed chunks, no URL decoding.
function parseRiotIdList(raw: string): PlayerId[] {
    const out: PlayerId[] = [];
    for (const chunk of raw.split(",")) {
        const t = chunk.trim();
        const hash = t.indexOf("#");
        if (hash === -1) continue;
        const gameName = t.slice(0, hash).trim();
        const tagLine = t.slice(hash + 1).trim();
        if (!gameName || !tagLine) continue;
        out.push({ gameName, tagLine });
    }
    return out;
}

// Parse the single scout text field: either a plain "Name#TAG,Name#TAG" list or
// a pasted op.gg multisearch URL (e.g.
// https://op.gg/lol/multisearch/na?summoners=city+mouse%23yum%2C...). For the
// URL form, region is read from the path and players from the `summoners` query
// (URLSearchParams decodes %23/%2C/+ for us).
export function parsePlayersInput(text: string): ParsedPlayersInput {
    const trimmed = text.trim();
    if (!trimmed) return { region: null, players: [] };
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const summoners = url.searchParams.get("summoners") ?? "";
            const m = url.pathname.match(/multisearch\/([^/?#]+)/i);
            const region = m ? (OPGG_REGION_TO_RIOT[m[1].toLowerCase()] ?? null) : null;
            return { region, players: parseRiotIdList(summoners) };
        } catch {
            return { region: null, players: [] };
        }
    }
    return { region: null, players: parseRiotIdList(trimmed) };
}

// Render players back into the plain text-field format ("Name#TAG,Name#TAG"),
// used to seed the field from the URL so a shared scout stays editable.
export function formatPlayersInput(players: PlayerId[]): string {
    return players.map((p) => `${p.gameName}#${p.tagLine}`).join(",");
}
