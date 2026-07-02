const Draft = require("../models/Draft");
const { UserCanvas, CanvasDraft, CanvasGroup } = require("../models/Canvas");
const {
  getRestrictedChampionsForGroup,
} = require("../utils/draftRestrictions");

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

  async function relayVertexMove({ actor, canvasId, connectionId, vertexId, x, y }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId });
    io.to(canvasId).emit("vertexMoved", { connectionId, vertexId, x, y });
  }

  // Group move/resize exclude the sender: the dragging client already renders
  // the group at the target position and an echo would fight the drag.

  async function relayGroupMove({ actor, canvasId, groupId, positionX, positionY }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId });
    io.to(canvasId)
      .except(actor.socketId)
      .emit("groupMoved", { groupId, positionX, positionY });
  }

  async function relayGroupResize({ actor, canvasId, groupId, width, height, positionX }) {
    await assertCanvasAccess({ userId: actor.userId, canvasId });
    io.to(canvasId)
      .except(actor.socketId)
      .emit("groupResized", { groupId, width, height, positionX });
  }

  return {
    assertCanvasAccess,
    applyDraftPicks,
    relayObjectMove,
    relayVertexMove,
    relayGroupMove,
    relayGroupResize,
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
