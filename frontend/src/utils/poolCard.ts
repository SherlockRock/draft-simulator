import type { Role, RolePoolMap } from "@draft-sim/shared-types";
import { ROLES } from "./championRoles";
import { champions as catalogChampions } from "./constants";

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

/** Drops champion ids that no longer exist in the live catalog (e.g. a saved
 *  pool captured before a champion was removed/renamed upstream) and reports
 *  how many were dropped so the caller can toast about it. Lifted from
 *  `SavedPoolDropdown.tsx` (navigator) so the canvas creation flow can reuse
 *  the exact same dropped-count semantics — navigator behavior unchanged. */
export const sanitizeAgainstCatalog = (
    map: RolePoolMap
): { champions: RolePoolMap; droppedCount: number } => {
    const validIds = new Set(catalogChampions.map((c) => c.id));
    let dropped = 0;
    const next: RolePoolMap = {
        top: [],
        jungle: [],
        mid: [],
        adc: [],
        support: []
    };
    for (const role of ROLES) {
        for (const id of map[role] ?? []) {
            if (validIds.has(id)) {
                next[role].push(id);
            } else {
                dropped += 1;
            }
        }
    }
    return { champions: next, droppedCount: dropped };
};
