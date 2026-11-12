// Pure model for the Teams page: grouping, selection and the copy. No
// components, no Solid imports.
import type {
    ManagedTeamRow,
    TeamsManageResponse,
    TeamUseCounts
} from "@draft-sim/shared-types";

export const PAGE_INTRO =
    "Your pickup teams and the teams of leagues you've added. Imported teams come from the league and can't be edited. Archiving hides a team or league from your pickers; it stays linked wherever it's used.";

// ---- Groups ----------------------------------------------------------

export interface TournamentGroup {
    kind: "tournament";
    id: string;
    name: string;
    region: string;
    source: string;
    teams: ManagedTeamRow[];
}

export interface PickupGroup {
    kind: "pickup";
    teams: ManagedTeamRow[];
}

export interface ArchivedGroup {
    kind: "archived";
    // Archived leagues, by name, each with its teams.
    tournaments: TournamentGroup[];
    // The caller's archived pickup teams.
    pickupTeams: ManagedTeamRow[];
}

export type TeamsPageGroup = TournamentGroup | PickupGroup | ArchivedGroup;

function compareNames(a: string, b: string): number {
    const byFold = a.toLowerCase().localeCompare(b.toLowerCase());
    return byFold !== 0 ? byFold : a.localeCompare(b);
}

function sortTeams(teams: ManagedTeamRow[]): ManagedTeamRow[] {
    return [...teams].sort((a, b) => compareNames(a.name, b.name));
}

function sortTournaments(groups: TournamentGroup[]): TournamentGroup[] {
    return [...groups].sort((a, b) => compareNames(a.name, b.name));
}

export function buildTeamsPageGroups(data: TeamsManageResponse): TeamsPageGroup[] {
    const listed = new Map<string, TournamentGroup>();
    const archivedIds = new Set<string>();
    for (const t of data.tournaments) {
        listed.set(t.id, {
            kind: "tournament",
            id: t.id,
            name: t.name,
            region: t.region,
            source: t.source,
            teams: []
        });
        if (t.archived_at) archivedIds.add(t.id);
    }

    const unlisted = new Map<string, TournamentGroup>();
    const pickup: ManagedTeamRow[] = [];
    const archivedPickup: ManagedTeamRow[] = [];

    for (const team of data.teams) {
        const tid = team.tournament_id;
        if (!tid) {
            (team.archived_at ? archivedPickup : pickup).push(team);
            continue;
        }
        const known = listed.get(tid);
        if (known) {
            known.teams.push(team);
            continue;
        }
        // Not in the caller's UserTournaments (e.g. an owned manual-tournament
        // team): build an active group from the team's own Tournament.
        const existing = unlisted.get(tid);
        if (existing) {
            existing.teams.push(team);
        } else {
            unlisted.set(tid, {
                kind: "tournament",
                id: tid,
                name: team.Tournament?.name ?? "Other teams",
                region: team.region,
                source: team.Tournament?.source ?? team.source ?? "manual",
                teams: [team]
            });
        }
    }

    const active: TournamentGroup[] = [];
    const archived: TournamentGroup[] = [];
    for (const g of [...listed.values(), ...unlisted.values()]) {
        const sorted = { ...g, teams: sortTeams(g.teams) };
        (archivedIds.has(g.id) ? archived : active).push(sorted);
    }

    const groups: TeamsPageGroup[] = [
        ...sortTournaments(active),
        { kind: "pickup", teams: sortTeams(pickup) }
    ];
    if (archived.length > 0 || archivedPickup.length > 0) {
        groups.push({
            kind: "archived",
            tournaments: sortTournaments(archived),
            pickupTeams: sortTeams(archivedPickup)
        });
    }
    return groups;
}

// ---- Row text --------------------------------------------------------

// Scratch is counted but shown only in the delete dialog (Q6).
export function useCountLabel(counts: TeamUseCounts): string {
    return `${counts.official} official · ${counts.scrim} scrim`;
}

export function playersLabel(team: ManagedTeamRow): string {
    const n = team.TeamPlayers?.length ?? 0;
    if (n === 0) return "No players";
    return n === 1 ? "1 player" : `${n} players`;
}

// ---- Selection -------------------------------------------------------

// "active" = pickup teams, "archived" = archived pickup teams. A selection
// lives in one scope; picking a row from the other scope replaces it.
export type SelectionScope = "active" | "archived";

export interface Selection {
    scope: SelectionScope;
    ids: ReadonlySet<string>;
}

