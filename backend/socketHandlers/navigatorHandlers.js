const NavigatorSession = require("../models/NavigatorSession");
const NavigatorDraft = require("../models/NavigatorDraft");
const NavigatorEvent = require("../models/NavigatorEvent");
const NavigatorSnapshot = require("../models/NavigatorSnapshot");
const { computeForDraft } = require("../services/navigatorEngine");
const { getOurSideForGame } = require("../utils/navigatorSide");

// Per-session engine job version. Bumped on every pick/ban/undo. Results whose
// job version is behind the session's current version are dropped.
const sessionVersions = new Map();

function bumpVersion(sessionId) {
  const next = (sessionVersions.get(sessionId) || 0) + 1;
  sessionVersions.set(sessionId, next);
  return next;
}

function getCurrentVersion(sessionId) {
  return sessionVersions.get(sessionId) || 0;
}

const TURN_SEQUENCE = [
  { side: "blue", type: "ban", phase: "ban1" },
  { side: "red", type: "ban", phase: "ban1" },
  { side: "blue", type: "ban", phase: "ban1" },
  { side: "red", type: "ban", phase: "ban1" },
  { side: "blue", type: "ban", phase: "ban1" },
  { side: "red", type: "ban", phase: "ban1" },
  { side: "blue", type: "pick", phase: "pick1" },
  { side: "red", type: "pick", phase: "pick1" },
  { side: "red", type: "pick", phase: "pick1" },
  { side: "blue", type: "pick", phase: "pick1" },
  { side: "blue", type: "pick", phase: "pick1" },
  { side: "red", type: "pick", phase: "pick1" },
  { side: "red", type: "ban", phase: "ban2" },
  { side: "blue", type: "ban", phase: "ban2" },
  { side: "red", type: "ban", phase: "ban2" },
  { side: "blue", type: "ban", phase: "ban2" },
  { side: "red", type: "pick", phase: "pick2" },
  { side: "blue", type: "pick", phase: "pick2" },
  { side: "blue", type: "pick", phase: "pick2" },
  { side: "red", type: "pick", phase: "pick2" },
];

const TOTAL_TURNS = TURN_SEQUENCE.length; // 20

function getSocketUserId(socket) {
  return socket.user?.id || socket.user?.dataValues?.id || null;
}

function getRoomName(sessionId) {
  return `navigator:${sessionId}`;
}

function emitNavigatorError(socket, error) {
  socket.emit("navigatorError", { error });
}

async function findOwnedSession(sessionId, socket) {
  const userId = getSocketUserId(socket);

  if (!userId) {
    emitNavigatorError(socket, "Authentication required");
    return null;
  }

  const session = await NavigatorSession.findByPk(sessionId);
  if (!session) {
    emitNavigatorError(socket, "Navigator session not found");
    return null;
  }

  if (session.user_id !== userId) {
    emitNavigatorError(socket, "Not authorized");
    return null;
  }

  return session;
}

async function findCurrentDraft(sessionId) {
  const activeDraft = await NavigatorDraft.findOne({
    where: {
      session_id: sessionId,
      status: "active",
    },
    order: [["game_number", "DESC"]],
  });

  if (activeDraft) {
    return activeDraft;
  }

  return NavigatorDraft.findOne({
    where: { session_id: sessionId },
    order: [["game_number", "DESC"]],
  });
}

async function findSessionDraft(sessionId, draftId) {
  return NavigatorDraft.findOne({
    where: {
      id: draftId,
      session_id: sessionId,
    },
  });
}

async function listDraftEvents(draftId) {
  return NavigatorEvent.findAll({
    where: { navigator_draft_id: draftId },
    order: [
      ["createdAt", "ASC"],
      ["slot", "ASC"],
      ["id", "ASC"],
    ],
  });
}

async function findLatestSnapshot(draftId) {
  return NavigatorSnapshot.findOne({
    where: { navigator_draft_id: draftId },
    order: [["createdAt", "DESC"]],
  });
}

function toClientSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }

  if (snapshot.tree || snapshot.meta) {
    return snapshot;
  }

  return {
    id: snapshot.id,
    navigator_draft_id: snapshot.navigator_draft_id,
    after_event_id: snapshot.after_event_id,
    tree: snapshot.pruned_tree,
    scenarios: snapshot.scenarios,
    meta: snapshot.compute_meta,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
}

async function emitDraftUpdate(io, sessionId, payload) {
  io.to(getRoomName(sessionId)).emit("navigatorDraftUpdate", payload);
}

