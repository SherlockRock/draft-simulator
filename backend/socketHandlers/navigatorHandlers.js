const NavigatorSession = require("../models/NavigatorSession");
const NavigatorDraft = require("../models/NavigatorDraft");
const NavigatorEvent = require("../models/NavigatorEvent");
const NavigatorSnapshot = require("../models/NavigatorSnapshot");
const navigatorEngine = require("../services/navigatorEngine");
// Note: computeForDraft is accessed via navigatorEngine.* (not destructured)
// so test-time spies on navigatorEngine.computeForDraft are honoured.
const { getOurSideForGame } = require("../utils/navigatorSide");
const { getTurn, TOTAL_TURNS } = require("../utils/navigatorTurns");

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

// Consolidates the auth + draft-lookup + events-fetch preamble that most
// navigator socket handlers open-code. Returns null and emits a navigatorError
// to the socket on any failure step; otherwise returns { session, draft, events }.
//
// Options:
//   requireDraftId  — when true, look up the draft by data.draftId (must match session_id).
//                     when false (default), look up the current draft via findCurrentDraft.
//   fetchEvents     — when true (default), listDraftEvents for the resolved draft (or [] if no draft).
//                     when false, events: null.
async function loadAuthorizedContext(socket, data, options = {}) {
  const { requireDraftId = false, fetchEvents = true } = options;
  const { sessionId, draftId } = data || {};

  if (!sessionId) {
    emitNavigatorError(socket, "sessionId is required");
    return null;
  }
  if (requireDraftId && !draftId) {
    emitNavigatorError(socket, "draftId is required");
    return null;
  }

  const session = await findOwnedSession(sessionId, socket);
  if (!session) return null;

  let draft;
  if (requireDraftId) {
    draft = await findSessionDraft(sessionId, draftId);
    if (!draft) {
      emitNavigatorError(socket, "Navigator draft not found");
      return null;
    }
  } else {
    draft = await findCurrentDraft(sessionId);
  }

  let events;
  if (!fetchEvents) {
    events = null;
  } else if (draft) {
    events = await listDraftEvents(draft.id);
  } else {
    events = [];
  }

  return { session, draft, events };
}

async function findLatestSnapshot(draftId) {
  return NavigatorSnapshot.findOne({
    where: { navigator_draft_id: draftId },
    order: [["createdAt", "DESC"]],
  });
}

async function listCompletedGames(sessionId, currentDraftId) {
  const drafts = await NavigatorDraft.findAll({
    where: { session_id: sessionId, status: "completed" },
    order: [["game_number", "ASC"]],
  });

  const result = [];
  for (const draft of drafts) {
    if (draft.id === currentDraftId) continue;
    const events = await listDraftEvents(draft.id);
    const snapshot = await findLatestSnapshot(draft.id);
    result.push({
      draft,
      events,
      snapshot: toClientSnapshot(snapshot),
    });
  }
  return result;
}

