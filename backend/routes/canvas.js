const express = require("express");
const router = express.Router();
const {
  Canvas,
  UserCanvas,
  CanvasDraft,
  CanvasConnection,
  CanvasGroup,
} = require("../models/Canvas.js");
const Draft = require("../models/Draft.js");
const User = require("../models/User.js");
const VersusDraft = require("../models/VersusDraft.js");
const { protect, getUserFromRequest } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const { assertCanvasAccess } = require("../services/canvasMutations");
const {
  respondCanvasMutationError,
} = require("../middleware/canvasMutationErrors");
const {
  draftHasSharedWithUser,
  generateUniqueCanvasGroupName,
} = require("../helpers.js");
const { Op } = require("sequelize");
const {
  getManualSeriesGameDefaults,
} = require("../utils/manualSeriesDefaults");

const MIN_SERIES_LENGTH = 1;
const MAX_SERIES_LENGTH = 7;
const VALID_DRAFT_MODES = new Set(["standard", "fearless", "ironman"]);

function isValidSeriesLength(length) {
  return (
    Number.isInteger(length) &&
    length >= MIN_SERIES_LENGTH &&
    length <= MAX_SERIES_LENGTH
  );
}

function normalizeSeriesData(body) {
  const length = Number(body.length);
  return {
    name:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : "Custom Series",
    blueTeamName:
      typeof body.blueTeamName === "string" && body.blueTeamName.trim()
        ? body.blueTeamName.trim()
        : "Team 1",
    redTeamName:
      typeof body.redTeamName === "string" && body.redTeamName.trim()
        ? body.redTeamName.trim()
        : "Team 2",
    length: isValidSeriesLength(length) ? length : 3,
    type: VALID_DRAFT_MODES.has(body.type) ? body.type : "standard",
    disabledChampions: Array.isArray(body.disabledChampions)
      ? body.disabledChampions
      : [],
  };
}

function getSeriesMetadata(versusDraft) {
  return {
    blueTeamName: versusDraft.blueTeamName,
    redTeamName: versusDraft.redTeamName,
    length: versusDraft.length,
    competitive: versusDraft.competitive,
    seriesType: versusDraft.type,
    origin: versusDraft.origin || "live",
    disabledChampions: versusDraft.disabledChampions || [],
    draftMode: versusDraft.type,
  };
}

async function getCanvasBroadcastPayload(canvasId) {
  const groups = await CanvasGroup.findAll({ where: { canvas_id: canvasId } });
  const canvasDrafts = await CanvasDraft.findAll({
    where: { canvas_id: canvasId },
    attributes: [
      "positionX",
      "positionY",
      "is_locked",
      "group_id",
      "source_type",
    ],
    include: [
      {
        model: Draft,
        attributes: [
          "name",
          "id",
          "picks",
          "type",
          "versus_draft_id",
          "seriesIndex",
          "completed",
          "winner",
          "blueSideTeam",
          "firstPick",
        ],
      },
    ],
    raw: true,
    nest: true,
  });
  const connections = await CanvasConnection.findAll({
    where: { canvas_id: canvasId },
    raw: true,
  });
  const canvas = await Canvas.findByPk(canvasId);

  return {
    canvas,
    drafts: canvasDrafts,
    connections,
    groups: groups.map((g) => g.toJSON()),
  };
}

async function syncManualSeriesLength({
  canvasId,
  group,
  versusDraft,
  targetLength,
  transaction,
}) {
  const drafts = await Draft.findAll({
    where: { versus_draft_id: versusDraft.id },
    order: [["seriesIndex", "ASC"]],
    transaction,
  });
  const currentLength = drafts.length;

  if (targetLength > currentLength) {
    const groupDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId, group_id: group.id },
      order: [
        ["positionX", "ASC"],
        ["positionY", "ASC"],
        ["createdAt", "ASC"],
      ],
      transaction,
    });
    const lastDraft = groupDrafts[groupDrafts.length - 1];
    const startX = lastDraft ? lastDraft.positionX + 380 : group.positionX + 24;
    const startY = lastDraft ? lastDraft.positionY : group.positionY + 64;

    for (let i = currentLength; i < targetLength; i += 1) {
      const draft = await Draft.create(
        {
          name: `${versusDraft.name} - Game ${i + 1}`,
          type: "versus",
          versus_draft_id: versusDraft.id,
          seriesIndex: i,
          owner_id: versusDraft.owner_id,
          public: false,
          description: "",
          picks: Array(20).fill(""),
          ...getManualSeriesGameDefaults(i),
        },
        { transaction },
      );
      await CanvasDraft.create(
        {
          canvas_id: canvasId,
          draft_id: draft.id,
          positionX: startX + (i - currentLength) * 380,
          positionY: startY,
          is_locked: false,
          group_id: group.id,
          source_type: "versus",
        },
        { transaction },
      );
    }
  } else if (targetLength < currentLength) {
    const draftsToDelete = drafts.filter((d) => d.seriesIndex >= targetLength);
    const draftIdsToDelete = draftsToDelete.map((d) => d.id);
    for (const draft of draftsToDelete) {
      const hasPicks = draft.picks && draft.picks.some((p) => p && p !== "");
      if (hasPicks) {
        throw new Error(
          `Cannot reduce series length - Game ${draft.seriesIndex + 1} has already started`,
        );
      }
    }
    await CanvasDraft.destroy({
      where: { canvas_id: canvasId, draft_id: draftIdsToDelete },
      transaction,
    });
    await Draft.destroy({
      where: {
        versus_draft_id: versusDraft.id,
        seriesIndex: { [Op.gte]: targetLength },
      },
      transaction,
    });
  }
}

// Helper function to touch canvas updatedAt timestamp
async function touchCanvasTimestamp(canvasId) {
  const now = new Date();

  // Fetch the canvas instance and save it to trigger updatedAt
  const canvas = await Canvas.findByPk(canvasId);
  if (canvas) {
    canvas.changed("updatedAt", true);
    await canvas.save({ silent: false });
  }
}

// Get all canvases for the current user
router.get("/", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.json([]);
    }

    const canvases = await Canvas.findAll({
      include: [
        {
          model: User,
          through: {
            model: UserCanvas,
            where: { user_id: user.id },
          },
          attributes: [],
          required: true,
        },
      ],
      order: [["updatedAt", "DESC"]],
    });

    res.json(
      canvases.map((canvas) => ({
        id: canvas.id,
        name: canvas.name,
        updatedAt: canvas.updatedAt,
      })),
    );
  } catch (error) {
    console.error("Error fetching canvas list:", error);
    res.status(500).json({ error: "Failed to fetch canvas list" });
  }
});

