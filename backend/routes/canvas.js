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
const {
  CANVAS_DRAFT_ATTRIBUTES,
  DRAFT_ATTRIBUTES,
} = require("./canvasProjections");
const User = require("../models/User.js");
const VersusDraft = require("../models/VersusDraft.js");
const Team = require("../models/Team.js");
const TeamPlayer = require("../models/TeamPlayer.js");
const { protect, getUserFromRequest } = require("../middleware/auth");
const socketService = require("../middleware/socketService");
const { assertCanvasAccess } = require("../services/canvasMutations");
const {
  depthOf,
  descendantGroupsOf,
  subtreeHeight,
  wouldCreateCycle,
} = require("../services/canvasTree");
const presenceEjection = require("../services/presenceEjection");
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

// Series chrome, mirroring SERIES_PADDING_X / SERIES_PADDING_Y /
// SERIES_HEADER_HEIGHT in frontend/src/utils/helpers.ts. A Card's positionX/Y
// are relative to its immediate container, so the first game of a brand-new
// series seeds at the series' own padding — NOT at the group's world position,
// which is what the three series-creation paths below used to add on top of it.
//
// X is 0 so a Bo-N series measures exactly N grid columns (design §6). These
// three runtimes — here, the frontend, and useLocalCanvasMutations — must move
// together or a Card jumps the moment it leaves a series.
const SERIES_PADDING_X = 0;
const SERIES_PADDING_Y = 20;
const SERIES_HEADER_HEIGHT = 56;
const SERIES_GAME_STEP = 380;

// Where the next game Card goes, given the last one already placed (if any).
// Both coordinates stay container-relative in either branch.
function nextSeriesCardOrigin(lastCanvasDraft) {
  return {
    x: lastCanvasDraft
      ? lastCanvasDraft.positionX + SERIES_GAME_STEP
      : SERIES_PADDING_X,
    y: lastCanvasDraft
      ? lastCanvasDraft.positionY
      : SERIES_HEADER_HEIGHT + SERIES_PADDING_Y,
  };
}

// A canvas series is a real VersusDraft row (origin "manual"), and the only FK
// between them runs CanvasGroups.versus_draft_id -> VersusDrafts with SET NULL.
// Nothing in the database ever deletes the series, so every path that removes a
// group has to destroy it by hand or leak the row forever. Deleting the series
// cascades to its game Drafts and, through them, to their CanvasDraft cards.
//
// Series with origin "live" are never touched: those are real drafting sessions
// that exist independently of whatever canvas happens to reference them.
async function destroyManualSeriesForGroups(groups, transaction) {
  const seriesIds = groups.map((g) => g.versus_draft_id).filter(Boolean);
  if (seriesIds.length === 0) return 0;

  return VersusDraft.destroy({
    where: { id: seriesIds, origin: "manual" },
    transaction,
  });
}

// Removing a canvas card destroys the CanvasDraft join row only. Nothing
// references Drafts.id back, so the Draft itself survives as a row no UI can
// reach. Destroy the ones no card points at any more.
//
// Series games are deliberately skipped: they belong to their series, not to
// the card, and go away with it via the versus_draft_id cascade.
async function destroyUnreferencedDrafts(draftIds, transaction) {
  if (draftIds.length === 0) return 0;

  // The schema allows one draft on several canvases, so losing one card is not
  // proof the draft is unused.
  const remainingCards = await CanvasDraft.findAll({
    where: { draft_id: draftIds },
    attributes: ["draft_id"],
    transaction,
  });
  const stillReferenced = new Set(remainingCards.map((cd) => cd.draft_id));
  const unreferenced = draftIds.filter((id) => !stillReferenced.has(id));
  if (unreferenced.length === 0) return 0;

  return Draft.destroy({
    where: { id: unreferenced, versus_draft_id: null },
    transaction,
  });
}

// Eager-load the linked Team entities (with rosters) so serialized groups carry
// the entity name for search resolution and the roster for "Scout this team".
const TEAM_INCLUDE = [
  {
    model: Team,
    as: "Team1",
    include: [{ model: TeamPlayer, as: "TeamPlayers" }],
  },
  {
    model: Team,
    as: "Team2",
    include: [{ model: TeamPlayer, as: "TeamPlayers" }],
  },
];

// Validates optional team1_id/team2_id from a group-update body against the
// set of team ids the requesting user owns. Absent field => no change; null =>
// unlink; a string must be in ownedTeamIds. Returns {updates} or {error}.
function resolveTeamLinkUpdate(body, ownedTeamIds) {
  const updates = {};
  for (const key of ["team1_id", "team2_id"]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = body[key];
    if (value === null) {
      updates[key] = null;
    } else if (typeof value === "string" && ownedTeamIds.has(value)) {
      updates[key] = value;
    } else if (typeof value === "string") {
      return { error: `${key} must reference a team you own` };
    } else {
      return { error: `${key} must be a team id string or null` };
    }
  }
  return { updates };
}

const VALID_GAME_TYPES = new Set(["scrim", "official", "scratch"]);

/** What an untagged series group is worth. Mirrors D2's derivation rule. */
function deriveGameType(competitive) {
  return competitive ? "official" : "scrim";
}

