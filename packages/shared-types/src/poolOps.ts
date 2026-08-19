import type { Role, RolePoolMap } from "./schemas.js";

const ROLE_ORDER: Role[] = ["top", "jungle", "mid", "adc", "support"];

export type PoolChampionOp =
  | { type: "add"; role: Role; championId: string }
  | { type: "remove"; role: Role; championId: string };

/**
 * Idempotent set semantics (design D4): add dedupes, remove of a missing id
 * no-ops. Always returns a NEW map object — callers write the result into
 * stores/models and rely on reference change for change detection.
 */
export function applyPoolChampionOp(
  map: RolePoolMap,
  op: PoolChampionOp
): RolePoolMap {
  const bucket = map[op.role];
  if (op.type === "add") {
    if (bucket.includes(op.championId)) return { ...map };
    return { ...map, [op.role]: [...bucket, op.championId] };
  }
  return { ...map, [op.role]: bucket.filter((id) => id !== op.championId) };
}

/**
 * The overlay's diff-as-ops commit (design D4): removes first, then adds,
 * role-major in ROLE_ORDER — deterministic so tests assert exact sequences.
 */
export function diffRolePoolMaps(
  before: RolePoolMap,
  after: RolePoolMap
): PoolChampionOp[] {
  const ops: PoolChampionOp[] = [];
  for (const role of ROLE_ORDER) {
    for (const championId of before[role]) {
      if (!after[role].includes(championId)) {
        ops.push({ type: "remove", role, championId });
      }
    }
  }
  for (const role of ROLE_ORDER) {
    for (const championId of after[role]) {
      if (!before[role].includes(championId)) {
        ops.push({ type: "add", role, championId });
      }
    }
  }
  return ops;
}
