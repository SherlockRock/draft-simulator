const NavigatorSession = require("../models/NavigatorSession");
const NavigatorDraft = require("../models/NavigatorDraft");
const NavigatorEvent = require("../models/NavigatorEvent");
const NavigatorSnapshot = require("../models/NavigatorSnapshot");
const navigatorEngine = require("../services/navigatorEngine");
const { isMctsToggleEnabled } = navigatorEngine;
// Note: computeForDraft is accessed via navigatorEngine.* (not destructured)
// so test-time spies on navigatorEngine.computeForDraft are honoured. Other
// engine functions (pauseNavigatorSession, resumeNavigatorSession, etc.) are
// referenced the same way for the same reason.
const { getOurSideForGame } = require("../utils/navigatorSide");
const { getTurn, TOTAL_TURNS } = require("../utils/navigatorTurns");

// Per-session engine job version. Bumped on every pick/ban/undo. Results whose
// job version is behind the session's current version are dropped.
const sessionVersions = new Map();

// v5 phase 4: per-session algorithm preference. Set via `navigatorSetAlgorithm`
// when the dev toggle is enabled; honored on every subsequent recompute. Not
// persisted (in-memory by design — toggle is dev-only and survival across
// restarts is not a goal). Defaults to undefined (= αβ).
const sessionAlgorithms = new Map();

