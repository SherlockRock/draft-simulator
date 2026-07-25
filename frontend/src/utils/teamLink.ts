import type { Team } from "@draft-sim/shared-types";

// TeamNameSelect clears the linked id on every keystroke, so someone who types
// a team's name and goes straight to Save/Create ends up with free text that
// LOOKS linked — the series header shows the right name, but with no entity
// behind it there is no roster and no Scout button. Treat an exact name match
// against the user's own teams as the link they plainly meant.
//
// An explicit id always wins: it is the only way to distinguish two teams whose
// names differ solely by case or padding.
export function resolveTeamIdByName(
    name: string,
    teamId: string | null,
    teams: Team[]
): string | null {
    if (teamId) return teamId;
    const needle = name.trim().toLowerCase();
    if (!needle) return null;
    const match = teams.find((team) => team.name.trim().toLowerCase() === needle);
    return match ? match.id : null;
}
