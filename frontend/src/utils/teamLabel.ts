import type { Team, TeamListRow } from "@draft-sim/shared-types";

// Display-only label for a team in a picker: tournament teams are suffixed with
// their tournament so two "DOG"s can be told apart; pickup teams stay plain.
// Never used for what is stored or sent.
export function teamOptionLabel(team: Pick<Team, "name" | "Tournament">): string {
    return team.Tournament ? `${team.name} · ${team.Tournament.name}` : team.name;
}

// Folds a server response row for one team into the cached ["teams"] list.
// The cache holds list rows, so the flag and tournament must survive: take the
// server's when it sends them (it does on every roster/rename response) and
// otherwise keep the cached row's.
export function mergeTeamIntoList(list: TeamListRow[], fresh: Team): TeamListRow[] {
    return list.map((t) =>
        t.id === fresh.id
            ? {
                  ...t,
                  ...fresh,
                  canEditRoster: fresh.canEditRoster ?? t.canEditRoster,
                  Tournament:
                      fresh.Tournament !== undefined ? fresh.Tournament : t.Tournament
              }
            : t
    );
}