router.get("/:canvasId", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    const canvas = await Canvas.findOne({
      where: { id: req.params.canvasId },
    });

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    const userCanvas = await UserCanvas.findOne({
      where: {
        canvas_id: canvas.id,
        user_id: user.id,
      },
    });

    if (!userCanvas) {
      return res
        .status(403)
        .json({ error: "Not authorized to access this canvas" });
    }

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvas.id },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvas.id },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvas.id },
    });

    // Calculate isInProgress based on drafts in each group
    const groupsWithProgress = groups.map((g) => {
      const groupDrafts = canvasDrafts.filter((cd) => cd.group_id === g.id);
      const isInProgress =
        groupDrafts.length > 0 &&
        !groupDrafts.every((cd) => cd.Draft.completed);
      return {
        ...g.toJSON(),
        isInProgress,
      };
    });

    res.json({
      id: canvas.id,
      name: canvas.name,
      description: canvas.description,
      icon: canvas.icon,
      cardLayout: canvas.cardLayout,
      drafts: canvasDrafts,
      connections: connections,
      groups: groupsWithProgress,
      lastViewport: {
        x: userCanvas.lastViewportX,
        y: userCanvas.lastViewportY,
        zoom: userCanvas.lastZoomLevel,
      },
      userPermissions: userCanvas.permissions,
    });
  } catch (error) {
    console.log("Error loading canvas:", error);
    res.status(500).json({ error: "Failed to load canvas" });
  }
});

router.put("/:canvasId/draft/:draftId", protect, async (req, res) => {
  try {
    const { positionX, positionY, group_id, winner, blueSideTeam, firstPick } =
      req.body;
    const { canvasId, draftId } = req.params;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const canvasDraftUpdates = {};
    if (typeof positionX === "number") canvasDraftUpdates.positionX = positionX;
    if (typeof positionY === "number") canvasDraftUpdates.positionY = positionY;
    if (group_id !== undefined) canvasDraftUpdates.group_id = group_id; // null to ungroup

    const draftUpdates = {};
    if (winner === "blue" || winner === "red" || winner === null) {
      draftUpdates.winner = winner;
      draftUpdates.completed = winner !== null;
      draftUpdates.completedAt = winner === null ? null : new Date();
    }
    if (blueSideTeam === 1 || blueSideTeam === 2) {
      draftUpdates.blueSideTeam = blueSideTeam;
    }
    if (firstPick === "blue" || firstPick === "red") {
      draftUpdates.firstPick = firstPick;
    }

    if (
      Object.keys(canvasDraftUpdates).length === 0 &&
      Object.keys(draftUpdates).length === 0
    ) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const canvasDraft = await CanvasDraft.findOne({
      where: {
        canvas_id: canvasId,
        draft_id: draftId,
      },
    });

    if (canvasDraft) {
      if (Object.keys(canvasDraftUpdates).length > 0) {
        await canvasDraft.update(canvasDraftUpdates);
      }
      if (Object.keys(draftUpdates).length > 0) {
        await Draft.update(draftUpdates, {
          where: { id: draftId },
        });
      }
      await touchCanvasTimestamp(canvasId);

      // If group assignment or draft metadata changed, emit full canvas update
      if (group_id !== undefined || Object.keys(draftUpdates).length > 0) {
        const canvasDrafts = await CanvasDraft.findAll({
          where: { canvas_id: canvasId },
          attributes: [
            "positionX",
            "positionY",
            "is_locked",
            "group_id",
            "source_type",
          ],
          include: [
            {
              model: Draft,
              attributes: [
                "name",
                "id",
                "picks",
                "type",
                "versus_draft_id",
                "seriesIndex",
                "completed",
                "winner",
                "blueSideTeam",
                "firstPick",
              ],
            },
          ],
          raw: true,
          nest: true,
        });
        const connections = await CanvasConnection.findAll({
          where: { canvas_id: canvasId },
          raw: true,
        });
        const groups = await CanvasGroup.findAll({
          where: { canvas_id: canvasId },
        });
        const canvas = await Canvas.findByPk(canvasId);

        socketService.emitToRoom(canvasId, "canvasUpdate", {
          canvas: canvas.toJSON(),
          drafts: canvasDrafts,
          connections: connections,
          groups: groups.map((g) => g.toJSON()),
        });
      }

      res.status(200).json({ success: true, message: "Draft updated" });
    } else {
      res
        .status(404)
        .json({ success: false, message: "Canvas draft not found" });
    }
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to update canvas draft:", error);
    res.status(500).json({ error: "Failed to update canvas draft" });
  }
});

// Batch position commit: grid snap/swap and arrange-as-grid. Updates all
// drafts (and optionally the containing group's metadata/dimensions) in one
// transaction, then broadcasts a surgical draftPositionsUpdated event.
router.put("/:canvasId/draft-positions", protect, async (req, res) => {
  let t;
  try {
    const { canvasId } = req.params;
    const { positions, group } = req.body;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const validPositions =
      Array.isArray(positions) &&
      positions.length > 0 &&
      positions.every(
        (p) =>
          p &&
          typeof p.draft_id === "string" &&
          typeof p.positionX === "number" &&
          typeof p.positionY === "number" &&
          (p.group_id === undefined ||
            p.group_id === null ||
            typeof p.group_id === "string"),
      );
    if (!validPositions) {
      return res.status(400).json({
        error:
          "positions must be a non-empty array of {draft_id, positionX, positionY}",
      });
    }

    t = await Canvas.sequelize.transaction();

    for (const p of positions) {
      const updates = { positionX: p.positionX, positionY: p.positionY };
      if (p.group_id !== undefined) updates.group_id = p.group_id;
      const [updated] = await CanvasDraft.update(updates, {
        where: { canvas_id: canvasId, draft_id: p.draft_id },
        transaction: t,
      });
      if (updated === 0) {
        await t.rollback();
        return res
          .status(404)
          .json({ error: `Draft ${p.draft_id} not found on canvas` });
      }
    }

    let updatedGroup = null;
    if (group && typeof group === "object" && typeof group.id === "string") {
      const groupRow = await CanvasGroup.findOne({
        where: { id: group.id, canvas_id: canvasId },
        transaction: t,
      });
      if (!groupRow) {
        await t.rollback();
        return res.status(404).json({ error: "Group not found" });
      }
      const groupUpdates = {};
      if (typeof group.width === "number") groupUpdates.width = group.width;
      if (typeof group.height === "number") groupUpdates.height = group.height;
      if (group.metadata && typeof group.metadata === "object") {
        groupUpdates.metadata = { ...groupRow.metadata, ...group.metadata };
      }
      if (Object.keys(groupUpdates).length > 0) {
        await groupRow.update(groupUpdates, { transaction: t });
      }
      updatedGroup = groupRow;
    }

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    res.status(200).json({ success: true });

    socketService.emitToRoom(canvasId, "draftPositionsUpdated", {
      positions,
      group: updatedGroup ? updatedGroup.toJSON() : null,
    });
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to update draft positions:", error);
    res.status(500).json({ error: "Failed to update draft positions" });
  }
});

