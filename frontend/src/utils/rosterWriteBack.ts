import type { Team, TeamPlayer, RosterInput } from "@draft-sim/shared-types";
import { MAX_ROSTER, ROLE_ORDER, type PlayerId } from "./playerStats";

// Mirrors MAX_ROSTER in backend/routes/teams.js. Defined in playerStats.ts,
// which needs it to cap the URL bench; re-exported here for existing consumers.
export { MAX_ROSTER };

export type MergeResult =
    | { ok: true; players: RosterInput[] }
    | { ok: false; reason: "over-cap"; count: number };

const key = (p: { gameName: string; tagLine: string }): string =>
    `${p.gameName.trim().toLowerCase()}#${p.tagLine.trim().toLowerCase()}`;

// Folds the scouted lineup — 5 role slots plus the URL bench — into a team's
// (at most 10) roster. The result is a UNION: URL slots, then the URL bench,
// then any stored player the URL did not account for. A legacy link with no
// bench therefore cannot delete anyone; those stored players simply come back.
//
// Roles come EXCLUSIVELY from the slots: every other emitted player has role
// null. That makes the backend's duplicate-role 400 impossible by construction
// — a stale slot-holder can never collide with a newly-assigned one. The
// corollary is that a player dropped from the scouted lineup is demoted to the
// bench, never deleted.
//
// Dedup is deliberately ONE-WAY and BY COUNT. A stored row is dropped when that
// identity was promoted into a slot (decision 27: promotion collapses every
// copy), and otherwise only as far as the URL bench already represents it. Two
// identical rows are legal — there is no unique constraint and the roster
// editor's paste accepts "A#1,A#1" — so a set-membership test would silently
// delete one, which is the very data loss this function exists to prevent.
//
// Output order IS display order: slots in ROLE_ORDER, then the URL bench in URL
// order, then the remaining stored players in ordinal order. The server assigns
// `ordinal` by array index.
export function mergeScoutedRoster(
    existing: TeamPlayer[],
    slots: (PlayerId | null)[],
    urlBench: PlayerId[] = []
): MergeResult {
    const byOrdinal = [...existing].sort((a, b) => a.ordinal - b.ordinal);

    // First occurrence wins, so the surviving spelling is deterministic.
    const stored = new Map<string, TeamPlayer>();
    const storedCount = new Map<string, number>();
    byOrdinal.forEach((p) => {
        const k = key(p);
        if (!stored.has(k)) stored.set(k, p);
        storedCount.set(k, (storedCount.get(k) ?? 0) + 1);
    });

    const players: RosterInput[] = [];
    const slotKeys = new Set<string>();

    // Prefer the stored spelling everywhere below, so a case difference in the
    // URL never rewrites the roster's canonical casing.
    const spell = (p: PlayerId): { gameName: string; tagLine: string } => {
        const known = stored.get(key(p));
        return {
            gameName: (known?.gameName ?? p.gameName).trim(),
            tagLine: (known?.tagLine ?? p.tagLine).trim()
        };
    };

    slots.slice(0, ROLE_ORDER.length).forEach((slot, index) => {
        if (!slot) return;
        const k = key(slot);
        if (slotKeys.has(k)) return;
        slotKeys.add(k);
        players.push({ role: ROLE_ORDER[index], ...spell(slot) });
    });

    // The URL bench is NOT deduped against the slots: a roster may legitimately
    // hold the same identity twice, and the URL saying so is the only evidence
    // of it that survives a paste.
    const urlBenchCount = new Map<string, number>();
    urlBench.forEach((p) => {
        const k = key(p);
        urlBenchCount.set(k, (urlBenchCount.get(k) ?? 0) + 1);
        players.push({ role: null, ...spell(p) });
    });

    // Stored players the URL did not account for. Per identity: none if it was
    // promoted into a slot, otherwise however many copies the URL bench is
    // short of.
    const carriedOver = new Map<string, number>();
    byOrdinal.forEach((p) => {
        const k = key(p);
        if (slotKeys.has(k)) return;
        const quota = Math.max(
            0,
            (storedCount.get(k) ?? 0) - (urlBenchCount.get(k) ?? 0)
        );
        const already = carriedOver.get(k) ?? 0;
        if (already >= quota) return;
        carriedOver.set(k, already + 1);
        players.push({
            role: null,
            gameName: p.gameName.trim(),
            tagLine: p.tagLine.trim()
        });
    });

    if (players.length > MAX_ROSTER) {
        return { ok: false, reason: "over-cap", count: players.length };
    }
    return { ok: true, players };
}

// `fetchTeams` returns ONLY teams the user owns, so resolving an id against
// that list IS the ownership check — a shared scout link naming someone else's
// team resolves to null and arms nothing.
export function resolveWriteBackTeam(teamId: string, teams: Team[]): Team | null {
    if (!teamId) return null;
    return teams.find((t) => t.id === teamId) ?? null;
}

// Decision 26a. `setSearchParams` merges, so a stale `team` id would otherwise
// outlive the roster it describes and a later drag would write a DIFFERENT
// team's players onto it. Overlap — not equality — is the test, because a
// scout link carries at most 5 of up to 10 players and decision 27 explicitly
// supports appending a sub, which must not disarm.
export function shouldStayArmed(
    rosterPlayers: TeamPlayer[],
    submitted: PlayerId[]
): boolean {
    if (submitted.length === 0) return false;
    const rosterKeys = new Set(rosterPlayers.map(key));
    return submitted.some((p) => rosterKeys.has(key(p)));
}
