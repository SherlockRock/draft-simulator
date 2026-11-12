import type { TeamListRow } from "@draft-sim/shared-types";

export type TeamLinkResolution = { name: string; teamId: string | null };

// The dialog seeds these when nothing is linked yet. They are placeholders, not
// a choice, so they must never infer a link — otherwise someone who owns a team
// literally called "Team 1" gets it silently attached to every series they
// create without touching the team fields.
const SENTINEL_NAMES = new Set(["team 1", "team 2"]);

const normalize = (value: string) => value.trim().toLowerCase();

// True for the dialog's "Team 1" / "Team 2" seeds (trimmed, case-insensitive).
export function isPlaceholderTeamName(name: string | null | undefined): boolean {
    return typeof name === "string" && SENTINEL_NAMES.has(normalize(name));
}

// Exactly one team the user can edit (their own pickup teams) by that name, or
// nothing. Imported tournament teams never match by name, so typing "DOG" cannot
// silently link a public team; picking one explicitly still links. Ambiguity fails safe: team
// names carry no unique constraint (no index on (owner_id, name), and rename is
// unchecked), so on a duplicate we cannot tell which one was meant — and
// guessing would scout the wrong five players.
export function findTeamByName(name: string, teams: TeamListRow[]): TeamListRow | null {
    const needle = normalize(name);
    if (!needle || isPlaceholderTeamName(needle)) return null;
    const matches = teams.filter(
        (team) => team.canEditRoster && normalize(team.name) === needle
    );
    return matches.length === 1 ? matches[0] : null;
}

// TeamNameSelect clears the linked id on every keystroke, so someone who types a
// team's name and goes straight to Save/Create ends up with free text that LOOKS
// linked — the series header shows the right name, but with no entity behind it
// there is no roster and no Scout button. Treat an unambiguous name match as the
// link they plainly meant, and adopt the entity's own casing so the header and
// the dialog agree on how the team is spelled.
//
// An explicit id always wins: it is the only way to pick between two teams whose
// names differ solely by case or padding. The cost of inferring is that keeping
// the string "MEOW" while deliberately NOT pointing at the MEOW entity is no
// longer expressible — rename the field to unlink.
export function resolveTeamLink(
    name: string,
    teamId: string | null,
    teams: TeamListRow[],
    fallbackName: string
): TeamLinkResolution {
    const trimmed = name.trim();
    if (teamId) return { name: trimmed || fallbackName, teamId };

    const match = findTeamByName(trimmed, teams);
    if (match) return { name: match.name, teamId: match.id };

    return { name: trimmed || fallbackName, teamId: null };
}