// Copy a draft within a canvas
router.post("/:canvasId/draft/:draftId/copy", protect, async (req, res) => {
  try {
    const { canvasId, draftId } = req.params;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    // Find the existing canvas draft
    const existingCanvasDraft = await CanvasDraft.findOne({
      where: { canvas_id: canvasId, draft_id: draftId },
      include: [{ model: Draft }],
    });

    if (!existingCanvasDraft) {
      return res.status(404).json({ error: "Draft not found on canvas" });
    }

    // Create a new draft with copied data
    const originalDraft = existingCanvasDraft.Draft;
    const newDraft = await Draft.create({
      name: `${originalDraft.name} (Copy)`,
      picks: originalDraft.picks || Array(20).fill(""),
      public: false,
      type: "canvas",
      owner_id: req.user.id,
    });

    const { positionX, positionY, group_id } = req.body ?? {};

    // Create the canvas draft at the requested position (grid placement) or
    // offset from the original (default).
    const COPY_OFFSET = 50;
    const newCanvasDraft = await CanvasDraft.create({
      canvas_id: canvasId,
      draft_id: newDraft.id,
      positionX:
        typeof positionX === "number"
          ? positionX
          : existingCanvasDraft.positionX + COPY_OFFSET,
      positionY:
        typeof positionY === "number"
          ? positionY
          : existingCanvasDraft.positionY + COPY_OFFSET,
      is_locked: false,
      group_id:
        typeof group_id === "string"
          ? group_id
          : group_id === null
            ? null
            : existingCanvasDraft.group_id,
      source_type: "canvas",
    });

    await touchCanvasTimestamp(canvasId);

    // Fetch full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(201).json({
      success: true,
      canvasDraft: {
        ...newCanvasDraft.toJSON(),
        Draft: newDraft.toJSON(),
      },
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to copy draft:", error);
    res.status(500).json({ error: "Failed to copy draft" });
  }
});

router.delete("/:canvasId/draft/:draftId", protect, async (req, res) => {
  try {
    const { canvasId, draftId } = req.params;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    // Find all CanvasDraft records with this draft_id
    const canvasDraftsToCheck = await CanvasDraft.findAll({
      where: { canvas_id: canvasId, draft_id: draftId },
    });

    if (canvasDraftsToCheck.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Canvas draft not found" });
    }

    // Find which ones are in series groups vs deletable (ungrouped or custom group)
    const groupIds = canvasDraftsToCheck
      .filter((cd) => cd.group_id)
      .map((cd) => cd.group_id);

    const seriesGroups =
      groupIds.length > 0
        ? await CanvasGroup.findAll({
            where: { id: groupIds, type: "series" },
          })
        : [];

    const seriesGroupIds = new Set(seriesGroups.map((g) => g.id));

    // Find a deletable draft (not in a series group)
    const deletableDraft = canvasDraftsToCheck.find(
      (cd) => !cd.group_id || !seriesGroupIds.has(cd.group_id),
    );

    if (!deletableDraft) {
      return res.status(403).json({
        error:
          "Cannot delete draft that is part of a series group. Remove the entire series instead.",
      });
    }

    // Update connections involving this specific canvas draft
    const allConnections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
    });

    for (const conn of allConnections) {
      // Filter out the deleted draft from source and target arrays
      const filteredSources = (conn.source_draft_ids || []).filter(
        (src) => src.draft_id !== draftId,
      );
      const filteredTargets = (conn.target_draft_ids || []).filter(
        (tgt) => tgt.draft_id !== draftId,
      );

      // If either array is empty, delete the connection
      if (filteredSources.length === 0 || filteredTargets.length === 0) {
        await conn.destroy();
      } else {
        // Otherwise, update with filtered arrays
        conn.source_draft_ids = filteredSources;
        conn.target_draft_ids = filteredTargets;
        await conn.save();
      }
    }

    // Only delete the specific deletable draft, not all with the same draft_id
    await deletableDraft.destroy();

    await touchCanvasTimestamp(canvasId);

    const canvas = await Canvas.findByPk(canvasId);
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });
    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });
    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });
    res
      .status(200)
      .json({ success: true, message: "Draft removed from canvas" });
    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to remove draft from canvas:", error);
    res.status(500).json({ error: "Failed to remove draft from canvas" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { draftId, name, description, icon, cardLayout } = req.body;
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Create empty canvas (no draft)
    if (!draftId) {
      const canvas = await Canvas.create({
        name: name || "New Canvas",
        description: description,
        icon: icon || "",
        cardLayout: cardLayout || "wide",
      });

      await UserCanvas.create({
        canvas_id: canvas.id,
        user_id: user.id,
        permissions: "admin",
      });

      return res.json({
        success: true,
        canvas: {
          id: canvas.id,
          name: canvas.name,
          description: canvas.description,
          cardLayout: canvas.cardLayout,
          drafts: [],
        },
      });
    }

    // Create canvas from draft (existing behavior)
    const draft = await Draft.findByPk(draftId);
    const isSharedWith = await draftHasSharedWithUser(draft, user);
    if (!draft.public && draft.owner_id !== user.id && !isSharedWith) {
      return res
        .status(403)
        .json({ error: "Not authorized to use this draft" });
    }

    const canvas = await Canvas.create({
      name: name || draft.name + " Canvas",
      description: description,
      icon: icon || "",
      cardLayout: cardLayout || "wide",
    });
    const canvasDraft = await CanvasDraft.create({
      canvas_id: canvas.id,
      draft_id: draft.id,
    });
    const userCanvas = await UserCanvas.create({
      canvas_id: canvas.id,
      user_id: user.id,
      permissions: "admin",
    });

    res.json({
      success: true,
      canvas: {
        id: canvas.id,
        name: canvas.name,
        description: canvas.description,
        cardLayout: canvas.cardLayout,
        drafts: [draft.toJSON()],
      },
    });
  } catch (error) {
    console.error("Failed to save canvas:", error);
    res.status(500).json({ error: "Failed to save canvas" });
  }
});

// Import existing draft to canvas
router.post("/:canvasId/import/draft", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { draftId, positionX, positionY } = req.body;

    if (!draftId) {
      return res.status(400).json({ error: "draftId is required" });
    }

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const draft = await Draft.findByPk(draftId);
    if (!draft) {
      return res.status(404).json({ error: "Draft not found" });
    }

    // Check user has access to the draft
    if (draft.owner_id !== req.user.id && !draft.public) {
      const isSharedWith = await draftHasSharedWithUser(draft, req.user);
      if (!isSharedWith) {
        return res
          .status(403)
          .json({ error: "Not authorized to use this draft" });
      }
    }

    // Determine if draft is from versus series (locked) or canvas (editable)
    const isLocked = draft.type === "versus" || !!draft.versus_draft_id;
    const sourceType = draft.versus_draft_id ? "versus" : "canvas";

    const canvasDraft = await CanvasDraft.create({
      canvas_id: canvasId,
      draft_id: draftId,
      positionX: positionX ?? 50,
      positionY: positionY ?? 50,
      is_locked: isLocked,
      source_type: sourceType,
    });

    await touchCanvasTimestamp(canvasId);

    // Fetch the full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(201).json({
      success: true,
      canvasDraft: {
        ...canvasDraft.toJSON(),
        Draft: draft.toJSON(),
      },
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to import draft:", error);
    res.status(500).json({ error: "Failed to import draft" });
  }
});

