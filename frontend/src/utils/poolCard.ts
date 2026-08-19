import type { Role, RolePoolMap } from "@draft-sim/shared-types";
import { ROLES } from "./championRoles";

/** World px. Fixed in v1 — no resize slice is committed, so no stored size
 *  (design §1.3/§7); fits 8 portrait tiles per row. */
export const POOL_CARD_WIDTH = 440;
export const POOL_PORTRAIT_PX = 40;

export const flexRolesByChampion = (map: RolePoolMap): Map<string, Role[]> => {
    const roleLists = new Map<string, Role[]>();
    for (const role of ROLES) {
        for (const championId of map[role]) {
            const existing = roleLists.get(championId);
            if (existing) existing.push(role);
            else roleLists.set(championId, [role]);
        }
    }
    const flexOnly = new Map<string, Role[]>();
    for (const [championId, roles] of roleLists) {
        if (roles.length > 1) flexOnly.set(championId, roles);
    }
    return flexOnly;
};

export const poolChampionTotal = (map: RolePoolMap): number => {
    const unique = new Set<string>();
    for (const role of ROLES) {
        for (const championId of map[role]) unique.add(championId);
    }
    return unique.size;
};
