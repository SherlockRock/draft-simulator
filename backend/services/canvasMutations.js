const Draft = require("../models/Draft");
const {
  UserCanvas,
  CanvasDraft,
  CanvasGroup,
  CanvasPoolPlacement,
} = require("../models/Canvas");
const {
  getRestrictedChampionsForGroup,
} = require("../utils/draftRestrictions");
const sequelize = require("../config/database");
const Pool = require("../models/Pool");
const {
  applyPoolChampionOp,
  RolePoolMapSchema,
  RoleSchema,
} = require("@draft-sim/shared-types");

// Canvas Mutation Gate (see CONTEXT.md): the single seam for "may this actor
// change this Canvas-related thing, and apply it if so." Persisted mutations
// run authorize → validate → persist → broadcast; ephemeral relays run
// authorize → broadcast only. The gate owns room targeting and event
// vocabulary via the injected emitter, and throws uniform typed errors that
// adapters translate (socket → error event, REST → status code).

class CanvasMutationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

// Unauthenticated (no user) and forbidden (insufficient permission) are
// separate codes so REST adapters can map them to 401 vs 403.
class NotAuthenticatedError extends CanvasMutationError {
  constructor(message = "Authentication required") {
    super(message, "NOT_AUTHENTICATED");
  }
}

class NotAuthorizedError extends CanvasMutationError {
  constructor(message = "Not authorized") {
    super(message, "NOT_AUTHORIZED");
  }
}

class DraftLockedError extends CanvasMutationError {
  constructor(message = "Draft is locked") {
    super(message, "DRAFT_LOCKED");
  }
}

class ChampionRestrictedError extends CanvasMutationError {
  constructor(message = "Champion is restricted") {
    super(message, "CHAMPION_RESTRICTED");
  }
}

class InvalidMutationError extends CanvasMutationError {
  constructor(message = "Invalid mutation payload") {
    super(message, "INVALID_MUTATION");
  }
}

const PERMISSION_RANK = { view: 0, edit: 1, admin: 2 };

function meetsLevel(permissions, level) {
  const held = PERMISSION_RANK[permissions];
  const required = PERMISSION_RANK[level];
  return held !== undefined && required !== undefined && held >= required;
}

async function checkCanvasAccess({ userId, canvasId, level = "edit" }) {
  if (!userId) return null;

  const userCanvas = await UserCanvas.findOne({
    where: { canvas_id: canvasId, user_id: userId },
  });
  if (!userCanvas || !meetsLevel(userCanvas.permissions, level)) {
    return null;
  }
  return userCanvas;
}

async function assertCanvasAccess({ userId, canvasId, level = "edit" }) {
  if (!userId) {
    throw new NotAuthenticatedError();
  }
  const userCanvas = await checkCanvasAccess({ userId, canvasId, level });
  if (!userCanvas) {
    throw new NotAuthorizedError();
  }
  return userCanvas;
}