// Import versus series as a group
router.post("/:canvasId/import/series", protect, async (req, res) => {
  let t;
  try {
    const { canvasId } = req.params;
    const { versusDraftId, positionX, positionY } = req.body;

    if (!versusDraftId) {
      return res.status(400).json({ error: "versusDraftId is required" });
    }

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });
    t = await Canvas.sequelize.transaction();

    const versusDraft = await VersusDraft.findByPk(versusDraftId, {
      include: [{ model: Draft, as: "Drafts" }],
    });

    if (!versusDraft) {
      await t.rollback();
      return res.status(404).json({ error: "Versus series not found" });
    }

    // Create the group container
    const group = await CanvasGroup.create(
      {
        canvas_id: canvasId,
        name: versusDraft.name,
        type: "series",
        positionX: positionX ?? 50,
        positionY: positionY ?? 50,
        versus_draft_id: versusDraftId,
        metadata: {
          blueTeamName: versusDraft.blueTeamName,
          redTeamName: versusDraft.redTeamName,
          length: versusDraft.length,
          competitive: versusDraft.competitive,
          seriesType: versusDraft.type,
          origin: versusDraft.origin || "live",
          disabledChampions: versusDraft.disabledChampions || [],
          draftMode: versusDraft.type,
        },
      },
      { transaction: t },
    );

    // Create CanvasDraft for each game in the series
    const drafts = versusDraft.Drafts || [];
    const sortedDrafts = [...drafts].sort(
      (a, b) => a.seriesIndex - b.seriesIndex,
    );

    const createdCanvasDrafts = [];
    for (let i = 0; i < sortedDrafts.length; i++) {
      const draft = sortedDrafts[i];
      const canvasDraft = await CanvasDraft.create(
        {
          canvas_id: canvasId,
          draft_id: draft.id,
          positionX: (positionX ?? 50) + i * 380, // Horizontal layout with spacing
          positionY: positionY ?? 50,
          is_locked: true,
          group_id: group.id,
          source_type: "versus",
        },
        { transaction: t },
      );
      createdCanvasDrafts.push({
        ...canvasDraft.toJSON(),
        Draft: draft.toJSON(),
      });
    }

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch all groups for response
    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    // Fetch full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(201).json({
      success: true,
      group: {
        ...group.toJSON(),
        CanvasDrafts: createdCanvasDrafts,
      },
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to import series:", error);
    res.status(500).json({ error: "Failed to import series" });
  }
});

router.post(
  "/:canvasId/group/:groupId/convert-to-series",
  protect,
  async (req, res) => {
    let t;
    try {
      const { canvasId, groupId } = req.params;
      const data = normalizeSeriesData(req.body);

      await assertCanvasAccess({
        userId: req.user.id,
        canvasId,
        level: "edit",
      });
      t = await Canvas.sequelize.transaction();

      const group = await CanvasGroup.findOne({
        where: { id: groupId, canvas_id: canvasId },
        transaction: t,
      });

      if (!group) {
        await t.rollback();
        return res.status(404).json({ error: "Group not found" });
      }

      if (group.type !== "custom") {
        await t.rollback();
        return res
          .status(400)
          .json({ error: "Only custom groups can be converted" });
      }

      const versusDraft = await VersusDraft.create(
        {
          ...data,
          origin: "manual",
          owner_id: req.user.id,
        },
        { transaction: t },
      );

      const groupCanvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId, group_id: groupId },
        include: [{ model: Draft }],
        order: [
          ["positionX", "ASC"],
          ["positionY", "ASC"],
          ["createdAt", "ASC"],
        ],
        transaction: t,
      });

      const convertedCanvasDrafts = [];
      const existingToConvert = groupCanvasDrafts.slice(0, data.length);
      const extrasToLeave = groupCanvasDrafts.slice(data.length);
      for (let i = 0; i < existingToConvert.length; i += 1) {
        const canvasDraft = existingToConvert[i];
        await canvasDraft.Draft.update(
          {
            type: "versus",
            versus_draft_id: versusDraft.id,
            seriesIndex: i,
            owner_id: canvasDraft.Draft.owner_id || req.user.id,
            ...getManualSeriesGameDefaults(i),
          },
          { transaction: t },
        );
        await canvasDraft.update(
          { source_type: "versus", is_locked: false },
          { transaction: t },
        );
        convertedCanvasDrafts.push(canvasDraft);
      }
      for (const canvasDraft of extrasToLeave) {
        await canvasDraft.Draft.update(
          { versus_draft_id: null, seriesIndex: null },
          { transaction: t },
        );
        await canvasDraft.update(
          { source_type: "canvas", is_locked: false },
          { transaction: t },
        );
      }

      const lastCanvasDraft = existingToConvert[existingToConvert.length - 1];
      const startX = lastCanvasDraft
        ? lastCanvasDraft.positionX + 380
        : group.positionX + 24;
      const startY = lastCanvasDraft
        ? lastCanvasDraft.positionY
        : group.positionY + 64;

      for (let i = existingToConvert.length; i < data.length; i += 1) {
        const draft = await Draft.create(
          {
            name: `${data.name} - Game ${i + 1}`,
            type: "versus",
            versus_draft_id: versusDraft.id,
            seriesIndex: i,
            owner_id: req.user.id,
            public: false,
            description: "",
            picks: Array(20).fill(""),
            ...getManualSeriesGameDefaults(i),
          },
          { transaction: t },
        );
        const canvasDraft = await CanvasDraft.create(
          {
            canvas_id: canvasId,
            draft_id: draft.id,
            positionX: startX + (i - existingToConvert.length) * 380,
            positionY: startY,
            is_locked: false,
            group_id: groupId,
            source_type: "versus",
          },
          { transaction: t },
        );
        canvasDraft.Draft = draft;
        convertedCanvasDrafts.push(canvasDraft);
      }

      await group.update(
        {
          name: data.name,
          type: "series",
          versus_draft_id: versusDraft.id,
          metadata: getSeriesMetadata(versusDraft),
        },
        { transaction: t },
      );

      await t.commit();
      await touchCanvasTimestamp(canvasId);

      const payload = await getCanvasBroadcastPayload(canvasId);

      res.status(201).json({
        success: true,
        group: {
          ...group.toJSON(),
          CanvasDrafts: convertedCanvasDrafts.map((cd) => ({
            ...cd.toJSON(),
            Draft: cd.Draft.toJSON(),
          })),
        },
      });

      socketService.emitToRoom(canvasId, "canvasUpdate", {
        canvas: payload.canvas.toJSON(),
        drafts: payload.drafts,
        connections: payload.connections,
        groups: payload.groups,
      });
    } catch (error) {
      if (t && !t.finished) await t.rollback();
      if (
        respondCanvasMutationError(res, error, {
          NOT_AUTHORIZED:
            "Forbidden: You don't have permission to edit this canvas",
        })
      )
        return;
      console.error("Failed to convert group to series:", error);
      res
        .status(500)
        .json({ error: error.message || "Failed to convert group" });
    }
  },
);

