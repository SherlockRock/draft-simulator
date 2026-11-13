import type { CanvasGroup, ManagedTeamRow, Team, TeamListRow } from "./schemas";
import { teamOptionLabel } from "./teamLabel";
import { isPlaceholderTeamName } from "./teamLink";

// The team picker's model, as pure functions (TeamNameSelect only renders it).

export type PickerRow =
    | { kind: "team"; team: TeamListRow; label: string }
    | { kind: "restore"; team: ManagedTeamRow; label: string }
    | { kind: "create"; name: string };

const normalize = (value: string) => value.trim().toLowerCase();

// A team that rides in the canvas payload has no canEditRoster (that flag is the
// server's per-viewer answer on GET /api/teams). A payload-only team is read-only
// here: it can be picked, but never matches typed-name inference or blocks Create.
function toListRow(team: Team): TeamListRow {
    return { ...team, canEditRoster: false };
}

// The picker's teams: the /api/teams list plus every Team1/Team2 linked on the
// given canvas groups, deduped by id. The list row wins (it carries the real
// canEditRoster). Adds nothing the canvas payload doesn't already hold.
export function buildPickerTeams(
    listRows: readonly TeamListRow[],
    groups: readonly CanvasGroup[]
): TeamListRow[] {
    const seen = new Set<string>();
    const result: TeamListRow[] = [];
    for (const row of listRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        result.push(row);
    }
    for (const group of groups) {
        for (const team of [group.Team1, group.Team2]) {
            if (!team || seen.has(team.id)) continue;
            seen.add(team.id);
            result.push(toListRow(team));
        }
    }
    return result;
}

// Unique display labels: `name · tournament` for a tournament team (always), then
// any labels still equal case-insensitively get ` · 2`, ` · 3` in id order, the
// first keeping its label.
export function pickerLabels(teams: readonly TeamListRow[]): Map<string, string> {
    const byLabel = new Map<string, TeamListRow[]>();
    for (const team of teams) {
        const key = normalize(teamOptionLabel(team));
        const bucket = byLabel.get(key);
        if (bucket) bucket.push(team);
        else byLabel.set(key, [team]);
    }
    const labels = new Map<string, string>();
    const used = new Set<string>();
    // Keep every first label before inventing suffixes, so a suffixed label can
    // never take a name another team already owns.
    const clashes: TeamListRow[] = [];
    for (const bucket of byLabel.values()) {
        // Your own team keeps the bare label; then id order, so it is stable.
        const sorted = [...bucket].sort(
            (a, b) =>
                Number(b.canEditRoster) - Number(a.canEditRoster) ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
        const [first, ...rest] = sorted;
        const label = teamOptionLabel(first);
        labels.set(first.id, label);
        used.add(normalize(label));
        clashes.push(...rest);
    }
    clashes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const counters = new Map<string, number>();
    for (const team of clashes) {
        const base = teamOptionLabel(team);
        const baseKey = normalize(base);
        let n = counters.get(baseKey) ?? 1;
        let candidate = base;
        do {
            n += 1;
            candidate = `${base} · ${n}`;
        } while (used.has(normalize(candidate)));
        counters.set(baseKey, n);
        used.add(normalize(candidate));
        labels.set(team.id, candidate);
    }
    return labels;
}

// Archived pickup teams the user may restore (input: the ["teamsManage"] teams).
export function archivedOwnedTeams(rows: readonly ManagedTeamRow[]): ManagedTeamRow[] {
    return rows.filter(
        (row) =>
            row.archived_at && !row.tournament_id && !row.Tournament && row.canArchive
    );
}

// The rows TeamNameSelect renders: matching teams, then a restore row per
// archived owned team named exactly the query, then "Create".
export function pickerRows(
    query: string,
    teams: readonly TeamListRow[],
    options: { archivedOwned: readonly ManagedTeamRow[] }
): PickerRow[] {
    const trimmed = query.trim();
    const needle = normalize(query);
    const labels = pickerLabels(teams);
    const archivedOwnedById = new Map(options.archivedOwned.map((t) => [t.id, t]));
    const rows: PickerRow[] = [];
    const offered = new Set<string>();

    for (const team of teams) {
        if (!normalize(team.name).includes(needle)) continue;
        offered.add(team.id);
        const label = labels.get(team.id) ?? team.name;
        // Linked on this canvas but archived (it rides in the canvas payload with
        // archived_at set). Your own: offer the restore, so picking it never links
        // a team that stays archived. Anyone else's: say so.
        const archivedMine = team.archived_at
            ? archivedOwnedById.get(team.id)
            : undefined;
        if (archivedMine) {
            rows.push({ kind: "restore", team: archivedMine, label });
        } else if (team.archived_at) {
            rows.push({ kind: "team", team, label: `${label} (archived)` });
        } else {
            rows.push({ kind: "team", team, label });
        }
    }

    if (needle.length > 0) {
        // Exact name only. A team already offered above is skipped: either it is
        // the archived canvas-linked one (already a restore row), or it was just
        // restored and the archived list has not refetched yet.
        for (const team of options.archivedOwned) {
            if (normalize(team.name) === needle && !offered.has(team.id)) {
                rows.push({ kind: "restore", team, label: teamOptionLabel(team) });
            }
        }
    }

    // Only an active team of your own blocks Create; an archived one doesn't, and
    // an imported or payload-only team of the same name is a different entity.
    const blocked = teams.some(
        (team) =>
            team.canEditRoster && !team.archived_at && normalize(team.name) === needle
    );
    if (trimmed.length > 0 && !isPlaceholderTeamName(trimmed) && !blocked) {
        rows.push({ kind: "create", name: trimmed });
    }
    return rows;
}
