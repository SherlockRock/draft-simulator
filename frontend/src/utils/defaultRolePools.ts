import type { Role, RolePoolMap } from "@draft-sim/shared-types";
import { championsInRole } from "./championRoles";

// For v1 the "default pool" per role is the full set of champions playable
// in that role, as listed in champion data. This gives users a sensible
// starting point ("here are all Top laners — narrow down"). A future version
// can trim by meta popularity; the surface (this module) stays the same.
export function getDefaultRolePool(role: Role): string[] {
    return championsInRole(role);
}

export function getDefaultRolePoolMap(): RolePoolMap {
    return {
        top: getDefaultRolePool("top"),
        jungle: getDefaultRolePool("jungle"),
        mid: getDefaultRolePool("mid"),
        adc: getDefaultRolePool("adc"),
        support: getDefaultRolePool("support")
    };
}