// Create a custom group
router.post("/:canvasId/group", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { name, positionX, positionY } = req.body;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const groupName =
      name && typeof name === "string" && name.trim().length > 0
        ? name.trim()
        : await generateUniqueCanvasGroupName("New Group", canvasId);

    const group = await CanvasGroup.create({
      canvas_id: canvasId,
      name: groupName,
      type: "custom",
      positionX: positionX ?? 50,
      positionY: positionY ?? 50,
      width: 400,
      height: 200,
    });

    await touchCanvasTimestamp(canvasId);

    // Fetch all groups for socket broadcast
    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(201).json({
      success: true,
      group: group.toJSON(),
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to create group:", error);
    res.status(500).json({ error: "Failed to create group" });
  }
});

// Delete a group from canvas
router.delete("/:canvasId/group/:groupId", protect, async (req, res) => {
  let t;
  try {
    const { canvasId, groupId } = req.params;
    const keepDrafts = req.query.keepDrafts === "true";

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });
    t = await Canvas.sequelize.transaction();

    const group = await CanvasGroup.findOne({
      where: { id: groupId, canvas_id: canvasId },
      transaction: t,
    });

    if (!group) {
      await t.rollback();
      return res.status(404).json({ error: "Group not found" });
    }

    // Get draft IDs in the group
    const groupDrafts = await CanvasDraft.findAll({
      where: { group_id: groupId, canvas_id: canvasId },
      transaction: t,
    });
    const draftIdsToRemove = new Set(groupDrafts.map((d) => d.draft_id));

    if (keepDrafts) {
      // Convert positions to absolute and ungroup
      for (const draft of groupDrafts) {
        await draft.update(
          {
            positionX: group.positionX + draft.positionX,
            positionY: group.positionY + draft.positionY,
            group_id: null,
          },
          { transaction: t },
        );
      }
    } else {
      // Clean up connections involving these drafts
      const allConnections = await CanvasConnection.findAll({
        where: { canvas_id: canvasId },
        transaction: t,
      });

      for (const conn of allConnections) {
        const filteredSources = (conn.source_draft_ids || []).filter(
          (src) => !draftIdsToRemove.has(src.draft_id),
        );
        const filteredTargets = (conn.target_draft_ids || []).filter(
          (tgt) => !draftIdsToRemove.has(tgt.draft_id),
        );

        if (filteredSources.length === 0 || filteredTargets.length === 0) {
          await conn.destroy({ transaction: t });
        } else if (
          filteredSources.length !== conn.source_draft_ids.length ||
          filteredTargets.length !== conn.target_draft_ids.length
        ) {
          conn.source_draft_ids = filteredSources;
          conn.target_draft_ids = filteredTargets;
          await conn.save({ transaction: t });
        }
      }

      // Delete all CanvasDrafts in the group
      await CanvasDraft.destroy({
        where: { group_id: groupId, canvas_id: canvasId },
        transaction: t,
      });
    }

    // Clean up any connection endpoints that reference this group
    const allConnsForGroup = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      transaction: t,
    });

    for (const conn of allConnsForGroup) {
      const filteredSources = (conn.source_draft_ids || []).filter(
        (src) => !(src.type === "group" && src.group_id === groupId),
      );
      const filteredTargets = (conn.target_draft_ids || []).filter(
        (tgt) => !(tgt.type === "group" && tgt.group_id === groupId),
      );

      if (filteredSources.length === 0 || filteredTargets.length === 0) {
        await conn.destroy({ transaction: t });
      } else if (
        filteredSources.length !== conn.source_draft_ids.length ||
        filteredTargets.length !== conn.target_draft_ids.length
      ) {
        conn.source_draft_ids = filteredSources;
        conn.target_draft_ids = filteredTargets;
        conn.changed("source_draft_ids", true);
        conn.changed("target_draft_ids", true);
        await conn.save({ transaction: t });
      }
    }

    // Delete the group
    await group.destroy({ transaction: t });

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch updated canvas data
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvas = await Canvas.findByPk(canvasId);

    res.status(200).json({ success: true, message: "Group deleted" });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to delete group:", error);
    res.status(500).json({ error: "Failed to delete group" });
  }
});

// Update group (name, position, size)
router.put("/:canvasId/group/:groupId", protect, async (req, res) => {
  let t;
  try {
    const { canvasId, groupId } = req.params;
    const { name, positionX, positionY, width, height, metadata } = req.body;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });
    t = await Canvas.sequelize.transaction();

    const group = await CanvasGroup.findOne({
      where: { id: groupId, canvas_id: canvasId },
      transaction: t,
    });

    if (!group) {
      await t.rollback();
      return res.status(404).json({ error: "Group not found" });
    }

    // Build update object with only provided fields
    const updates = {};
    if (
      name !== undefined &&
      typeof name === "string" &&
      name.trim().length > 0
    ) {
      updates.name = name.trim();
    }
    if (typeof positionX === "number") updates.positionX = positionX;
    if (typeof positionY === "number") updates.positionY = positionY;
    if (typeof width === "number" || width === null) updates.width = width;
    if (typeof height === "number" || height === null) updates.height = height;
    if (metadata && typeof metadata === "object") {
      updates.metadata = { ...group.metadata, ...metadata };
    }

    if (Object.keys(updates).length === 0) {
      await t.rollback();
      return res.status(400).json({ error: "No valid fields to update" });
    }

    let versusDraft = null;
    if (
      group.versus_draft_id &&
      ((metadata && typeof metadata === "object") || updates.name)
    ) {
      versusDraft = await VersusDraft.findByPk(group.versus_draft_id, {
        transaction: t,
      });

      if (versusDraft && versusDraft.origin === "manual") {
        const seriesMetadata =
          metadata && typeof metadata === "object" ? metadata : {};
        const seriesUpdates = {};
        if (updates.name) seriesUpdates.name = updates.name;
        if (seriesMetadata.blueTeamName !== undefined) {
          seriesUpdates.blueTeamName = seriesMetadata.blueTeamName;
        }
        if (seriesMetadata.redTeamName !== undefined) {
          seriesUpdates.redTeamName = seriesMetadata.redTeamName;
        }
        const nextType = seriesMetadata.seriesType || seriesMetadata.draftMode;
        if (nextType !== undefined && VALID_DRAFT_MODES.has(nextType)) {
          seriesUpdates.type = nextType;
        }
        if (Array.isArray(seriesMetadata.disabledChampions)) {
          seriesUpdates.disabledChampions = seriesMetadata.disabledChampions;
        }

        const nextLength = Number(seriesMetadata.length);
        if (
          isValidSeriesLength(nextLength) &&
          nextLength !== versusDraft.length
        ) {
          await syncManualSeriesLength({
            canvasId,
            group,
            versusDraft,
            targetLength: nextLength,
            transaction: t,
          });
          seriesUpdates.length = nextLength;
        }

        if (Object.keys(seriesUpdates).length > 0) {
          await versusDraft.update(seriesUpdates, { transaction: t });
          updates.metadata = {
            ...updates.metadata,
            ...getSeriesMetadata({ ...versusDraft.toJSON(), ...seriesUpdates }),
          };
        }
      }
    }

    await group.update(updates, { transaction: t });
    await t.commit();
    await touchCanvasTimestamp(canvasId);

    res.status(200).json({ success: true, group: group.toJSON() });

    // Emit appropriate socket event
    if (updates.positionX !== undefined || updates.positionY !== undefined) {
      socketService.emitToRoom(canvasId, "groupMoved", {
        groupId,
        positionX: group.positionX,
        positionY: group.positionY,
        width: group.width,
        height: group.height,
      });
    } else {
      // For name/size changes, emit full canvas update
      const payload = await getCanvasBroadcastPayload(canvasId);

      socketService.emitToRoom(canvasId, "canvasUpdate", {
        canvas: payload.canvas.toJSON(),
        drafts: payload.drafts,
        connections: payload.connections,
        groups: payload.groups,
      });
    }
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to update group:", error);
    res.status(500).json({ error: "Failed to update group" });
  }
});