async function recomputeAndBroadcast(io, socket, session, draft, events, version) {
  void socket;
  try {
    const result = await computeForDraft(draft, session, events, version, io);
    const currentVersion = getCurrentVersion(session.id);
    if (result.version !== currentVersion) {
      console.log(
        `[nav] dropping stale engine result: session=${session.id} job_v=${result.version} current_v=${currentVersion}`,
      );
      return null;
    }
    await emitDraftUpdate(io, session.id, {
      draft,
      events,
      snapshot: result.snapshot,
    });
    return result.snapshot;
  } catch (error) {
    console.error("Navigator engine compute failed:", error);
    await emitDraftUpdate(io, session.id, {
      draft,
      events,
      snapshot: null,
    });
    return null;
  }
}

function setupNavigatorHandlers(io, socket, wrapSocketHandler) {
  const wrap = (eventName, handler) =>
    wrapSocketHandler(socket, eventName, handler, "navigator");

  wrap("navigatorJoin", async (data = {}) => {
    try {
      const { sessionId } = data;

      if (!sessionId) {
        emitNavigatorError(socket, "sessionId is required");
        return;
      }

      const session = await findOwnedSession(sessionId, socket);
      if (!session) {
        return;
      }

      const draft = await findCurrentDraft(sessionId);
      const events = draft ? await listDraftEvents(draft.id) : [];
      const snapshot = draft ? await findLatestSnapshot(draft.id) : null;

      socket.join(getRoomName(sessionId));
      socket.emit("navigatorJoinResponse", {
        success: true,
        session,
        draft,
        events,
        snapshot: toClientSnapshot(snapshot),
      });
    } catch (error) {
      console.error("Error in navigatorJoin:", error);
      emitNavigatorError(socket, "Failed to join navigator session");
    }
  });

  async function handleDraftInput(data, eventType) {
    const { sessionId, draftId, championId, slot } = data || {};

    if (!sessionId || !draftId || !championId || typeof slot !== "number") {
      emitNavigatorError(
        socket,
        "sessionId, draftId, championId, and numeric slot are required",
      );
      return;
    }

    const session = await findOwnedSession(sessionId, socket);
    if (!session) {
      return;
    }

    const draft = await findSessionDraft(sessionId, draftId);
    if (!draft) {
      emitNavigatorError(socket, "Navigator draft not found");
      return;
    }

    const currentTurn = TURN_SEQUENCE[slot];
    if (!currentTurn) {
      emitNavigatorError(socket, "Invalid draft slot");
      return;
    }

    if (currentTurn.type !== eventType) {
      emitNavigatorError(socket, `Slot ${slot} does not accept a ${eventType}`);
      return;
    }

    await NavigatorEvent.create({
      navigator_draft_id: draftId,
      event_type: eventType,
      slot,
      side: currentTurn.side,
      champion_id: championId,
      user_injected: false,
    });

    const events = await listDraftEvents(draft.id);

    if (events.length >= TOTAL_TURNS && draft.status !== "completed") {
      draft.status = "completed";
      await draft.save();
    }

    await emitDraftUpdate(io, sessionId, {
      draft,
      events,
    });

    const version = bumpVersion(sessionId);
    await recomputeAndBroadcast(io, socket, session, draft, events, version);
  }

  wrap("navigatorPick", async (data = {}) => {
    try {
      await handleDraftInput(data, "pick");
    } catch (error) {
      console.error("Error in navigatorPick:", error);
      emitNavigatorError(socket, "Failed to record pick");
    }
  });

  wrap("navigatorBan", async (data = {}) => {
    try {
      await handleDraftInput(data, "ban");
    } catch (error) {
      console.error("Error in navigatorBan:", error);
      emitNavigatorError(socket, "Failed to record ban");
    }
  });

  wrap("navigatorSwapChampion", async (data = {}) => {
    try {
      const { sessionId, draftId, pathToParent, newChampionId, oldChampionId } = data;

      if (!sessionId || !draftId || !Array.isArray(pathToParent) || !newChampionId) {
        emitNavigatorError(socket, "Invalid navigatorSwapChampion payload");
        return;
      }

      // TODO(engine): when the engine supports seeded re-search, pass the
      // (pathToParent, newChampionId, oldChampionId) as a seed hint.
      console.log("[nav] swap requested (stub)", {
        sessionId,
        draftId,
        pathToParent,
        newChampionId,
        oldChampionId,
      });
      emitNavigatorError(
        socket,
        "Swap champion is not yet implemented by the engine. Coming with the Rust engine rewrite."
      );
    } catch (error) {
      console.error("Error in navigatorSwapChampion:", error);
      emitNavigatorError(socket, "Swap champion failed");
    }
  });

  wrap("navigatorBranch", async (data = {}) => {
    try {
      const { sessionId, draftId, pathToParent, newChampionId } = data;

      if (!sessionId || !draftId || !Array.isArray(pathToParent) || !newChampionId) {
        emitNavigatorError(socket, "Invalid navigatorBranch payload");
        return;
      }

      // TODO(engine): additive branch — engine-side re-search adds a sibling
      // node with newChampionId under pathToParent. Not yet implemented.
      console.log("[nav] branch requested (stub)", {
        sessionId,
        draftId,
        pathToParent,
        newChampionId,
      });
      emitNavigatorError(
        socket,
        "Create branch is not yet implemented by the engine. Coming with the Rust engine rewrite."
      );
    } catch (error) {
      console.error("Error in navigatorBranch:", error);
      emitNavigatorError(socket, "Create branch failed");
    }
  });

  wrap("navigatorUndo", async (data = {}) => {
    try {
      const { sessionId, draftId } = data;

      if (!sessionId || !draftId) {
        emitNavigatorError(socket, "sessionId and draftId are required");
        return;
      }

      const session = await findOwnedSession(sessionId, socket);
      if (!session) {
        return;
      }

      const draft = await findSessionDraft(sessionId, draftId);
      if (!draft) {
        emitNavigatorError(socket, "Navigator draft not found");
        return;
      }

      const lastEvent = await NavigatorEvent.findOne({
        where: { navigator_draft_id: draftId },
        order: [
          ["createdAt", "DESC"],
          ["id", "DESC"],
        ],
      });

      if (!lastEvent) {
        emitNavigatorError(socket, "No navigator events to undo");
        return;
      }

      await lastEvent.destroy();

      const events = await listDraftEvents(draft.id);
      await emitDraftUpdate(io, sessionId, {
        draft,
        events,
      });

      const version = bumpVersion(sessionId);
      await recomputeAndBroadcast(io, socket, session, draft, events, version);
    } catch (error) {
      console.error("Error in navigatorUndo:", error);
      emitNavigatorError(socket, "Failed to undo navigator event");
    }
  });

  wrap("navigatorStartDraft", async (data = {}) => {
    try {
      const { sessionId } = data;

      if (!sessionId) {
        emitNavigatorError(socket, "sessionId is required");
        return;
      }

      const session = await findOwnedSession(sessionId, socket);
      if (!session) {
        return;
      }

      if (session.status === "setup") {
        session.status = "active";
        await session.save();
      }

      const draft = await findCurrentDraft(sessionId);
      const events = draft ? await listDraftEvents(draft.id) : [];
      const snapshot = draft ? await findLatestSnapshot(draft.id) : null;

      await emitDraftUpdate(io, sessionId, {
        session,
        draft,
        events,
        snapshot: toClientSnapshot(snapshot),
      });
    } catch (error) {
      console.error("Error in navigatorStartDraft:", error);
      emitNavigatorError(socket, "Failed to start navigator draft");
    }
  });

  wrap("navigatorNextGame", async (data = {}) => {
    try {
      const { sessionId, ourSideOverride } = data;

      if (!sessionId) {
        emitNavigatorError(socket, "sessionId is required");
        return;
      }

      const session = await findOwnedSession(sessionId, socket);
      if (!session) {
        return;
      }

      const currentDraft = await findCurrentDraft(sessionId);
      if (!currentDraft) {
        emitNavigatorError(socket, "No current draft for this session");
        return;
      }

      if (currentDraft.status !== "completed") {
        emitNavigatorError(socket, "Current game must be completed first");
        return;
      }

      const nextGameNumber = currentDraft.game_number + 1;
      if (nextGameNumber > session.series_length) {
        emitNavigatorError(socket, "Series already complete");
        return;
      }

      // Validate manual-mode override:
      //  - manual + override present => write override
      //  - manual + no override      => derive (defaults to session.our_side)
      //  - auto   + override present => ignore (auto is authoritative)
      //  - auto   + no override      => derive (alternates)
      const newDraftAttrs = {
        session_id: sessionId,
        game_number: nextGameNumber,
        status: "active",
        our_side_override: null,
      };

      if (session.side_swap_mode === "manual") {
        if (ourSideOverride === "blue" || ourSideOverride === "red") {
          newDraftAttrs.our_side_override = ourSideOverride;
        }
      }

      const newDraft = await NavigatorDraft.create(newDraftAttrs);

      const derivedSide = getOurSideForGame(session, newDraft);
      console.log(
        `[nav] Game ${nextGameNumber} started for session ${sessionId} on ${derivedSide}`,
      );

      await emitDraftUpdate(io, sessionId, {
        session,
        draft: newDraft,
        events: [],
        snapshot: null,
      });
    } catch (error) {
      console.error("Error in navigatorNextGame:", error);
      emitNavigatorError(socket, "Failed to create next navigator draft");
    }
  });
}

module.exports = { setupNavigatorHandlers };