// Normalizes navigator snapshots to wire shape for socket emission.
// Accepts two input shapes:
//   1. Sequelize DB row (has `pruned_tree`/`compute_meta` columns) — converts to wire shape.
//   2. Already wire-shaped object (has `tree`/`meta` plus a `source` field) — passes through.
// The polymorphism is deliberate: `findLatestSnapshot` returns DB rows while
// `storeSnapshot`/`persistSnapshot` produce wire shape directly.
function toClientSnapshot(snapshot) {
  if (!snapshot) {
    return null;
  }

  if (snapshot.source) {
    return snapshot;
  }

  return {
    source: "persisted",
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

async function recomputeAndBroadcast(io, socket, session, draft, events, version, options = {}) {
  try {
    const mergedOptions = { ...options, socketId: socket.id };
    const result = await navigatorEngine.computeForDraft(draft, session, events, version, io, mergedOptions);

    // Cancellation-driven swallow (engine.cancelled or meta.cancelled === true).
    // Newer compute will broadcast its own snapshot — drop silently.
    if (result.cancelled || (!result.snapshot && result.partial)) {
      return null;
    }

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
    if (error && error.code === "engine.invalid_input") {
      console.warn(
        `[nav] engine.invalid_input session=${session.id} draft=${draft.id} path=${JSON.stringify(error.path || [])}`,
      );
      emitNavigatorError(socket, "Engine rejected request: invalid input");
      return null;
    }
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
      const ctx = await loadAuthorizedContext(socket, data);
      if (!ctx) return;
      const { session, draft, events } = ctx;
      const { sessionId } = data;
      const snapshot = draft ? await findLatestSnapshot(draft.id) : null;
      const completedGames = await listCompletedGames(
        sessionId,
        draft ? draft.id : null,
      );

      socket.join(getRoomName(sessionId));
      socket.emit("navigatorJoinResponse", {
        success: true,
        session,
        draft,
        events,
        snapshot: toClientSnapshot(snapshot),
        completedGames,
      });
    } catch (error) {
      console.error("Error in navigatorJoin:", error);
      emitNavigatorError(socket, "Failed to join navigator session");
    }
  });

  wrap("navigatorPick", async (data = {}) => {
    try {
      const { championIds, firstSlot } = data;
      if (
        !Array.isArray(championIds) ||
        championIds.length < 1 ||
        championIds.length > 2 ||
        !championIds.every((c) => typeof c === "string" && c.length > 0) ||
        typeof firstSlot !== "number" ||
        firstSlot < 0
      ) {
        emitNavigatorError(
          socket,
          "championIds (1 or 2 strings) and numeric firstSlot are required",
        );
        return;
      }

      const ctx = await loadAuthorizedContext(socket, data, {
        requireDraftId: true,
        fetchEvents: false,
      });
      if (!ctx) return;
      const { session, draft } = ctx;
      const { sessionId, draftId } = data;

      // Validate each slot is a pick turn.
      for (let i = 0; i < championIds.length; i++) {
        const slot = firstSlot + i;
        const turn = getTurn(slot);
        if (!turn) {
          emitNavigatorError(socket, `Invalid draft slot ${slot}`);
          return;
        }
        if (turn.type !== "pick") {
          emitNavigatorError(socket, `Slot ${slot} does not accept a pick`);
          return;
        }
      }

      // Persist 1 or 2 NavigatorEvent rows for this turn.
      for (let i = 0; i < championIds.length; i++) {
        const slot = firstSlot + i;
        const turn = getTurn(slot);
        await NavigatorEvent.create({
          navigator_draft_id: draftId,
          event_type: "pick",
          slot,
          side: turn.side,
          champion_id: championIds[i],
          user_injected: false,
        });
      }

      const events = await listDraftEvents(draft.id);

      if (events.length >= TOTAL_TURNS && draft.status !== "completed") {
        draft.status = "completed";
        await draft.save();
      }

      await emitDraftUpdate(io, sessionId, { draft, events });

      const version = bumpVersion(sessionId);

      await recomputeAndBroadcast(io, socket, session, draft, events, version);
    } catch (error) {
      console.error("Error in navigatorPick:", error);
      emitNavigatorError(socket, "Failed to record pick");
    }
  });

  wrap("navigatorBan", async (data = {}) => {
    try {
      const { championId, slot } = data;
      if (
        typeof championId !== "string" ||
        championId.length === 0 ||
        typeof slot !== "number" ||
        slot < 0
      ) {
        emitNavigatorError(
          socket,
          "championId and numeric slot are required",
        );
        return;
      }

      const ctx = await loadAuthorizedContext(socket, data, {
        requireDraftId: true,
        fetchEvents: false,
      });
      if (!ctx) return;
      const { session, draft } = ctx;
      const { sessionId, draftId } = data;

      const turn = getTurn(slot);
      if (!turn) {
        emitNavigatorError(socket, "Invalid draft slot");
        return;
      }
      if (turn.type !== "ban") {
        emitNavigatorError(socket, `Slot ${slot} does not accept a ban`);
        return;
      }

      await NavigatorEvent.create({
        navigator_draft_id: draftId,
        event_type: "ban",
        slot,
        side: turn.side,
        champion_id: championId,
        user_injected: false,
      });

      const events = await listDraftEvents(draft.id);

      if (events.length >= TOTAL_TURNS && draft.status !== "completed") {
        draft.status = "completed";
        await draft.save();
      }

      await emitDraftUpdate(io, sessionId, { draft, events });

      const version = bumpVersion(sessionId);

      await recomputeAndBroadcast(io, socket, session, draft, events, version);
    } catch (error) {
      console.error("Error in navigatorBan:", error);
      emitNavigatorError(socket, "Failed to record ban");
    }
  });

  // Phase 11 frontend will switch to the content-addressed { path, targetSlot,
  // championId } payload. Until then, this handler validates the new shape
  // and rejects the legacy { pathToParent, newChampionId } shape with a clear
  // error — that's intentional: the legacy payload can't be served by the
  // Rust engine, so we'd rather fail loudly than silently misinterpret.
  function dispatchForcedBranch(eventName, mode) {
    return async (data = {}) => {
      try {
        const { path, targetSlot, championId } = data;

        if (
          !Array.isArray(path) ||
          typeof targetSlot !== "number" ||
          !championId
        ) {
          emitNavigatorError(
            socket,
            `Invalid ${eventName} payload (expected { path, targetSlot, championId })`,
          );
          return;
        }

        const ctx = await loadAuthorizedContext(socket, data, {
          requireDraftId: true,
        });
        if (!ctx) return;
        const { session, draft, events } = ctx;
        const { sessionId } = data;

        // Append a single forcedBranches entry for this dispatch. The engine
        // produces a full tree with the forced node marked userInjected: true.
        const forcedBranches = [{ path, targetSlot, championId, mode }];
        const version = bumpVersion(sessionId);
        await recomputeAndBroadcast(io, socket, session, draft, events, version, {
          forcedBranches,
        });
      } catch (error) {
        console.error(`Error in ${eventName}:`, error);
        emitNavigatorError(socket, `${eventName} failed`);
      }
    };
  }

  wrap("navigatorSwapChampion", dispatchForcedBranch("navigatorSwapChampion", "sole"));
  wrap("navigatorBranch", dispatchForcedBranch("navigatorBranch", "include"));

  wrap("navigatorUndo", async (data = {}) => {
    try {
      const ctx = await loadAuthorizedContext(socket, data, {
        requireDraftId: true,
        fetchEvents: false,
      });
      if (!ctx) return;
      const { session, draft } = ctx;
      const { sessionId, draftId } = data;

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
      const ctx = await loadAuthorizedContext(socket, data);
      if (!ctx) return;
      const { session, draft, events } = ctx;

      if (session.status === "setup") {
        session.status = "active";
        await session.save();
      }
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
      const { ourSideOverride } = data;

      const ctx = await loadAuthorizedContext(socket, data, { fetchEvents: false });
      if (!ctx) return;
      const { session, draft: currentDraft } = ctx;
      const { sessionId } = data;

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

  wrap("navigatorUpdatePools", async (data = {}) => {
    try {
      const { sessionId, blue_pool, red_pool } = data;

      if (!sessionId) {
        emitNavigatorError(socket, "sessionId is required");
        return;
      }

      const session = await findOwnedSession(sessionId, socket);
      if (!session) {
        return;
      }

      // Reject pool edits while a draft is mid-game. Allowed between games
      // (current draft is completed OR empty).
      const currentDraft = await findCurrentDraft(sessionId);
      const midGame =
        currentDraft &&
        currentDraft.status === "active" &&
        (await NavigatorEvent.count({
          where: { navigator_draft_id: currentDraft.id },
        })) > 0;
      if (midGame) {
        emitNavigatorError(
          socket,
          "Cannot edit pools while a game is in progress",
        );
        return;
      }

      if (blue_pool) session.blue_pool = blue_pool;
      if (red_pool) session.red_pool = red_pool;
      await session.save();

      await emitDraftUpdate(io, sessionId, { session });
    } catch (error) {
      console.error("Error in navigatorUpdatePools:", error);
      emitNavigatorError(socket, "Failed to update pools");
    }
  });
}

module.exports = { setupNavigatorHandlers, toClientSnapshot, loadAuthorizedContext };