router.delete("/:canvasId", protect, async (req, res) => {
  let t;
  try {
    const { canvasId } = req.params;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "admin" });
    t = await Canvas.sequelize.transaction();

    await CanvasConnection.destroy({
      where: { canvas_id: canvasId },
      transaction: t,
    });
    await CanvasDraft.destroy({
      where: { canvas_id: canvasId },
      transaction: t,
    });
    await UserCanvas.destroy({
      where: { canvas_id: canvasId },
      transaction: t,
    });

    const affectedRows = await Canvas.destroy({
      where: { id: canvasId },
      transaction: t,
    });

    if (affectedRows > 0) {
      await t.commit();
      res.status(200).json({ success: true, message: "Canvas deleted" });
    } else {
      await t.rollback();
      res.status(404).json({ success: false, message: "Canvas not found" });
    }
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You must be an admin to delete this canvas",
      })
    )
      return;
    console.error("Failed to delete canvas:", error);
    res.status(500).json({ error: "Failed to delete canvas" });
  }
});

router.patch("/:canvasId/viewport", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: "Not authorized, no user found" });
    }

    const { canvasId } = req.params;
    const { x, y, zoom } = req.body;

    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof zoom !== "number"
    ) {
      return res.status(400).json({ error: "Invalid viewport data" });
    }

    const userCanvas = await UserCanvas.findOne({
      where: {
        canvas_id: canvasId,
        user_id: user.id,
      },
    });

    if (!userCanvas) {
      return res
        .status(403)
        .json({ error: "Forbidden: You don't have access to this canvas" });
    }

    userCanvas.lastViewportX = x;
    userCanvas.lastViewportY = y;
    userCanvas.lastZoomLevel = zoom;
    userCanvas.lastAccessedAt = new Date();
    await userCanvas.save();

    res.status(200).json({
      success: true,
      message: "Viewport updated",
      viewport: { x, y, zoom },
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to update viewport" });
  }
});

router.patch("/:canvasId/name", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { name, description, icon } = req.body;

    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Invalid canvas name" });
    }

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const canvas = await Canvas.findByPk(canvasId);

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    canvas.name = name;
    if (description !== undefined) {
      canvas.description = description;
    }
    if (icon !== undefined) {
      canvas.icon = icon;
    }
    await canvas.save();

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvas.id },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvas.id },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvas.id },
    });

    const canvasJSON = canvas.toJSON();

    res.status(200).json({
      success: true,
      message: "Canvas name updated",
      canvas: canvasJSON,
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to update canvas name:", error);
    res.status(500).json({ error: "Failed to update canvas name" });
  }
});

router.patch("/:canvasId/card-layout", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { cardLayout } = req.body;

    if (
      ![
        "vertical",
        "horizontal",
        "wide",
        "wide-draft-order",
        "compact",
        "draft-order",
      ].includes(cardLayout)
    ) {
      return res.status(400).json({ error: "Invalid card layout" });
    }

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const canvas = await Canvas.findByPk(canvasId);

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    canvas.cardLayout = cardLayout;
    await canvas.save();

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvas.id },
      attributes: [
        "positionX",
        "positionY",
        "is_locked",
        "group_id",
        "source_type",
      ],
      include: [
        {
          model: Draft,
          attributes: [
            "name",
            "id",
            "picks",
            "type",
            "versus_draft_id",
            "seriesIndex",
            "completed",
            "winner",
            "blueSideTeam",
            "firstPick",
          ],
        },
      ],
      raw: true,
      nest: true,
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvas.id },
      raw: true,
    });

    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvas.id },
    });

    res.status(200).json({
      success: true,
      message: "Canvas card layout updated",
      canvas: canvas.toJSON(),
    });

    socketService.emitToRoom(canvasId, "canvasUpdate", {
      canvas: canvas.toJSON(),
      drafts: canvasDrafts,
      connections: connections,
      groups: groups.map((g) => g.toJSON()),
    });
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to update canvas card layout:", error);
    res.status(500).json({ error: "Failed to update canvas card layout" });
  }
});

router.get("/:canvasId/users", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;

    const requesterUserCanvas = await UserCanvas.findOne({
      where: { canvas_id: canvasId, user_id: req.user.id },
    });

    if (!requesterUserCanvas) {
      return res
        .status(403)
        .json({ error: "Forbidden: You don't have access to this canvas" });
    }

    const canvas = await Canvas.findByPk(canvasId, {
      include: [
        {
          model: User,
          attributes: ["id", "name", "email", "picture", "display_name"],
          through: {
            attributes: ["permissions", "lastAccessedAt", "createdAt"],
          },
        },
      ],
    });

    if (!canvas) {
      return res.status(404).json({ error: "Canvas not found" });
    }

    // Find the owner (user with earliest createdAt in UserCanvas)
    let ownerId = null;
    let earliestDate = null;
    for (const user of canvas.Users) {
      const createdAt = new Date(user.UserCanvas.createdAt);
      if (!earliestDate || createdAt < earliestDate) {
        earliestDate = createdAt;
        ownerId = user.id;
      }
    }

    const users = canvas.Users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      picture: user.picture,
      display_name: user.display_name,
      permissions: user.UserCanvas.permissions,
      lastAccessedAt: user.UserCanvas.lastAccessedAt,
      isOwner: user.id === ownerId,
    }));

    res.json({ users });
  } catch (error) {
    console.error("Failed to fetch canvas users:", error);
    res.status(500).json({ error: "Failed to fetch canvas users" });
  }
});

