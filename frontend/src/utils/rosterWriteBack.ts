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

// Folds the (at most 5) scouted role slots into a team's (at most 10) roster.
//
// Roles come EXCLUSIVELY from the slots: every surviving non-slotted player is
// emitted with role null. That makes the backend's duplicate-role 400
// impossible by construction — a stale slot-holder can never collide with a
// newly-assigned one. The corollary is that a player dropped from the scouted
// lineup is demoted to the bench, never deleted.
//
// Dedup is deliberately ONE-WAY: a bench row is dropped only when that same
// identity was promoted into a slot. The bench is NOT deduped against itself,
// because two identical rows are legal (no unique constraint; the roster
// editor's paste accepts them) and collapsing them would be the very data loss
// this function exists to prevent.
//
// Output order IS display order: slots in ROLE_ORDER, then surviving bench in
// existing ordinal order. The server assigns `ordinal` by array index.
export function mergeScoutedRoster(
    existing: TeamPlayer[],
    slots: (PlayerId | null)[]
): MergeResult {
    const byOrdinal = [...existing].sort((a, b) => a.ordinal - b.ordinal);

    // First occurrence wins, so the surviving spelling is deterministic.
    const stored = new Map<string, TeamPlayer>();
    byOrdinal.forEach((p) => {
        const k = key(p);
        if (!stored.has(k)) stored.set(k, p);
    });

    const players: RosterInput[] = [];
    const slotKeys = new Set<string>();

    slots.slice(0, ROLE_ORDER.length).forEach((slot, index) => {
        if (!slot) return;
        const k = key(slot);
        if (slotKeys.has(k)) return;
        slotKeys.add(k);
        // Prefer the stored spelling so a case difference in the URL never
        // rewrites the roster's canonical casing.
        const known = stored.get(k);
        players.push({
            role: ROLE_ORDER[index],
            gameName: (known?.gameName ?? slot.gameName).trim(),
            tagLine: (known?.tagLine ?? slot.tagLine).trim()
        });
    });

    byOrdinal.forEach((p) => {
        if (slotKeys.has(key(p))) return;
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
