import type { Role } from "@draft-sim/shared-types";
import { champions, playableById, sharesById } from "./constants";

export const ROLES: Role[] = ["top", "jungle", "mid", "adc", "support"];

/**
 * Narrows a DOM attribute to `Role` without a type assertion. `getAttribute`
 * is typed `string | null`, and the champion context menu reads the role off
 * the row's `data-role` — so the guard is what keeps `dispatchContextMenu`
 * free of `as Role`.
 */
export const isRole = (value: string | null | undefined): value is Role =>
    value !== null && value !== undefined && ROLES.some((role) => role === value);

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

// Per-role accent colors. Full literal class strings (not interpolated) so
// Tailwind's content scan keeps them. `icon` tints the CSS-masked position
// glyph; `border` accents the main-role hero badge.
export const ROLE_COLOR: Record<Role, { icon: string; border: string }> = {
    top: { icon: "bg-red-400", border: "border-red-400" },
    jungle: { icon: "bg-emerald-400", border: "border-emerald-400" },
    mid: { icon: "bg-blue-400", border: "border-blue-400" },
    adc: { icon: "bg-amber-400", border: "border-amber-400" },
    support: { icon: "bg-purple-400", border: "border-purple-400" }
};

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

// Returns the champion's LISTED roles (champions.json `positions`): the UI's set — tabs, buckets,
// Load defaults, the stale pill, and the gap strip's must/maybe (champion-role-shares D6, D9).
export function getChampionRoles(championId: string): Role[] {
    const champ = champions.find((c) => c.id === championId);
    if (!champ || !champ.positions) return [];
    return champ.positions.map(riotPositionToRole).filter((r): r is Role => r !== null);
}

// Returns the roles the ENGINE may seat the champion in (champions.json `playable`: the listed
// roles plus every role above the refresh's pick-count floor — champion-role-shares § 4.1), or the
// listed roles when the table carries no `playable` (a table from before the field, a hand row).
// The prune's mask, mirrored for the gap strip's `feasible` and the empty-fan reason.
export function getChampionPlayable(championId: string): Role[] {
    const playable = playableById.get(championId);
    if (playable === undefined) return getChampionRoles(championId);
    return playable.map(riotPositionToRole).filter((r): r is Role => r !== null);
}

// Returns the champion's play share in every role (champions.json `positionShares`, 3 dp — a role
// never played is 0), keyed by Role; null when the table carries no shares. The largest share is
// the denominator of every weight (slice B); nothing in slice A reads them.
export function getChampionShares(championId: string): Record<Role, number> | null {
    const shares = sharesById.get(championId);
    if (shares === undefined) return null;
    return {
        top: shares.TOP ?? 0,
        jungle: shares.JUNGLE ?? 0,
        mid: shares.MIDDLE ?? 0,
        adc: shares.BOTTOM ?? 0,
        support: shares.SUPPORT ?? 0
    };
}

// Returns champion IDs that list the given role in their positions.
export function championsInRole(role: Role): string[] {
    return champions
        .filter((c) => (c.positions ?? []).some((p) => riotPositionToRole(p) === role))
        .map((c) => c.id);
}