router.put("/:canvasId/users/:userId", protect, async (req, res) => {
  try {
    const { canvasId, userId } = req.params;
    const { permissions } = req.body;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "admin" });

    const [affectedRows] = await UserCanvas.update(
      { permissions },
      {
        where: {
          canvas_id: canvasId,
          user_id: userId,
        },
      },
    );

    if (affectedRows > 0) {
      res
        .status(200)
        .json({ success: true, message: "User permissions updated" });
    } else {
      res
        .status(404)
        .json({ success: false, message: "User not found on this canvas" });
    }
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED: "Forbidden: You must be an admin to manage users",
      })
    )
      return;
    res.status(500).json({ error: "Failed to update user permissions" });
  }
});

router.delete("/:canvasId/users/:userId", protect, async (req, res) => {
  try {
    const { canvasId, userId } = req.params;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "admin" });

    const affectedRows = await UserCanvas.destroy({
      where: {
        canvas_id: canvasId,
        user_id: userId,
      },
    });

    if (affectedRows > 0) {
      res
        .status(200)
        .json({ success: true, message: "User removed from canvas" });
    } else {
      res
        .status(404)
        .json({ success: false, message: "User not found on this canvas" });
    }
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED: "Forbidden: You must be an admin to remove users",
      })
    )
      return;
    console.error("Failed to remove user:", error);
    res.status(500).json({ error: "Failed to remove user" });
  }
});

router.post("/:canvasId/connections", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { sourceDraftIds, targetDraftIds, style, vertices } = req.body;

    // Validation
    if (!Array.isArray(sourceDraftIds) || sourceDraftIds.length === 0) {
      return res.status(400).json({
        error: "At least one source is required",
      });
    }

    if (!Array.isArray(targetDraftIds) || targetDraftIds.length === 0) {
      return res.status(400).json({
        error: "At least one target is required",
      });
    }

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    // Validate all endpoint IDs exist on this canvas
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: ["draft_id"],
    });
    const validDraftIds = new Set(canvasDrafts.map((cd) => cd.draft_id));

    const canvasGroups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
      attributes: ["id"],
    });
    const validGroupIds = new Set(canvasGroups.map((g) => g.id));

    for (const src of sourceDraftIds) {
      if (src.groupId) {
        if (!validGroupIds.has(src.groupId)) {
          return res.status(400).json({
            error: `Source group ${src.groupId} not found on canvas`,
          });
        }
      } else if (!validDraftIds.has(src.draftId)) {
        return res.status(400).json({
          error: `Source draft ${src.draftId} not found on canvas`,
        });
      }
    }

    for (const tgt of targetDraftIds) {
      if (tgt.groupId) {
        if (!validGroupIds.has(tgt.groupId)) {
          return res.status(400).json({
            error: `Target group ${tgt.groupId} not found on canvas`,
          });
        }
      } else if (!validDraftIds.has(tgt.draftId)) {
        return res.status(400).json({
          error: `Target draft ${tgt.draftId} not found on canvas`,
        });
      }
    }

    // Transform to backend format
    const formatEndpoint = (ep) => {
      if (ep.groupId) {
        return {
          type: "group",
          group_id: ep.groupId,
          anchor_type: ep.anchorType || "top",
        };
      }
      return {
        type: "draft",
        draft_id: ep.draftId,
        anchor_type: ep.anchorType || "top",
      };
    };

    const sourceDraftIdsFormatted = sourceDraftIds.map(formatEndpoint);
    const targetDraftIdsFormatted = targetDraftIds.map(formatEndpoint);

    const connection = await CanvasConnection.create({
      canvas_id: canvasId,
      source_draft_ids: sourceDraftIdsFormatted,
      target_draft_ids: targetDraftIdsFormatted,
      vertices: vertices || [],
      style: style || "solid",
    });

    await touchCanvasTimestamp(canvasId);

    res.status(201).json({
      success: true,
      connection: connection.toJSON(),
    });

    const connections = await CanvasConnection.findAll({
      where: { canvas_id: canvasId },
      raw: true,
    });

    socketService.emitToRoom(canvasId, "connectionCreated", {
      connection: connection.toJSON(),
      allConnections: connections,
    });
  } catch (error) {
    if (
      respondCanvasMutationError(res, error, {
        NOT_AUTHORIZED:
          "Forbidden: You don't have permission to edit this canvas",
      })
    )
      return;
    console.error("Failed to create connection:", error);
    res.status(500).json({ error: "Failed to create connection" });
  }
});

router.patch(
  "/:canvasId/connections/:connectionId",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId } = req.params;
      const { addSource, addTarget } = req.body;

      await assertCanvasAccess({
        userId: req.user.id,
        canvasId,
        level: "edit",
      });

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      // Validate endpoints exist on canvas
      const canvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId },
        attributes: ["draft_id"],
      });
      const validDraftIds = new Set(canvasDrafts.map((cd) => cd.draft_id));

      const canvasGroups = await CanvasGroup.findAll({
        where: { canvas_id: canvasId },
        attributes: ["id"],
      });
      const validGroupIds = new Set(canvasGroups.map((g) => g.id));

      const formatEndpoint = (ep) => {
        if (ep.groupId) {
          return {
            type: "group",
            group_id: ep.groupId,
            anchor_type: ep.anchorType || "top",
          };
        }
        return {
          type: "draft",
          draft_id: ep.draftId,
          anchor_type: ep.anchorType || "top",
        };
      };

      if (addSource) {
        if (addSource.groupId) {
          if (!validGroupIds.has(addSource.groupId)) {
            return res.status(400).json({
              error: `Group ${addSource.groupId} not found on canvas`,
            });
          }
        } else if (!validDraftIds.has(addSource.draftId)) {
          return res.status(400).json({
            error: `Draft ${addSource.draftId} not found on canvas`,
          });
        }

        const newSource = formatEndpoint(addSource);

        // Check if already exists
        const exists = connection.source_draft_ids.some((src) =>
          newSource.type === "group"
            ? src.type === "group" && src.group_id === newSource.group_id
            : src.draft_id === newSource.draft_id,
        );

        if (!exists) {
          connection.source_draft_ids = [
            ...connection.source_draft_ids,
            newSource,
          ];
          connection.changed("source_draft_ids", true);
        }
      }

      if (addTarget) {
        if (addTarget.groupId) {
          if (!validGroupIds.has(addTarget.groupId)) {
            return res.status(400).json({
              error: `Group ${addTarget.groupId} not found on canvas`,
            });
          }
        } else if (!validDraftIds.has(addTarget.draftId)) {
          return res.status(400).json({
            error: `Draft ${addTarget.draftId} not found on canvas`,
          });
        }

        const newTarget = formatEndpoint(addTarget);

        // Check if already exists
        const exists = connection.target_draft_ids.some((tgt) =>
          newTarget.type === "group"
            ? tgt.type === "group" && tgt.group_id === newTarget.group_id
            : tgt.draft_id === newTarget.draft_id,
        );

        if (!exists) {
          connection.target_draft_ids = [
            ...connection.target_draft_ids,
            newTarget,
          ];
          connection.changed("target_draft_ids", true);
        }
      }

      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(200).json({
        success: true,
        connection: connection.toJSON(),
      });

      const connections = await CanvasConnection.findAll({
        where: { canvas_id: canvasId },
        raw: true,
      });

      socketService.emitToRoom(canvasId, "connectionUpdated", {
        connection: connection.toJSON(),
        allConnections: connections,
      });
    } catch (error) {
      if (
        respondCanvasMutationError(res, error, {
          NOT_AUTHORIZED:
            "Forbidden: You don't have permission to edit this canvas",
        })
      )
        return;
      console.error("Failed to update connection:", error);
      res.status(500).json({ error: "Failed to update connection" });
    }
  },
);

