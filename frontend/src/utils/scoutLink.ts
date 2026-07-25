import type { Team, TeamPlayer } from "@draft-sim/shared-types";
import {
    ROLE_ORDER,
    serializePlayersParam,
    serializeTeamParam,
    type PlayerId
} from "./playerStats";

export type ScoutLinkParams = {
    region: string;
    players: string;
    enemies?: string;
    enemyRegion?: string;
};

const toPlayerId = (p: TeamPlayer): PlayerId => ({
    gameName: p.gameName,
    tagLine: p.tagLine
});

// Five role slots in ROLE_ORDER; a bench (null-role) player never lands in a
// slot. If two players somehow share a role the earlier ordinal wins.
export function rosterToSlots(players: TeamPlayer[]): (PlayerId | null)[] {
    const byOrdinal = [...players].sort((a, b) => a.ordinal - b.ordinal);
    return ROLE_ORDER.map((role) => {
        const match = byOrdinal.find((p) => p.role === role);
        return match ? toPlayerId(match) : null;
    });
}

// A team's scout-side param: slot-form when any role is assigned (curated roles
// survive into the scout view); otherwise the first 5 players by ordinal as an
// unordered list, letting ScoutView.autoAssignRoles infer roles from pools.
export function encodeRosterSide(team: Team): string {
    const players = team.TeamPlayers ?? [];
    const slots = rosterToSlots(players);
    if (slots.some((s) => s !== null)) {
        return serializeTeamParam(slots);
    }
    const firstFive = [...players]
        .sort((a, b) => a.ordinal - b.ordinal)
        .slice(0, ROLE_ORDER.length)
        .map(toPlayerId);
    return serializePlayersParam(firstFive);
}

const hasPlayers = (team: Team | null | undefined): team is Team =>
    !!team && (team.TeamPlayers?.length ?? 0) > 0;

// Keyed on non-empty rosters, NOT linked slots. Zero → null (disable the menu).
// One → single-team scout with that team's region, regardless of which slot it
// occupied (the "team2-only" edge: never emit an empty players side). Two →
// matchup; enemyRegion omitted when it equals the players-side region.
export function buildScoutLink(
    team1: Team | null | undefined,
    team2: Team | null | undefined
): ScoutLinkParams | null {
    const present: Team[] = [];
    if (hasPlayers(team1)) present.push(team1);
    if (hasPlayers(team2)) present.push(team2);

    if (present.length === 0) return null;

    if (present.length === 1) {
        const only = present[0];
        return { region: only.region, players: encodeRosterSide(only) };
    }

    const [a, b] = present;
    return {
        region: a.region,
        players: encodeRosterSide(a),
        enemies: encodeRosterSide(b),
        ...(b.region !== a.region ? { enemyRegion: b.region } : {})
    };
}

// Sole builder of the /scout URL. URLSearchParams applies exactly one encode
// layer; solid-router's useSearchParams applies exactly one decode, so the
// codec's literal separators (#, :, ,) round-trip intact. Both the My Teams
// Scout button and the canvas context-menu onScout call this — do not hand-roll
// the query anywhere else.
export function scoutLinkPath(params: ScoutLinkParams): string {
    const usp = new URLSearchParams();
    usp.set("region", params.region);
    usp.set("players", params.players);
    if (params.enemies) usp.set("enemies", params.enemies);
    if (params.enemyRegion) usp.set("enemyRegion", params.enemyRegion);
    return `/scout?${usp.toString()}`;
}
