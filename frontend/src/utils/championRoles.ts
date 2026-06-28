import type { Role } from "@draft-sim/shared-types";
import { champions } from "./constants";

export const ROLES: Role[] = ["top", "jungle", "mid", "adc", "support"];

export const ROLE_LABELS: Record<Role, string> = {
    top: "Top",
    jungle: "Jungle",
    mid: "Mid",
    adc: "ADC",
    support: "Support"
};

// CommunityDragon position icons (same source RoleFilter uses).
const ROLE_ICON_CDN =
    "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg";

const ROLE_ICON_SLUG: Record<Role, string> = {
    top: "position-top",
    jungle: "position-jungle",
    mid: "position-middle",
    adc: "position-bottom",
    support: "position-utility"
};

export function roleIconUrl(role: Role): string {
    return `${ROLE_ICON_CDN}/${ROLE_ICON_SLUG[role]}.svg`;
}

// Resolve a champion alias (the envelope's championId, = champion.id) to its
// square icon URL, or undefined when unknown.
export function getChampionImg(championId: string): string | undefined {
    return champions.find((c) => c.id === championId)?.img;
}

// Map Riot-convention position strings to our lowercase Role vocabulary.
const RIOT_POSITION_TO_ROLE: Record<string, Role> = {
    TOP: "top",
    JUNGLE: "jungle",
    MIDDLE: "mid",
    BOTTOM: "adc",
    SUPPORT: "support"
};

export function riotPositionToRole(position: string): Role | null {
    return RIOT_POSITION_TO_ROLE[position] ?? null;
}

// Returns the champion's primary role (first position in their data).
// Returns null if the champion has no known positions.
export function getChampionPrimaryRole(championId: string): Role | null {
    const champ = champions.find((c) => c.id === championId);
    if (!champ || !champ.positions || champ.positions.length === 0) return null;
    return riotPositionToRole(champ.positions[0]);
}

// Returns all roles a champion is playable in.
export function getChampionRoles(championId: string): Role[] {
    const champ = champions.find((c) => c.id === championId);
    if (!champ || !champ.positions) return [];
    return champ.positions.map(riotPositionToRole).filter((r): r is Role => r !== null);
}

// Returns champion IDs that list the given role in their positions.
export function championsInRole(role: Role): string[] {
    return champions
        .filter((c) => (c.positions ?? []).some((p) => riotPositionToRole(p) === role))
        .map((c) => c.id);
}