export function emptySelection(): Selection {
    return { scope: "active", ids: new Set() };
}

// Imported and tournament rows are never selectable, whatever the server flags
// say; only a pickup team (no tournament) with an archive or delete right is.
function isSelectable(team: ManagedTeamRow): boolean {
    return !team.tournament_id && (team.canArchive || team.canDelete);
}

function scopeOf(team: ManagedTeamRow): SelectionScope {
    return team.archived_at ? "archived" : "active";
}

function groupTeams(group: TeamsPageGroup): ManagedTeamRow[] {
    switch (group.kind) {
        case "tournament":
        case "pickup":
            return group.teams;
        case "archived":
            return [...group.pickupTeams, ...group.tournaments.flatMap((t) => t.teams)];
    }
}

export function selectableIds(group: TeamsPageGroup): string[] {
    return groupTeams(group)
        .filter(isSelectable)
        .map((t) => t.id);
}

export function toggleSelected(
    sel: Selection,
    id: string,
    scope: SelectionScope
): Selection {
    const ids = new Set(sel.scope === scope ? sel.ids : []);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { scope, ids };
}

export function toggleGroupSelected(
    sel: Selection,
    ids: readonly string[],
    scope: SelectionScope
): Selection {
    const next = new Set(sel.scope === scope ? sel.ids : []);
    const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
    for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
    }
    return { scope, ids: next };
}

// After a refetch: keep only ids still present, selectable and in the
// selection's scope.
export function pruneSelection(sel: Selection, data: TeamsManageResponse): Selection {
    const keep = new Set<string>();
    for (const team of data.teams) {
        if (sel.ids.has(team.id) && isSelectable(team) && scopeOf(team) === sel.scope) {
            keep.add(team.id);
        }
    }
    return { scope: sel.scope, ids: keep };
}

export interface SelectionSummary {
    count: number;
    uses: TeamUseCounts;
    canArchive: boolean;
    canRestore: boolean;
    canDelete: boolean;
}

export function selectionSummary(
    sel: Selection,
    rows: readonly ManagedTeamRow[]
): SelectionSummary {
    const picked = rows.filter((r) => sel.ids.has(r.id));
    const uses: TeamUseCounts = {
        official: 0,
        scrim: 0,
        scratch: 0,
        total: 0
    };
    for (const r of picked) {
        uses.official += r.useCounts.official;
        uses.scrim += r.useCounts.scrim;
        uses.scratch += r.useCounts.scratch;
        uses.total += r.useCounts.total;
    }
    const some = picked.length > 0;
    const allArchivable = some && picked.every((r) => r.canArchive);
    return {
        count: picked.length,
        uses,
        canArchive: sel.scope === "active" && allArchivable,
        canRestore: sel.scope === "archived" && allArchivable,
        canDelete: some && picked.every((r) => r.canDelete)
    };
}

// ---- Delete confirmation --------------------------------------------

function breakdown(uses: TeamUseCounts): string {
    const parts: string[] = [];
    if (uses.official > 0) parts.push(`${uses.official} official`);
    if (uses.scrim > 0) parts.push(`${uses.scrim} scrim`);
    if (uses.scratch > 0) parts.push(`${uses.scratch} scratch`);
    return parts.join(", ");
}

// Callers must pass a non-empty list (the dialog opens only with a selection).
export function deleteConfirmText(rows: readonly ManagedTeamRow[]): string {
    const total = rows.reduce((n, r) => n + r.useCounts.total, 0);
    const uses: TeamUseCounts = {
        official: rows.reduce((n, r) => n + r.useCounts.official, 0),
        scrim: rows.reduce((n, r) => n + r.useCounts.scrim, 0),
        scratch: rows.reduce((n, r) => n + r.useCounts.scratch, 0),
        total
    };
    const single = rows.length === 1;
    const subject = single ? `Delete ${rows[0].name}?` : `Delete ${rows.length} teams?`;
    if (total === 0) {
        return single
            ? `${subject} It isn't linked to any series on your canvases. This can't be undone.`
            : `${subject} They aren't linked to any series on your canvases. This can't be undone.`;
    }
    const parts = breakdown(uses);
    const linked = `${total} series on your canvases${parts ? ` (${parts})` : ""}`;
    return single
        ? `${subject} It's linked to ${linked}. Those series keep its name as plain text. This can't be undone.`
        : `${subject} They're linked to ${linked}. Those series keep their names as plain text. This can't be undone.`;
}