function createCanvasMutationGate({ io }) {
  // KEPT QUIRK (documented in CONTEXT.md): draft-pick permission is
  // edit/admin on ANY canvas containing the draft, and a lock on ANY
  // containing canvas blocks all edits. Benign today because cross-canvas
  // shared drafts are only versus-linked (read-only) — revisit if editable
  // cross-canvas sharing arrives.
  async function assertDraftEditAccess({ userId, canvasDrafts }) {
    if (!userId) {
      throw new NotAuthenticatedError();
    }
    const userCanvases = await UserCanvas.findAll({
      where: {
        canvas_id: canvasDrafts.map((cd) => cd.canvas_id),
        user_id: userId,
      },
    });
    if (!userCanvases.some((uc) => meetsLevel(uc.permissions, "edit"))) {
      throw new NotAuthorizedError();
    }
  }

  async function assertGroupRestrictions({ draftId, picks, canvasDrafts }) {
    const groupId = canvasDrafts.find((cd) => cd.group_id)?.group_id ?? null;
    if (!groupId) return;

    const group = await CanvasGroup.findByPk(groupId, {
      attributes: ["type", "metadata"],
    });
    if (!group) return;

    const metadata = group.metadata || {};
    const disabledChampions = metadata.disabledChampions || [];
    const isSeries = group.type === "series";
    // Series groups carry the mode in seriesType; custom groups in draftMode.
    const effectiveMode = isSeries
      ? metadata.seriesType || metadata.draftMode
      : metadata.draftMode;

    const hasDisabled = disabledChampions.length > 0;
    const hasRestrictions = effectiveMode && effectiveMode !== "standard";
    if (!hasDisabled && !hasRestrictions) return;

    // Only newly placed champions are validated, so pre-existing picks never
    // block a save (e.g. a champion disabled after it was picked).
    const currentDraft = await Draft.findByPk(draftId, {
      attributes: ["picks"],
    });
    const currentPicks = currentDraft?.picks || [];
    const changedIndices = [];
    for (let i = 0; i < 20; i++) {
      const newPick = picks[i] || "";
      const oldPick = currentPicks[i] || "";
      if (newPick !== "" && newPick !== oldPick) {
        changedIndices.push(i);
      }
    }
    if (changedIndices.length === 0) return;

    if (hasDisabled) {
      const disabledSet = new Set(disabledChampions);
      for (const i of changedIndices) {
        if (disabledSet.has(picks[i])) {
          throw new ChampionRestrictedError(
            "Champion is disabled for this group",
          );
        }
      }
    }

    if (hasRestrictions) {
      const siblingDrafts = await CanvasDraft.findAll({
        where: { group_id: groupId },
        include: [
          {
            model: Draft,
            attributes: ["id", "picks", "seriesIndex"],
          },
        ],
      });

      const draftsForRestriction = siblingDrafts
        .filter((cd) => cd.Draft)
        .map((cd) => ({
          id: cd.Draft.id,
          picks: cd.Draft.picks,
          seriesIndex: cd.Draft.seriesIndex,
        }));

      const currentSeriesIndex =
        draftsForRestriction.find((d) => d.id === draftId)?.seriesIndex ?? 0;

      const restricted = getRestrictedChampionsForGroup({
        groupType: group.type,
        seriesType: metadata.seriesType || metadata.draftMode,
        draftMode: metadata.draftMode,
        drafts: draftsForRestriction,
        currentDraftId: draftId,
        currentSeriesIndex,
      });

      if (restricted.length > 0) {
        const restrictedSet = new Set(restricted);
        // Fearless only restricts pick slots (10-19); ironman also bans (0-9).
        const startIndex = effectiveMode === "ironman" ? 0 : 10;
        for (const i of changedIndices) {
          if (i >= startIndex && restrictedSet.has(picks[i])) {
            throw new ChampionRestrictedError(
              "Champion restricted by group draft mode",
            );
          }
        }
      }
    }
  }

  async function applyDraftPicks({ actor, draftId, picks }) {
    if (!draftId || !Array.isArray(picks) || picks.length !== 20) {
      throw new InvalidMutationError(
        "Draft pick payload must have a draftId and 20 pick slots",
      );
    }

    const canvasDrafts = await CanvasDraft.findAll({
      where: { draft_id: draftId },
      attributes: ["canvas_id", "is_locked", "group_id"],
    });

    if (canvasDrafts.length > 0) {
      await assertDraftEditAccess({ userId: actor.userId, canvasDrafts });
      if (canvasDrafts.some((cd) => cd.is_locked)) {
        throw new DraftLockedError();
      }
    } else {
      // Non-canvas draft: only the owner may edit.
      if (!actor.userId) {
        throw new NotAuthenticatedError();
      }
      const draft = await Draft.findByPk(draftId);
      if (!draft || draft.owner_id !== actor.userId) {
        throw new NotAuthorizedError();
      }
    }

    await assertGroupRestrictions({ draftId, picks, canvasDrafts });

    await Draft.update({ picks }, { where: { id: draftId } });

    const payload = { id: draftId, picks };
    io.to(draftId).emit("draftUpdate", payload, draftId);
    for (const cd of canvasDrafts) {
      io.to(cd.canvas_id).emit("draftUpdate", payload, draftId);
    }
  }

  // Ephemeral relays: authorize → broadcast only. These are live drag
  // previews; the final position is persisted later via REST.

  async function relayObjectMove({ actor, canvasId, draftId, positionX, positionY }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId });
    io.to(canvasId).emit(
      "canvasObjectMoved",
      { draftId, positionX, positionY },
      canvasId,
    );
  }

  async function relayAnnotationMove({
    actor,
    canvasId,
    annotationId,
    positionX,
    positionY,
  }) {
    await assertCanvasAccess({
      userId: actor.userId,
      canvasId,
      level: "edit",
    });
    io.to(canvasId).emit(
      "annotationMoved",
      { annotationId, positionX, positionY },
      canvasId,
    );
  }

  /**
   * The live channel for a note's resize handle — and the one relay that
   * deliberately does NOT follow its own kind's move relay.
   *
   * `relayAnnotationMove` above includes the sender because the receiver
   * discards its own echo (`draggedAnnotationId() !== data.annotationId`).
   * There is no resize equivalent of that signal, so an echoed frame — stale
   * by up to the client's 25ms debounce — would be written straight over the
   * live optimistic size and rubber-band the note under the cursor. That is
   * the same fight the Group note below describes, so this takes the Group
   * shape: everyone except the actor.
   *
   * Paint-only. The D7 floor (`manualWidth`/`manualHeight`) is written once by
   * the REST commit, which broadcasts its own `canvasUpdate` snapshot.
   */
  async function relayAnnotationResize({
    actor,
    canvasId,
    annotationId,
    positionX,
    width,
    height,
  }) {
    await assertCanvasAccess({
      userId: actor.userId,
      canvasId,
      level: "edit",
    });
    io.to(canvasId)
      .except(actor.socketId)
      .emit("annotationResized", { annotationId, positionX, width, height });
  }

  async function relayVertexMove({ actor, canvasId, connectionId, vertexId, x, y }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId });
    io.to(canvasId).emit("vertexMoved", { connectionId, vertexId, x, y });
  }

  // Group move/resize exclude the sender: the dragging client already renders
  // the group at the target position and an echo would fight the drag.

  /**
   * The LIVE channel for a container drag, and the only producer of
   * `groupMoved` that means "move the whole subtree".
   *
   * Receivers derive `dx` against their own stored row and fan it out over the
   * descendants they know about (design 3.1c). The commit broadcast must NOT
   * carry this flag: it emits one complete absolute event per written row,
   * descendants included, so a fan-out there would move an explicitly-listed
   * child twice with nothing to correct it.
   */
  async function relayGroupMove({ actor, canvasId, groupId, positionX, positionY }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId });
    io.to(canvasId)
      .except(actor.socketId)
      .emit("groupMoved", { groupId, positionX, positionY, subtree: true });
  }

  async function relayGroupResize({ actor, canvasId, groupId, width, height, positionX }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId });
    io.to(canvasId)
      .except(actor.socketId)
      .emit("groupResized", { groupId, width, height, positionX });
  }

  // Pool champion ops (design D4/§4.3): idempotent set semantics via the
  // shared applyPoolChampionOp, serialized per pool by a row lock — concurrent
  // ops from two editors interleave in either order to the same set. The
  // broadcast carries the FULL payload plus a version, never the op, and
  // EXCLUDES the sender: the actor already applied optimistically, and an
  // echoed full map can land between two rapid adds and revert the second.
  // Receivers drop stale versions — the lock serializes commits, but emits
  // happen post-commit and can interleave. No canvas-timestamp touch,
  // matching applyDraftPicks.
  async function mutatePoolChampions({
    actor, canvasId, placementId, mutate, excludeSender = true,
  }) {
    if (!canvasId || !placementId) {
      throw new InvalidMutationError("Pool op needs canvasId and placementId");
    }
    await assertCanvasAccess({ userId: actor.userId, canvasId, level: "edit" });

    const payload = await sequelize.transaction(async (t) => {
      // Scoped lookup: a placementId living on another canvas is invalid
      // here, not merely found elsewhere.
      const placement = await CanvasPoolPlacement.findOne({
        where: { id: placementId, canvas_id: canvasId },
        transaction: t,
      });
      if (!placement) {
        throw new InvalidMutationError("Pool not found on this canvas");
      }
      const pool = await Pool.findByPk(placement.pool_id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      // Under READ COMMITTED a concurrent DELETE can commit between the two
      // lookups. A bare TypeError here would bypass the adapter's
      // canvasMutationError translation — the client would never hear back.
      if (!pool) {
        throw new InvalidMutationError("Pool not found on this canvas");
      }
      pool.champions = mutate(pool.champions);
      pool.version += 1;
      pool.changed("champions", true);
      await pool.save({ transaction: t });
      return {
        id: pool.id,
        name: pool.name,
        champions: pool.champions,
        version: pool.version,
      };
    });

    const room = io.to(canvasId);
    (excludeSender ? room.except(actor.socketId) : room).emit("poolUpdate", {
      placementId,
      pool: payload,
    });
  }

  function assertChampionOpFields({ role, championId }) {
    if (!RoleSchema.safeParse(role).success) {
      throw new InvalidMutationError("Invalid role");
    }
    if (typeof championId !== "string" || championId.length === 0) {
      throw new InvalidMutationError("Invalid championId");
    }
  }

  async function applyPoolAddChampion({ actor, canvasId, placementId, role, championId }) {
    assertChampionOpFields({ role, championId });
    await mutatePoolChampions({
      actor, canvasId, placementId,
      mutate: (map) => applyPoolChampionOp(map, { type: "add", role, championId }),
    });
  }

  async function applyPoolRemoveChampion({ actor, canvasId, placementId, role, championId }) {
    assertChampionOpFields({ role, championId });
    await mutatePoolChampions({
      actor, canvasId, placementId,
      mutate: (map) => applyPoolChampionOp(map, { type: "remove", role, championId }),
    });
  }

  // Overwrite-intent only (D4): import-from-saved. The overlay's commit is
  // diffs-as-ops and must NEVER route here.
  //
  // Sender INCLUDED (unlike the op broadcasts): a replace is a single
  // low-frequency intentional action — there is no rapid-succession echo
  // fight — and it is not representable in the pending-op queue, so the
  // sender needs its own canonical broadcast back to survive an interleaved
  // foreign payload erasing the optimistic replacement.
  async function applyPoolReplace({ actor, canvasId, placementId, champions }) {
    const parsed = RolePoolMapSchema.safeParse(champions);
    if (!parsed.success) {
      throw new InvalidMutationError("champions must be a RolePoolMap");
    }
    await mutatePoolChampions({
      actor, canvasId, placementId, excludeSender: false,
      mutate: () => parsed.data, // parse RESULT — unknown keys never reach JSONB
    });
  }

  // Ephemeral drag relay, the relayAnnotationMove twin: whole room, sender
  // included — the dragging client discards its own echo via draggedPoolId().
  async function relayPoolMove({ actor, canvasId, placementId, positionX, positionY }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId, level: "edit" });
    io.to(canvasId).emit("poolMoved", { placementId, positionX, positionY }, canvasId);
  }

  return {
    assertCanvasAccess,
    applyDraftPicks,
    relayObjectMove,
    relayAnnotationMove,
    relayAnnotationResize,
    relayVertexMove,
    relayGroupMove,
    relayGroupResize,
    applyPoolAddChampion,
    applyPoolRemoveChampion,
    applyPoolReplace,
    relayPoolMove,
  };
}

module.exports = {
  createCanvasMutationGate,
  checkCanvasAccess,
  assertCanvasAccess,
  CanvasMutationError,
  NotAuthenticatedError,
  NotAuthorizedError,
  DraftLockedError,
  ChampionRestrictedError,
  InvalidMutationError,
};
