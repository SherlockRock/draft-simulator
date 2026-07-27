import type { Team, TeamPlayer } from "@draft-sim/shared-types";
import {
    MAX_ROSTER,
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
    // Team UUIDs for roster write-back. `team` names whichever team's roster
    // landed in `players` — NOT whichever slot it occupied on the canvas. The
    // single-team branch below promotes a lone team2 into `players`, and this
    // id follows that promotion; reversing it would write team2's scouted
    // roles onto team1.
    team?: string;
    enemyTeam?: string;
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
// survive into the scout view) with everyone else on the bench; otherwise the
// whole roster as an unordered list, letting ScoutView slot the first five and
// bench the rest.
//
// Neither branch may stop at five. A roster holds ten, and dropping players
// 6-10 here would make the bench unreachable from a linked team — which is the
// shape of any freshly pasted roster, where no role is assigned at all.
export function encodeRosterSide(team: Team): string {
    const byOrdinal = [...(team.TeamPlayers ?? [])].sort((a, b) => a.ordinal - b.ordinal);

    // Bench = every row NOT PLACED in a slot, which is not the same as
    // `role === null`: only the first match per role is placed, so a
    // duplicate-role row would otherwise vanish from the link entirely.
    const placed: TeamPlayer[] = [];
    const slots = ROLE_ORDER.map((role) => {
        const match = byOrdinal.find((p) => p.role === role);
        if (match) placed.push(match);
        return match ? toPlayerId(match) : null;
    });
    if (placed.length > 0) {
        const bench = byOrdinal.filter((p) => !placed.includes(p)).map(toPlayerId);
        return serializeTeamParam(slots, bench);
    }
    // List-form, not slot-form: slot-form would bypass autoAssignRoles and the
    // roles would come from ordinal order.
    return serializePlayersParam(byOrdinal.slice(0, MAX_ROSTER).map(toPlayerId));
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
        return {
            region: only.region,
            players: encodeRosterSide(only),
            team: only.id
        };
    }

    const [a, b] = present;
    return {
        region: a.region,
        players: encodeRosterSide(a),
        enemies: encodeRosterSide(b),
        team: a.id,
        enemyTeam: b.id,
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
    if (params.team) usp.set("team", params.team);
    if (params.enemyTeam) usp.set("enemyTeam", params.enemyTeam);
    return `/scout?${usp.toString()}`;
}