router.delete(
  "/:canvasId/connections/:connectionId",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId } = req.params;

      await assertCanvasAccess({
        userId: req.user.id,
        canvasId,
        level: "edit",
      });

      const affectedRows = await CanvasConnection.destroy({
        where: {
          id: connectionId,
          canvas_id: canvasId,
        },
      });

      if (affectedRows > 0) {
        await touchCanvasTimestamp(canvasId);

        res.status(200).json({
          success: true,
          message: "Connection deleted",
        });

        const connections = await CanvasConnection.findAll({
          where: { canvas_id: canvasId },
          raw: true,
        });

        socketService.emitToRoom(canvasId, "connectionDeleted", {
          connectionId,
          allConnections: connections,
        });
      } else {
        res.status(404).json({
          success: false,
          message: "Connection not found",
        });
      }
    } catch (error) {
      if (
        respondCanvasMutationError(res, error, {
          NOT_AUTHORIZED:
            "Forbidden: You don't have permission to edit this canvas",
        })
      )
        return;
      console.error("Failed to delete connection:", error);
      res.status(500).json({ error: "Failed to delete connection" });
    }
  },
);

// Vertex Management Endpoints

// Create a new vertex on a connection
router.post(
  "/:canvasId/connections/:connectionId/vertices",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId } = req.params;
      const { x, y, insertAfterIndex } = req.body;

      if (typeof x !== "number" || typeof y !== "number") {
        return res.status(400).json({
          error: "Invalid vertex coordinates",
        });
      }

      await assertCanvasAccess({
        userId: req.user.id,
        canvasId,
        level: "edit",
      });

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      // Generate unique ID for the new vertex
      const { v4: uuidv4 } = require("uuid");
      const newVertex = {
        id: uuidv4(),
        x,
        y,
      };

      // Insert vertex at specified index or append to end
      const vertices = [...(connection.vertices || [])];
      if (typeof insertAfterIndex === "number" && insertAfterIndex >= 0) {
        vertices.splice(insertAfterIndex + 1, 0, newVertex);
      } else {
        vertices.push(newVertex);
      }

      connection.vertices = vertices;
      connection.changed("vertices", true);
      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(201).json({
        success: true,
        vertex: newVertex,
        connection: connection.toJSON(),
      });

      const connections = await CanvasConnection.findAll({
        where: { canvas_id: canvasId },
        raw: true,
      });

      socketService.emitToRoom(canvasId, "vertexCreated", {
        connectionId: connection.id,
        vertex: newVertex,
        allConnections: connections,
      });
    } catch (error) {
      if (
        respondCanvasMutationError(res, error, {
          NOT_AUTHORIZED:
            "Forbidden: You don't have permission to edit this canvas",
        })
      )
        return;
      console.error("Failed to create vertex:", error);
      res.status(500).json({ error: "Failed to create vertex" });
    }
  },
);

// Update a vertex position (for dragging)
router.put(
  "/:canvasId/connections/:connectionId/vertices/:vertexId",
  protect,
  async (req, res) => {
    try {
      console.log("Updating vertex position");
      const { canvasId, connectionId, vertexId } = req.params;
      const { x, y } = req.body;

      if (typeof x !== "number" || typeof y !== "number") {
        return res.status(400).json({
          error: "Invalid vertex coordinates",
        });
      }

      await assertCanvasAccess({
        userId: req.user.id,
        canvasId,
        level: "edit",
      });

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      const vertices = connection.vertices || [];
      const vertexIndex = vertices.findIndex((v) => v.id === vertexId);

      if (vertexIndex === -1) {
        return res.status(404).json({
          error: "Vertex not found",
        });
      }

      vertices[vertexIndex].x = x;
      vertices[vertexIndex].y = y;

      connection.vertices = vertices;
      connection.changed("vertices", true);
      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(200).json({
        success: true,
        vertex: vertices[vertexIndex],
      });

      socketService.emitToRoom(canvasId, "vertexUpdated", {
        connectionId: connection.id,
        vertexId: vertices[vertexIndex].id,
        x: vertices[vertexIndex].x,
        y: vertices[vertexIndex].y,
      });
    } catch (error) {
      if (
        respondCanvasMutationError(res, error, {
          NOT_AUTHORIZED:
            "Forbidden: You don't have permission to edit this canvas",
        })
      )
        return;
      console.error("Failed to update vertex:", error);
      res.status(500).json({ error: "Failed to update vertex" });
    }
  },
);

// Delete a vertex and auto-reconnect
router.delete(
  "/:canvasId/connections/:connectionId/vertices/:vertexId",
  protect,
  async (req, res) => {
    try {
      const { canvasId, connectionId, vertexId } = req.params;

      await assertCanvasAccess({
        userId: req.user.id,
        canvasId,
        level: "edit",
      });

      const connection = await CanvasConnection.findOne({
        where: { id: connectionId, canvas_id: canvasId },
      });

      if (!connection) {
        return res.status(404).json({
          error: "Connection not found",
        });
      }

      const vertices = connection.vertices || [];
      const filteredVertices = vertices.filter((v) => v.id !== vertexId);

      if (filteredVertices.length === vertices.length) {
        return res.status(404).json({
          error: "Vertex not found",
        });
      }

      connection.vertices = filteredVertices;
      connection.changed("vertices", true);
      await connection.save();
      await touchCanvasTimestamp(canvasId);

      res.status(200).json({
        success: true,
        message: "Vertex deleted",
        connection: connection.toJSON(),
      });

      socketService.emitToRoom(canvasId, "vertexDeleted", {
        connectionId: connection.id,
        vertexId,
      });
    } catch (error) {
      if (
        respondCanvasMutationError(res, error, {
          NOT_AUTHORIZED:
            "Forbidden: You don't have permission to edit this canvas",
        })
      )
        return;
      console.error("Failed to delete vertex:", error);
      res.status(500).json({ error: "Failed to delete vertex" });
    }
  },
);

module.exports = router;