/**
 * Merge client-supplied group metadata over what is stored, honouring the
 * clear protocol (design D3): `gameType: null` means "delete this key".
 *
 * The update is a shallow merge over a JSON-serialized payload, so `undefined`
 * simply drops out of the request and cannot clear a stored value — hence the
 * explicit null. Deleting rather than storing JSON null keeps stored metadata
 * enum-or-absent, which is what the read schema expects.
 *
 * Shared by BOTH merge points on purpose. Inline at one site leaves the other
 * able to store a JSON null.
 */
function mergeGroupMetadata(storedMetadata, incomingMetadata) {
  const merged = { ...(storedMetadata || {}), ...(incomingMetadata || {}) };
  if (merged.gameType === null) delete merged.gameType;
  return merged;
}

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
    // Carried so a conversion request can classify the group it is creating.
    // Consumed by the metadata build only — the caller also spreads this object
    // into VersusDraft.create, where Sequelize drops unknown attributes.
    ...(VALID_GAME_TYPES.has(body.gameType)
      ? { gameType: body.gameType }
      : {}),
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
  const groups = await CanvasGroup.findAll({
    where: { canvas_id: canvasId },
    include: TEAM_INCLUDE,
  });
  const canvasDrafts = await CanvasDraft.findAll({
    where: { canvas_id: canvasId },
    attributes: CANVAS_DRAFT_ATTRIBUTES,
    include: [
      {
        model: Draft,
        attributes: DRAFT_ATTRIBUTES,
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
    const { x: startX, y: startY } = nextSeriesCardOrigin(lastDraft);

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
          positionX: startX + (i - currentLength) * SERIES_GAME_STEP,
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
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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
      include: TEAM_INCLUDE,
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
    console.error("Error loading canvas:", error);
    res.status(500).json({ error: "Failed to load canvas" });
  }
});

router.put("/:canvasId/draft/:draftId", protect, async (req, res) => {
  try {
    const {
      positionX,
      positionY,
      group_id,
      winner,
      blueSideTeam,
      firstPick,
      team1Name,
      team2Name,
    } = req.body;
    const { canvasId, draftId } = req.params;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const canvasDraftUpdates = {};
    if (typeof positionX === "number") canvasDraftUpdates.positionX = positionX;
    if (typeof positionY === "number") canvasDraftUpdates.positionY = positionY;
    if (group_id !== undefined) canvasDraftUpdates.group_id = group_id; // null to ungroup
    // Empty string means "inherit again", so normalise it to null rather than
    // persisting a blank label that would render as "Team 1".
    if (typeof team1Name === "string") {
      canvasDraftUpdates.team1Name = team1Name.trim() || null;
    }
    if (typeof team2Name === "string") {
      canvasDraftUpdates.team2Name = team2Name.trim() || null;
    }

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

    const foreignGroup = await findGroupNotOnCanvas({
      canvasId,
      groupIds: [group_id],
    });
    if (foreignGroup) {
      return res
        .status(404)
        .json({ error: `Group ${foreignGroup} not found on canvas` });
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

      const nameChanged =
        canvasDraftUpdates.team1Name !== undefined ||
        canvasDraftUpdates.team2Name !== undefined;

      if (
        group_id !== undefined ||
        Object.keys(draftUpdates).length > 0 ||
        nameChanged
      ) {
        // Use the shared builder: the old hand-built payload fetched groups
        // without TEAM_INCLUDE, so every broadcast stripped Team1/Team2 and
        // their rosters from the client store — which made the Scout button
        // disappear until reload.
        const payload = await getCanvasBroadcastPayload(canvasId);
        socketService.emitToRoom(canvasId, "canvasUpdate", payload);
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

// Soft nesting cap (recursive-groups decision 6). Measured in ANCESTORS, so 4
// permits five levels of containment. Checked against the deepest leaf of the
// moved subtree, not the moved Group alone — dropping a two-level subtree under
// a depth-3 parent puts its leaves at depth 5.
//
// Duplicated from `MAX_GROUP_DEPTH` in `@draft-sim/shared-types/canvas-tree-vector`,
// which this file cannot require (ESM). `canvasGroupNesting.test.js` imports the
// shared constant and derives its fixtures from it, so drift fails a test.
const MAX_GROUP_DEPTH = 4;

// Canonical acquisition order for CanvasGroup row locks (design §8.1). Postgres
// puts LockRows above Sort, so `ORDER BY id FOR UPDATE` locks in id order and
// two overlapping subtree moves queue instead of deadlocking.
const GROUP_LOCK_ORDER = [["id", "ASC"]];

// Deadlock retry is defence in depth behind the lock ordering, and it is only
// safe because the whole commit is idempotent: positions are absolute on the
// wire and a replayed container move re-derives dx against the re-read row.
const COMMIT_RETRIES = 2;

function isRetryableTransactionError(error) {
  const code = error?.parent?.code ?? error?.original?.code;
  // 40P01 deadlock_detected, 40001 serialization_failure.
  return code === "40P01" || code === "40001";
}

const hasKey = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);

/**
 * The single parentage predicate, shared by every route that writes
 * `parent_group_id` (design §8.1, plan A6). Two hand-written copies of these
 * four checks is the drift §7 exists to stop, and this area has reproduced it
 * once per step.
 *
 * **Validated against the tree the writes would PRODUCE, not the stored one.**
 * Two entries in one request can each look legal alone and form a cycle
 * together (A under B, B under A).
 *
 * `lockedById` is every Group on the canvas, already locked FOR UPDATE — which
 * is what makes "exists" and "is on this canvas" one check, and what makes the
 * answer still true at write time. `pending` maps a Group id to its next parent
 * (`null` = top level). An id in `pending` that is NOT in `lockedById` is a row
 * that does not exist yet (the create route): it is spliced into the
 * prospective tree as a `custom` Group, because `depthOf` cannot measure a node
 * that is not there.
 *
 * Returns `{ nextTree, rejection }`; `rejection` is `{ status, error }` or null.
 * Rolling back is the caller's job — it owns the transaction.
 */
function resolveParentage({ lockedById, pending }) {
  const nextTree = {
    groups: [...lockedById.values()].map((row) => ({
      id: row.id,
      type: row.type,
      parent_group_id: pending.has(row.id)
        ? pending.get(row.id)
        : (row.parent_group_id ?? null),
    })),
  };
  for (const [id, parentId] of pending) {
    if (!lockedById.has(id)) {
      nextTree.groups.push({
        id,
        type: "custom",
        parent_group_id: parentId,
      });
    }
  }

  const reject = (rejection) => ({ nextTree, rejection });

  for (const [id, parentId] of pending) {
    if (parentId !== null) {
      const parentRow = lockedById.get(parentId);
      // Existence and same-canvas are one check: the locked map holds this
      // canvas's Groups and nothing else.
      if (!parentRow) {
        return reject({ status: 400, error: "That group isn't on this canvas" });
      }
      if (parentRow.type === "series") {
        return reject({
          status: 400,
          error: "Can't put a group inside a series",
        });
      }
    }
    if (wouldCreateCycle(nextTree, id, parentId)) {
      return reject({ status: 400, error: "Can't put a group inside itself" });
    }
  }
  // Depth is only meaningful once the result is known to be acyclic, which is
  // why this is a second pass rather than a clause in the first.
  for (const id of pending.keys()) {
    if (depthOf(nextTree, id) + subtreeHeight(nextTree, id) > MAX_GROUP_DEPTH) {
      return reject({ status: 400, error: "Too deeply nested" });
    }
  }
  return { nextTree, rejection: null };
}

/**
 * A Card's `group_id` is a container reference, and until step 4 nothing
 * validated it on any path: a crafted id could park a Card in another canvas's
 * Group — or a deleted one — where it renders on neither canvas.
 *
 * One helper rather than a check per route, because the three write paths
 * (`PUT /draft-positions`, `PUT /draft/:draftId`, `POST /draft/:draftId/copy`)
 * drifting apart is the failure mode this whole area keeps reproducing.
 *
 * Returns the first id that is not on the canvas, or null. Non-strings (an
 * explicit `null` to ungroup, an absent key) are ignored, and an empty set
 * costs no query. Pass `known` when the caller already holds the canvas's
 * Groups — the batch endpoint locks them all and must not re-read.
 */
async function findGroupNotOnCanvas({
  canvasId,
  groupIds,
  transaction,
  known,
}) {
  const wanted = [
    ...new Set(groupIds.filter((groupId) => typeof groupId === "string")),
  ];
  if (wanted.length === 0) return null;
  const onCanvas =
    known ??
    new Set(
      (
        await CanvasGroup.findAll({
          where: { canvas_id: canvasId, id: wanted },
          attributes: ["id"],
          transaction,
        })
      ).map((row) => row.id),
    );
  return wanted.find((groupId) => !onCanvas.has(groupId)) ?? null;
}

/**
 * The transactional half of PUT /:canvasId/draft-positions.
 *
 * Returns `{ status, error }` for a rejection the caller should send, or
 * `{ updatedGroup, groupMoves }` on success. It owns its own transaction so the
 * caller can retry the whole thing on a deadlock.
 */
async function commitDraftPositions({ canvasId, positions, groups, group }) {
  let t;
  try {
    t = await Canvas.sequelize.transaction();

    // ---- Locks and validation come before any write (design §8.1) ----
    //
    // The lock covers EVERY Group on the canvas, not just the resolved affected
    // set. The design asks for "the affected set, sorted by id" — but that set
    // is data-dependent on the very rows being locked (a descendant is only a
    // descendant according to parent pointers we have not locked yet), so
    // resolving it from an unlocked read leaves a window where a concurrent
    // reparent moves a Group into the subtree and the fan-out silently skips
    // it. Canvas-wide is a superset in one stable order, and it only runs when
    // Groups are actually moving — a Card-only commit (every grid drag, by far
    // the hot path) takes no Group lock at all and keeps today's query plan.
    let lockedById = null;
    if (groups.length > 0) {
      const rows = await CanvasGroup.findAll({
        where: { canvas_id: canvasId },
        order: GROUP_LOCK_ORDER,
        lock: true,
        transaction: t,
      });
      lockedById = new Map(rows.map((row) => [row.id, row]));

      for (const entry of groups) {
        if (!lockedById.has(entry.id)) {
          await t.rollback();
          return {
            status: 404,
            error: `Group ${entry.id} not found on canvas`,
          };
        }
      }
    }

    // Cards may only be dropped into a container on THIS canvas. The locked map
    // already holds every Group here, so a groups[] commit needs no second read.
    const foreignCardGroup = await findGroupNotOnCanvas({
      canvasId,
      groupIds: positions.map((p) => p.group_id),
      transaction: t,
      known: lockedById ? new Set(lockedById.keys()) : undefined,
    });
    if (foreignCardGroup) {
      await t.rollback();
      return {
        status: 404,
        error: `Group ${foreignCardGroup} not found on canvas`,
      };
    }

    const groupWrites = new Map();
    let nextTree = null;
    if (groups.length > 0) {
      const pendingParent = new Map();
      for (const entry of groups) {
        if (hasKey(entry, "parentId")) {
          pendingParent.set(entry.id, entry.parentId ?? null);
        }
      }
      const parentage = resolveParentage({ lockedById, pending: pendingParent });
      nextTree = parentage.nextTree;
      if (parentage.rejection) {
        await t.rollback();
        return parentage.rejection;
      }

      // ---- Derive the delta, fan it out, and only then write ----
      //
      // Every position in `groups` is an absolute target; `dx` comes from the
      // locked stored row. Descendants that carry their own entry are pruned
      // together with their subtrees, so each row takes its delta from exactly
      // one source: its nearest explicitly-moved ancestor, or itself.
      const explicitIds = new Set(groups.map((entry) => entry.id));
      for (const entry of groups) {
        const row = lockedById.get(entry.id);
        const updates = {
          positionX: entry.positionX,
          positionY: entry.positionY,
        };
        if (pendingParent.has(entry.id)) {
          updates.parent_group_id = pendingParent.get(entry.id);
        }
        groupWrites.set(entry.id, updates);

        const dx = entry.positionX - row.positionX;
        const dy = entry.positionY - row.positionY;
        if (dx === 0 && dy === 0) continue;
        for (const descendant of descendantGroupsOf(
          nextTree,
          entry.id,
          explicitIds,
        )) {
          const descendantRow = lockedById.get(descendant.id);
          groupWrites.set(descendant.id, {
            positionX: descendantRow.positionX + dx,
            positionY: descendantRow.positionY + dy,
          });
        }
      }
    }

    for (const p of positions) {
      const updates = { positionX: p.positionX, positionY: p.positionY };
      if (p.group_id !== undefined) updates.group_id = p.group_id;
      const [updated] = await CanvasDraft.update(updates, {
        where: { canvas_id: canvasId, draft_id: p.draft_id },
        transaction: t,
      });
      if (updated === 0) {
        await t.rollback();
        return {
          status: 404,
          error: `Draft ${p.draft_id} not found on canvas`,
        };
      }
    }

    for (const [groupId, updates] of groupWrites) {
      await lockedById.get(groupId).update(updates, { transaction: t });
    }

    let updatedGroup = null;
    if (group && typeof group === "object" && typeof group.id === "string") {
      // Reuse the locked instance when there is one: re-reading a row this
      // transaction may have just moved would be a second source of truth for
      // the same fields.
      const groupRow =
        lockedById?.get(group.id) ??
        (await CanvasGroup.findOne({
          where: { id: group.id, canvas_id: canvasId },
          transaction: t,
        }));
      if (!groupRow) {
        await t.rollback();
        return { status: 404, error: "Group not found" };
      }
      const groupUpdates = {};
      if (typeof group.width === "number") groupUpdates.width = group.width;
      if (typeof group.height === "number") groupUpdates.height = group.height;
      if (group.metadata && typeof group.metadata === "object") {
        groupUpdates.metadata = mergeGroupMetadata(
          groupRow.metadata,
          group.metadata,
        );
      }
      if (Object.keys(groupUpdates).length > 0) {
        await groupRow.update(groupUpdates, { transaction: t });
      }
      updatedGroup = groupRow;
    }

    await t.commit();

    // The wire shape is the live relay's (`canvasMutations.js` relayGroupMove),
    // not the single-group route's — width/height are unchanged by a move, and
    // the client handler reads position only. `parentId` rides along only when
    // parentage actually changed; it is the sole channel carrying it.
    const groupMoves = [...groupWrites].map(([groupId, updates]) => ({
      groupId,
      positionX: updates.positionX,
      positionY: updates.positionY,
      ...(hasKey(updates, "parent_group_id")
        ? { parentId: updates.parent_group_id }
        : {}),
    }));

    return { updatedGroup, groupMoves };
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    throw error;
  }
}

// Batch position commit: grid snap/swap, arrange-as-grid, and container moves.
// Updates all drafts, any moved Groups plus their descendants, and optionally
// one group's metadata/dimensions in a single transaction, then broadcasts.
router.put("/:canvasId/draft-positions", protect, async (req, res) => {
  try {
    const { canvasId } = req.params;
    const { group } = req.body;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    // Normalize before validating: the loops below iterate `positions` and
    // `groups` unconditionally, so an omitted array must become [] here or it
    // throws a 500 instead of returning a 400.
    const rawPositions = req.body.positions;
    if (rawPositions !== undefined && !Array.isArray(rawPositions)) {
      return res.status(400).json({
        error: "positions must be an array of {draft_id, positionX, positionY}",
      });
    }
    const positions = rawPositions ?? [];

    const validPositions = positions.every(
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
        error: "positions must be an array of {draft_id, positionX, positionY}",
      });
    }

    const rawGroups = req.body.groups;
    if (rawGroups !== undefined && !Array.isArray(rawGroups)) {
      return res.status(400).json({
        error: "groups must be an array of {id, positionX, positionY}",
      });
    }
    const groups = rawGroups ?? [];

    // positionX/Y are the container's ABSOLUTE target (ADR-0006). parentId is
    // tri-state on key PRESENCE: absent leaves parentage alone, null moves to
    // top level, a string reparents.
    const validGroups = groups.every(
      (g) =>
        g &&
        typeof g.id === "string" &&
        typeof g.positionX === "number" &&
        typeof g.positionY === "number" &&
        (!hasKey(g, "parentId") ||
          g.parentId === null ||
          typeof g.parentId === "string"),
    );
    if (!validGroups) {
      return res.status(400).json({
        error: "groups must be an array of {id, positionX, positionY}",
      });
    }
    if (new Set(groups.map((g) => g.id)).size !== groups.length) {
      return res
        .status(400)
        .json({ error: "groups must not contain the same id twice" });
    }

    // Emptiness is validated separately from shape: an empty group has no
    // cards to place, so "Arrange as grid" legitimately sends positions: []
    // with only the group's layout/dimensions. Requiring a non-empty
    // positions array 400d that case.
    const groupCarriesWork =
      group &&
      typeof group === "object" &&
      typeof group.id === "string" &&
      (typeof group.width === "number" ||
        typeof group.height === "number" ||
        (group.metadata && typeof group.metadata === "object"));
    if (positions.length === 0 && groups.length === 0 && !groupCarriesWork) {
      return res.status(400).json({
        error:
          "Nothing to update: provide positions, groups, or a group with width/height/metadata",
      });
    }

    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await commitDraftPositions({
          canvasId,
          positions,
          groups,
          group,
        });
        break;
      } catch (error) {
        if (attempt >= COMMIT_RETRIES || !isRetryableTransactionError(error)) {
          throw error;
        }
      }
    }

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    await touchCanvasTimestamp(canvasId);

    res.status(200).json({ success: true });

    // Group events go FIRST. A mixed commit tears for one frame either way, but
    // the two tears are not the same size: under ADR-0006 a Card's world
    // position is container + relative offset, so applying Cards first can
    // render them at the OLD container position — off by the whole drag
    // distance — while applying Groups first bounds the error to the
    // intra-container reflow the same commit is making.
    for (const move of result.groupMoves) {
      socketService.emitToRoom(canvasId, "groupMoved", move);
    }

    // Suppressed on a groups-only commit: schema-valid and a client no-op, but
    // it would broadcast `positions: []` for a change that moved no Cards.
    if (positions.length > 0 || result.updatedGroup) {
      socketService.emitToRoom(canvasId, "draftPositionsUpdated", {
        positions,
        group: result.updatedGroup ? result.updatedGroup.toJSON() : null,
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

    const { positionX, positionY, group_id } = req.body ?? {};

    // Ahead of Draft.create, not after it: this route has no transaction, so a
    // rejection between the two creates would strand an ownerless Draft row.
    // Only an explicitly requested container needs checking — the inherited one
    // came off a row on this canvas and cannot be foreign.
    const foreignGroup = await findGroupNotOnCanvas({
      canvasId,
      groupIds: [group_id],
    });
    if (foreignGroup) {
      return res
        .status(404)
        .json({ error: `Group ${foreignGroup} not found on canvas` });
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
      team1Name: existingCanvasDraft.team1Name,
      team2Name: existingCanvasDraft.team2Name,
      source_type: "canvas",
    });

    await touchCanvasTimestamp(canvasId);

    // Fetch full canvas data for socket broadcast
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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

    // Only delete the specific deletable draft, not all with the same draft_id.
    // This destroys the CanvasDraft join row; nothing references Drafts.id back,
    // so the Draft itself used to survive as an unreachable orphan. Destroy it
    // too once no canvas card is left pointing at it.
    const draftTx = await Canvas.sequelize.transaction();
    try {
      await deletableDraft.destroy({ transaction: draftTx });
      await destroyUnreferencedDrafts([draftId], draftTx);
      await draftTx.commit();
    } catch (error) {
      if (!draftTx.finished) await draftTx.rollback();
      throw error;
    }

    await touchCanvasTimestamp(canvasId);

    const canvas = await Canvas.findByPk(canvasId);
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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
          // Seeded here rather than in getSeriesMetadata: that helper's output
          // is spread LAST over merged metadata on the manual-series settings
          // save, so a derived value there would reset a user's correction in
          // the very request that saved it (R1 path 1).
          gameType: deriveGameType(versusDraft.competitive),
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
          // Container-relative, like every other Card: the group already
          // carries the world position these used to add a second time.
          positionX: SERIES_PADDING_X + i * SERIES_GAME_STEP,
          positionY: SERIES_HEADER_HEIGHT + SERIES_PADDING_Y,
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
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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

      // The series-leaf invariant (decision 6) was enforced on every PARENTAGE
      // write and on no TYPE write, so this route could turn a container full
      // of Groups into a series — a persisted taxonomy violation one dialog
      // save away, found independently by both round-1 reviewers (plan A13).
      // `SeriesGroupContainer` renders only Cards, `nodeSize` sizes a series
      // from its game count, and §8.1 then rejects every new parentage into it
      // while the illegal state persists.
      const childGroupCount = await CanvasGroup.count({
        where: { parent_group_id: groupId, canvas_id: canvasId },
        transaction: t,
      });
      if (childGroupCount > 0) {
        await t.rollback();
        return res
          .status(400)
          .json({ error: "Can't convert a group that contains groups" });
      }

      // Team links picked in the Group Settings dialog arrive with the very
      // request that creates the series, so they must persist here — the group
      // is not yet a series and cannot be linked by the PUT-group path.
      const teamLinkUpdates = {};
      if (
        Object.prototype.hasOwnProperty.call(req.body, "team1_id") ||
        Object.prototype.hasOwnProperty.call(req.body, "team2_id")
      ) {
        const owned = await Team.findAll({
          where: { owner_id: req.user.id },
          attributes: ["id"],
          transaction: t,
        });
        const ownedIds = new Set(owned.map((row) => row.id));
        const linkResult = resolveTeamLinkUpdate(req.body, ownedIds);
        if (linkResult.error) {
          await t.rollback();
          return res.status(400).json({ error: linkResult.error });
        }
        Object.assign(teamLinkUpdates, linkResult.updates);
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
      const { x: startX, y: startY } = nextSeriesCardOrigin(lastCanvasDraft);

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
            positionX: startX + (i - existingToConvert.length) * SERIES_GAME_STEP,
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

      // Merge over the stored metadata rather than replacing it (R1 path 2).
      // The old wholesale replacement discarded the group's gameType — turning
      // a custom group the user had tagged "official" into a scrim on
      // conversion — along with layout, gridCols, rowLabels and origin.
      // Precedence: explicit body value, then whatever the group already
      // carried, then derived from the new versus draft.
      const convertedGameType =
        data.gameType ||
        group.metadata?.gameType ||
        deriveGameType(versusDraft.competitive);
      await group.update(
        {
          name: data.name,
          type: "series",
          versus_draft_id: versusDraft.id,
          metadata: {
            ...group.metadata,
            ...getSeriesMetadata(versusDraft),
            gameType: convertedGameType,
          },
          ...teamLinkUpdates,
        },
        { transaction: t },
      );

      // Hydrate the linked teams (with rosters) onto the response so the client
      // store gets Team1/Team2 immediately — the Scout button keys on them and
      // must not wait for the next full canvas GET. Read inside the transaction:
      // it sees our own write, and a failure here still rolls the conversion
      // back rather than stranding a converted group behind a 500.
      const groupWithTeams = await CanvasGroup.findOne({
        where: { id: groupId },
        include: TEAM_INCLUDE,
        transaction: t,
      });

      await t.commit();
      await touchCanvasTimestamp(canvasId);

      const payload = await getCanvasBroadcastPayload(canvasId);

      res.status(201).json({
        success: true,
        group: {
          ...(groupWithTeams ?? group).toJSON(),
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

// Create a custom group. `parentId` nests it (design §9.1c, plan A6) — creation
// is a parentage write like any other and goes through `resolveParentage`.
router.post("/:canvasId/group", protect, async (req, res) => {
  let t;
  try {
    const { canvasId } = req.params;
    const { name, positionX, positionY, parentId } = req.body;

    await assertCanvasAccess({ userId: req.user.id, canvasId, level: "edit" });

    const groupName =
      name && typeof name === "string" && name.trim().length > 0
        ? name.trim()
        : await generateUniqueCanvasGroupName("New Group", canvasId);

    // ADR-0006: a Group stores ABSOLUTE world coordinates at every depth, so a
    // nested create writes the position it was given, unrewritten. The Draft
    // branch of the same context menu subtracts the container origin because a
    // Card's coordinates are container-relative; a Group's are not.
    const attributes = {
      canvas_id: canvasId,
      name: groupName,
      type: "custom",
      positionX: positionX ?? 50,
      positionY: positionY ?? 50,
      width: 400,
      height: 200,
    };

    let group;
    if (typeof parentId === "string") {
      // Only the nested create takes the canvas-wide lock; an unparented create
      // keeps its lock-free plan. Validating depth and series-leaf and THEN
      // inserting without the lock is a TOCTOU window against a concurrent
      // reparent, conversion or delete — the same hole the batch route pays for
      // (plan A6, round 1). Same lock, same order, so the two queue rather than
      // deadlock.
      t = await Canvas.sequelize.transaction();
      const rows = await CanvasGroup.findAll({
        where: { canvas_id: canvasId },
        order: GROUP_LOCK_ORDER,
        lock: true,
        transaction: t,
      });
      const lockedById = new Map(rows.map((row) => [row.id, row]));
      // A fresh row cannot be in a cycle, but it can be too deep or under a
      // series, and `resolveParentage` splices it into the tree so `depthOf`
      // can measure a node that does not exist yet.
      const pendingId = "__new__";
      const { rejection } = resolveParentage({
        lockedById,
        pending: new Map([[pendingId, parentId]]),
      });
      if (rejection) {
        await t.rollback();
        return res.status(rejection.status).json({ error: rejection.error });
      }
      group = await CanvasGroup.create(
        { ...attributes, parent_group_id: parentId },
        { transaction: t },
      );
      await t.commit();
    } else {
      group = await CanvasGroup.create(attributes);
    }

    await touchCanvasTimestamp(canvasId);

    // Fetch all groups for socket broadcast
    const groups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
    });

    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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
    if (t && !t.finished) await t.rollback();
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

    // The group is going away either way, so its backing series would describe
    // nothing. Load it now while the link still exists. Only manual series are
    // ours to delete — a live one is a real drafting session.
    const backingSeries = group.versus_draft_id
      ? await VersusDraft.findOne({
          where: { id: group.versus_draft_id, origin: "manual" },
          transaction: t,
        })
      : null;

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

      // These cards stay on the canvas, so their Drafts must stop pointing at
      // the series before we destroy it — versus_draft_id cascades, and would
      // delete the very drafts keepDrafts exists to preserve. Mirrors how the
      // series-creation path releases drafts it does not convert.
      if (backingSeries) {
        const seriesDrafts = await Draft.findAll({
          where: { versus_draft_id: backingSeries.id },
          attributes: ["id"],
          transaction: t,
        });
        const seriesDraftIds = seriesDrafts.map((d) => d.id);

        if (seriesDraftIds.length > 0) {
          await Draft.update(
            { versus_draft_id: null, seriesIndex: null },
            { where: { id: seriesDraftIds }, transaction: t },
          );
          await CanvasDraft.update(
            { source_type: "canvas" },
            { where: { draft_id: seriesDraftIds }, transaction: t },
          );
        }
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

      // Cards a series does not own (drafts left loose inside the group) have
      // no other owner, so destroying the join rows alone would strand them.
      await destroyUnreferencedDrafts([...draftIdsToRemove], t);
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

    // Promote direct child Groups before the destroy (design §8.2.0, plan A2).
    // `parent_group_id` is declared with no `onDelete`, so Postgres applies
    // NO ACTION: without this, deleting a container that holds a Group is a 500
    // and the container becomes undeletable. Only the direct children move —
    // the rest of decision 10 (delete-with-contents, promote-into-a-surviving-
    // parent's coordinate rebase) stays in 5b. Groups store absolute world
    // coordinates at every depth (ADR-0006), so a promotion writes no position.
    await CanvasGroup.update(
      { parent_group_id: group.parent_group_id ?? null },
      {
        where: { parent_group_id: groupId, canvas_id: canvasId },
        transaction: t,
      },
    );

    // Delete the group
    await group.destroy({ transaction: t });

    // Then the series it was the only reference to. On the delete-drafts path
    // this also cascades away the game Drafts the join-row deletion left behind.
    if (backingSeries) {
      await backingSeries.destroy({ transaction: t });
    }

    await t.commit();
    await touchCanvasTimestamp(canvasId);

    // Fetch updated canvas data
    const canvasDrafts = await CanvasDraft.findAll({
      where: { canvas_id: canvasId },
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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
      updates.metadata = mergeGroupMetadata(group.metadata, metadata);
    }

    // Team linking (owner-validated). team1_id/team2_id may be string|null.
    if (
      Object.prototype.hasOwnProperty.call(req.body, "team1_id") ||
      Object.prototype.hasOwnProperty.call(req.body, "team2_id")
    ) {
      const owned = await Team.findAll({
        where: { owner_id: req.user.id },
        attributes: ["id"],
        transaction: t,
      });
      const ownedIds = new Set(owned.map((row) => row.id));
      const linkResult = resolveTeamLinkUpdate(req.body, ownedIds);
      if (linkResult.error) {
        await t.rollback();
        return res.status(400).json({ error: linkResult.error });
      }
      Object.assign(updates, linkResult.updates);
    }

    if (Object.keys(updates).length === 0) {
      await t.rollback();
      return res.status(400).json({ error: "No valid fields to update" });
    }

    let versusDraft = null;
    // Declared out here because the response builder below reads it: a length
    // change creates or destroys game Cards server-side, and the saving client
    // needs them back to reflow the parent grid against the new footprint.
    let lengthChanged = false;
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
          lengthChanged = true;
        }

        if (Object.keys(seriesUpdates).length > 0) {
          await versusDraft.update(seriesUpdates, { transaction: t });
          // R1 path 1. This branch runs on EVERY manual-series settings save,
          // including a rename alone — where `metadata` was never sent, so
          // `updates.metadata` is undefined and the old spread was a full
          // replacement that wiped gameType, layout, gridCols, rowLabels and
          // origin.
          //
          // The base is `updates.metadata` when the request carried metadata
          // (it is ALREADY merged over group.metadata, clear protocol applied)
          // and the stored metadata otherwise. Re-spreading group.metadata on
          // top of updates.metadata would resurrect a gameType the same request
          // just cleared.
          const baseMetadata = updates.metadata ?? group.metadata ?? {};
          updates.metadata = {
            ...baseMetadata,
            ...getSeriesMetadata({ ...versusDraft.toJSON(), ...seriesUpdates }),
          };
        }
      }
    }

    await group.update(updates, { transaction: t });
    await t.commit();
    await touchCanvasTimestamp(canvasId);

    const groupWithTeams = await CanvasGroup.findOne({
      where: { id: groupId },
      include: TEAM_INCLUDE,
    });

    // A length change creates or destroys game Cards server-side. The saving
    // client needs them to run the parent grid's reflow as the SINGLE writer —
    // the canvasUpdate broadcast below reaches every editor and names no group,
    // so reflowing from it would have N clients each commit (design §6.1).
    // Same shape as convertGroupToSeries, which the client already consumes.
    let responseGroup = groupWithTeams.toJSON();
    if (lengthChanged) {
      const groupCanvasDrafts = await CanvasDraft.findAll({
        where: { canvas_id: canvasId, group_id: groupId },
        include: [{ model: Draft }],
        order: [
          ["positionX", "ASC"],
          ["positionY", "ASC"],
          ["createdAt", "ASC"],
        ],
      });
      responseGroup = {
        ...responseGroup,
        CanvasDrafts: groupCanvasDrafts.map((cd) => ({
          ...cd.toJSON(),
          Draft: cd.Draft.toJSON(),
        })),
      };
    }
    res.status(200).json({ success: true, group: responseGroup });

    // Emit appropriate socket event.
    //
    // This route is the RESIZE route; it never emits `groupMoved`. The only
    // caller that ever sent a bare position was the container drag, and since
    // 5a-2 that commits through `PUT /draft-positions`, where the server can
    // fan the delta out over the subtree. The `groupMoved` this used to emit
    // was a left-edge resize telling every other client "the frame moved" — and
    // a receiver that fanned that out would drag the child Groups left by
    // `expandLeft` with nothing to correct it, because a left-edge resize moves
    // the frame's edge and NOT world space (design 3.1c, plan A3).
    //
    // Two branches, in this order:
    //
    //  - A metadata change takes the full payload, because `groupResized`
    //    carries dimensions only. Since 5a-0 a resize also persists the manual
    //    size floor, and a client left on a stale floor resolves this container
    //    to the wrong size on its next drop.
    //  - Otherwise a resize emits `groupResized`, whose handler rebases child
    //    CARDS by the left-edge delta and correctly leaves child Groups alone
    //    (they are absolute at every depth, ADR-0006).
    //
    // The dimension guard is on BOTH being numbers: the route accepts one
    // dimension or an explicit `null`, while `GroupResizedSchema` requires both
    // numeric — so `{positionX, width: null}` would emit an event every client
    // silently drops.
    if (
      updates.metadata === undefined &&
      typeof updates.width === "number" &&
      typeof updates.height === "number"
    ) {
      socketService.emitToRoom(canvasId, "groupResized", {
        groupId,
        width: group.width,
        height: group.height,
        ...(updates.positionX !== undefined
          ? { positionX: group.positionX }
          : {}),
      });
    } else {
      // Name / metadata / partial-dimension changes: full canvas update.
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

    // Groups disappear by DB CASCADE the moment the canvas does, so this is the
    // last point at which the canvas -> group -> series link is readable. Once
    // Canvas.destroy runs, the manual series backing these groups is
    // unreachable and would leak permanently.
    const canvasGroups = await CanvasGroup.findAll({
      where: { canvas_id: canvasId },
      attributes: ["versus_draft_id"],
      transaction: t,
    });
    await destroyManualSeriesForGroups(canvasGroups, t);

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
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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
      attributes: CANVAS_DRAFT_ATTRIBUTES,
      include: [
        {
          model: Draft,
          attributes: DRAFT_ATTRIBUTES,
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

    // No email: any member (including view-only) can fetch this list for
    // the Share popover, and nothing in the UI renders email anymore.
    const canvas = await Canvas.findByPk(canvasId, {
      include: [
        {
          model: User,
          attributes: ["id", "name", "picture", "display_name"],
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

    if (!["view", "edit", "admin"].includes(permissions)) {
      return res.status(400).json({ error: "Invalid permissions value" });
    }

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
      // Room membership is the ACL for presence relays, so revoking access
      // must also force the user's live sockets out of the canvas room.
      presenceEjection.ejectUserFromCanvas(canvasId, userId);
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
      const newVertex = {
        id: require("crypto").randomUUID(),
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
module.exports.resolveTeamLinkUpdate = resolveTeamLinkUpdate;
