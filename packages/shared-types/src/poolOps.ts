import type { Role, RolePoolMap } from "./schemas.js";

const ROLE_ORDER: Role[] = ["top", "jungle", "mid", "adc", "support"];

export type PoolChampionOp =
  | { type: "add"; role: Role; championId: string }
  | { type: "remove"; role: Role; championId: string }
  // Within-role order is user-meaningful (priority/tier), so it needs an op of
  // its own — add/remove are set semantics and cannot express "move to index
  // 2". This carries the WHOLE bucket order rather than an index move: indices
  // shift under concurrent edits, and the pending-op queue (collapsed per
  // role+champion) has no correct answer for two racing index moves. As a
  // whole-bucket permutation it is self-healing instead — see
  // applyPoolRoleOrder.
  | { type: "reorder"; role: Role; championIds: string[] };

/**
 * Applies `championIds` as an ORDER over the bucket, not as its contents:
 * ids still present are taken in the given order, ids the list never mentioned
 * keep their relative order and are appended, and ids no longer in the bucket
 * are dropped.
 *
 * That asymmetry is the point. A reorder is computed against the bucket the
 * user could see, then travels; by the time it lands, a collaborator may have
 * added or removed a champion. Treating the payload as contents would revert
 * their edit — treating it as an order preserves both: their membership change
 * survives, this client's ordering intent survives.
 */
export function applyPoolRoleOrder(
  map: RolePoolMap,
  role: Role,
  championIds: string[]
): RolePoolMap {
  const bucket = map[role];
  const ordered: string[] = [];
  for (const championId of championIds) {
    if (bucket.includes(championId) && !ordered.includes(championId)) {
      ordered.push(championId);
    }
  }
  for (const championId of bucket) {
    if (!ordered.includes(championId)) ordered.push(championId);
  }
  return { ...map, [role]: ordered };
}

/**
 * Idempotent set semantics (design D4): add dedupes, remove of a missing id
 * no-ops. Always returns a NEW map object — callers write the result into
 * stores/models and rely on reference change for change detection.
 */
export function applyPoolChampionOp(
  map: RolePoolMap,
  op: PoolChampionOp
): RolePoolMap {
  if (op.type === "reorder") {
    return applyPoolRoleOrder(map, op.role, op.championIds);
  }
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
 *
 * A trailing reorder pass closes the gap that `add` always APPENDS: once order
 * is meaningful, replaying removes+adds alone reproduces `after`'s membership
 * but not necessarily its order. Emitted only for roles where the post-add
 * order actually differs, so a pure membership edit still diffs to exactly the
 * ops it did before.
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
  // Replay what we have so far to see the order the membership ops leave
  // behind, and only correct the roles that still disagree.
  const replayed = ops.reduce(applyPoolChampionOp, before);
  for (const role of ROLE_ORDER) {
    const settled = replayed[role];
    const target = after[role];
    const sameOrder =
      settled.length === target.length &&
      settled.every((championId, i) => championId === target[i]);
    if (!sameOrder) {
      ops.push({ type: "reorder", role, championIds: [...target] });
    }
  }
  return ops;
}