function getSessionAlgorithm(sessionId) {
  return sessionAlgorithms.get(sessionId);
}

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
//   skipDraft       — when true, skip the draft lookup entirely; draft: null, events: null.
//                     Use for session-only handlers (e.g. navigatorStopCompute).
async function loadAuthorizedContext(socket, data, options = {}) {
  const { requireDraftId = false, fetchEvents = true, skipDraft = false } = options;
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

  // Session-only handlers (like navigatorStopCompute) don't need a draft lookup.
  if (skipDraft) {
    return { session, draft: null, events: null };
  }

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

// Warm-restart helper shared by navigatorPick and navigatorBan. Caller has
// already verified `entry.projectedChildren.has(key)` for the move's key and
// has the post-move event list (for afterEventId) and bumped version on hand.
//
// Waits for any in-flight pause-persist (so applyPick doesn't race a snapshot
// write referencing the pre-move root), then attempts napi applyPick. On
// success, advances entry.afterEventId + entry.version so future partials and
// pause-finalize snapshots carry the post-move identifiers — otherwise a Stop
// after a warm pick persists a snapshot with a stale after_event_id and the
// frontend's hasPausedSession freshness gate trips.
//
// Returns true if the warm path succeeded (caller should return without cold
// restart); false if applyPick failed with notProjected/sessionEnded or threw
// unexpectedly (caller should fall through to cold recompute).
async function tryWarmApplyPick(entry, championIds, { afterEventId, version }) {
  if (entry.pausePersistPromise) {
    try { await entry.pausePersistPromise; } catch (_) {}
  }
  try {
    await entry.session.applyPick(championIds);
  } catch (e) {
    const msg = String(e?.message || "");
    if (!msg.includes("applyPick.notProjected") && !msg.includes("applyPick.sessionEnded")) {
      console.error("[nav] applyPick warm path threw:", e);
    }
    return false;
  }
  entry.afterEventId = afterEventId;
  entry.version = version;
  if (entry.lastPersistedPauseSnapshotId) {
    const stale = entry.lastPersistedPauseSnapshotId;
    entry.lastPersistedPauseSnapshotId = null;
    try {
      await NavigatorSnapshot.destroy({ where: { id: stale } });
    } catch (delErr) {
      console.error("[nav] failed to delete stale paused snapshot after warm applyPick:", delErr);
    }
  }
  return true;
}

async function recomputeAndBroadcast(io, socket, session, draft, events, version, options = {}) {
  try {
    // Inject the session's current dev-toggled algorithm preference unless an
    // explicit override was passed (forced-branch dispatchers don't override;
    // they go through the same algorithm choice as picks/bans/undo).
    // socketId rides along on every compute so the MCTS session entry can be
    // matched against the disconnecting socket in the cleanup handler below
    // (T12.5).
    const mergedOptions = {
      ...(options.algorithm !== undefined
        ? options
        : { ...options, algorithm: getSessionAlgorithm(session.id) }),
      socketId: socket.id,
    };
    const result = await navigatorEngine.computeForDraft(draft, session, events, version, io, mergedOptions);

    // Cancellation-driven swallow (engine.cancelled or meta.cancelled === true).
    // Newer compute will broadcast its own snapshot — drop silently.
    if (result.cancelled || (!result.snapshot && result.partial)) {
      return null;
    }

    // v4 R3-3: MCTS session is in-flight (synchronous startNavigatorSession
    // return). The session emits its own partials and eventually a
    // pause-on-pause navigatorDraftUpdate. Don't emit snapshot:null which
    // would erase the frontend's prior tree until the first partial.
    if (result.sessionStarted && !result.snapshot) {
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

  socket.on("disconnect", () => {
    navigatorEngine.forEachActiveSession((entry) => {
      if (entry.socketId !== socket.id) return;
      // Each session's disconnect runs in its own async IIFE so multiple
      // sessions can be torn down in parallel.
      (async () => {
        try {
          // v4 R3 B1: set stopReason BEFORE pause. pauseNavigatorSession's
          // pre-await guard allows 'disconnect' through (only 'supersede'
          // short-circuits). Persist-on-pause path runs inline; broadcasts
          // via io.to(...).emit so any other sockets in the room get the
          // snapshot.
          if (entry.stopReason === null) {
            entry.stopReason = "disconnect";
          }
          await navigatorEngine.pauseNavigatorSession(entry.sessionId, io);
        } catch (e) {
          console.error("[nav] disconnect-pause failed:", e);
        }
        // Teardown via cancel-flag. iterate_loop's Paused state recv()
        // unblocks on the queued Stop command.
        try {
          await navigatorEngine.endNavigatorSession(entry.sessionId, "disconnect");
        } catch (e) {
          console.error("[nav] disconnect-end failed:", e);
        }
      })();
    });
  });

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
        // v5 phase 4: dev-only signal so the frontend knows whether to render
        // the experimental engine toggle. Always false in production builds
        // (env var unset). When false, the frontend hides the toggle entirely.
        engineToggleEnabled: isMctsToggleEnabled(),
        currentAlgorithm: getSessionAlgorithm(sessionId) || "ab",
      });
    } catch (error) {
      console.error("Error in navigatorJoin:", error);
      emitNavigatorError(socket, "Failed to join navigator session");
    }
  });

  wrap("navigatorStopCompute", async (data = {}) => {
    const ctx = await loadAuthorizedContext(socket, data, { skipDraft: true });
    if (!ctx) return;
    const { session } = ctx;
    const { sessionId } = data;
    const result = await navigatorEngine.pauseNavigatorSession(sessionId, io);
    // Treat expected outcomes as silent — these aren't user-visible errors.
    if (!result.ok
        && result.reason !== "superseded-mid-pause"
        && result.reason !== "session-superseded"
        && result.reason !== "no-active-session") {
      emitNavigatorError(socket, `Stop failed: ${result.reason}`);
    }
  });

  // Phase 7c T11: user-Resume click. Calls resumeNavigatorSession which
  // dispatches to napi.resume() if a live entry exists, or falls back to
  // startNavigatorSession at current state otherwise.
  wrap("navigatorResumeCompute", async (data = {}) => {
    const ctx = await loadAuthorizedContext(socket, data);
    if (!ctx) return;
    const { session, draft, events } = ctx;
    if (!draft) {
      emitNavigatorError(socket, "No current draft");
      return;
    }
    const { sessionId } = data;
    const version = bumpVersion(sessionId);
    await navigatorEngine.resumeNavigatorSession(draft, session, events, version, io, {
      socketId: socket.id,
      algorithm: getSessionAlgorithm(sessionId),
    });
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

      // Warm-restart fast path: championIds match a top-level projected child
      // → reuse the in-flight Mcts via napi applyPick. Falls through to cold
      // restart on applyPick.notProjected (championIds slipped out of top-K
      // between partial emit and pick arrival) or applyPick.sessionEnded
      // (iterate thread exited between mirror-update and pick arrival).
      const entry = navigatorEngine.activeSessions.get(sessionId);
      const key = championIds.join("|");
      const afterEventId = navigatorEngine.getLastEventId(events);
      if (
        entry?.projectedChildren?.has(key) &&
        await tryWarmApplyPick(entry, championIds, { afterEventId, version })
      ) {
        return;
      }

      // Cold restart: full recompute + broadcast (existing path).
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

      // Warm-restart fast path: championId matches a top-level projected child
      // (Set key is the bare championId for single-id moves). Falls through to
      // cold restart on applyPick.notProjected / applyPick.sessionEnded.
      const entry = navigatorEngine.activeSessions.get(sessionId);
      const afterEventId = navigatorEngine.getLastEventId(events);
      if (
        entry?.projectedChildren?.has(championId) &&
        await tryWarmApplyPick(entry, [championId], { afterEventId, version })
      ) {
        return;
      }

      // Cold restart: full recompute + broadcast (existing path).
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

  wrap("navigatorSetAlgorithm", async (data = {}) => {
    try {
      const { algorithm } = data;

      if (!isMctsToggleEnabled()) {
        // Production: silently ignore. Dev gate prevents the UI from emitting
        // this event in production builds, but defense-in-depth: if it somehow
        // arrives, drop it without acknowledgement.
        return;
      }

      if (algorithm !== "ab" && algorithm !== "mcts") {
        emitNavigatorError(socket, "Invalid algorithm; expected \"ab\" or \"mcts\"");
        return;
      }

      const ctx = await loadAuthorizedContext(socket, data);
      if (!ctx) return;
      const { session, draft, events } = ctx;
      const { sessionId } = data;

      sessionAlgorithms.set(sessionId, algorithm);

      // Trigger a recompute on the current draft so the user sees the new
      // engine's output without having to click anything else. If there's no
      // active draft or no events yet, just acknowledge the preference.
      if (!draft) return;
      if (events.length === 0) return;
      const version = bumpVersion(sessionId);
      await recomputeAndBroadcast(io, socket, session, draft, events, version);
    } catch (error) {
      console.error("Error in navigatorSetAlgorithm:", error);
      emitNavigatorError(socket, "Failed to set algorithm");
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
