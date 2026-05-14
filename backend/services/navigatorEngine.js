const path = require("path");

const NavigatorSnapshot = require("../models/NavigatorSnapshot");
const { getCrossGameExclusions } = require("../utils/navigatorSeriesRestrictions");
const { Engine, CancelToken } = require("@draft-sim/engine-node");

const CHAMPION_META_PATH = path.resolve(
  __dirname,
  "../../data/compiled/champion-meta.json",
);
const MATCHUP_DATA_PATH = path.resolve(
  __dirname,
  "../../data/compiled/matchup-data.json",
);

const EXPECTED_PROTOCOL_MAJOR = 1;

// Phase 4 polish (2026-05-11): bumped from 2000ms → 5000ms so MCTS gets enough
// budget to populate depth-2 grandchildren beyond 1 visit. αβ self-regulates
// via cancellation on settled states. Anytime/streaming termination is Phase 7.
const LATENCY_BUDGET_MS = 5000;

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

// Default rev-4 phase weights, ported from packages/engine-proto/src/weights.ts.
//
// Pick2 coverage bumped from 0.6 → 1.5 to overcome high-WR mismatch dominance
// at 3-missing-role pair turns. Detail: the coverage_score gap between a
// 1-missing-role comp (≈0.398) and a 2-missing-role comp (≈0.158) is bounded
// to 0.24 by the geometric-mean formula. With weight 0.6, that's a 0.144
// signal — smaller than the per-pick win-rate sum gap when 2 high-WR singles
// out-tier 2 specialists by ≈0.10 WR each. Weight 1.5 puts the coverage
// signal at ≈0.36, which dominates realistic WR gaps.
const DEFAULT_PHASE_WEIGHTS = {
  blue: {
    ban1: { comp: 0.35, info: 0.65, coverage: 0.0 },
    pick1: { comp: 0.5, info: 0.5, coverage: 0.3 },
    ban2: { comp: 0.6, info: 0.4, coverage: 0.4 },
    pick2: { comp: 0.8, info: 0.2, coverage: 1.5 },
  },
  red: {
    ban1: { comp: 0.3, info: 0.7, coverage: 0.0 },
    pick1: { comp: 0.4, info: 0.6, coverage: 0.3 },
    ban2: { comp: 0.5, info: 0.5, coverage: 0.4 },
    pick2: { comp: 0.8, info: 0.2, coverage: 1.5 },
  },
};

// Engine.create is synchronous and parses JSON files at construction time.
// Eager initialization keeps the first compute() call cold-cache-free.
let engine = Engine.create({
  championMetaPath: CHAMPION_META_PATH,
  matchupDataPath: MATCHUP_DATA_PATH,
});

// Test-only seam: swap the engine with a mock so the MCTS session path can be
// unit-tested without spawning the native iterate loop. Production never
// invokes this — the real engine is constructed at module load.
function __setEngineForTests(mockEngine) {
  engine = mockEngine;
}

// Per-session active token for the αβ supersession path. When a new compute
// is dispatched for a session, the prior token (if any) is cancelled so the
// in-flight Rust compute aborts within ~50ms (Phase 8.3 gate).
const activeTokens = new Map();

// Per-session active MCTS session (Decision 9). Entry schema:
//   { sessionId, version, session (napi handle), promise, rootPathCache,
//     afterEventId, draftId, stopReason, pendingReroots, socketId }
const activeSessions = new Map();

function decodeEngineError(err) {
  try {
    return JSON.parse(err.message);
  } catch {
    return { code: "engine.internal", message: String(err && err.message), path: [] };
  }
}

function isRealDraftEvent(event) {
  return event && (event.event_type === "ban" || event.event_type === "pick");
}

function sortEvents(events) {
  return [...(Array.isArray(events) ? events : [])].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (aTime !== bTime) return aTime - bTime;
    if (typeof a.slot === "number" && typeof b.slot === "number" && a.slot !== b.slot) {
      return a.slot - b.slot;
    }
    if (a.id && b.id) return String(a.id).localeCompare(String(b.id));
    return 0;
  });
}

// Maps the JS-side pool shape (lowercase keys, "mid" instead of "middle") to
// the protocol's display map (uppercase keys, "MIDDLE"). Cross-game-excluded
// champions are filtered out of both display and search.
function toProtocolTeamPool(pool, excluded) {
  const isExcluded = (id) => excluded.has(id);
  const display = pool.display || {};
  const filterArr = (arr) => (Array.isArray(arr) ? arr.filter((id) => !isExcluded(id)) : []);
  return {
    display: {
      TOP: filterArr(display.top),
      JUNGLE: filterArr(display.jungle),
      MIDDLE: filterArr(display.mid),
      ADC: filterArr(display.adc),
      SUPPORT: filterArr(display.support),
    },
    search: filterArr(pool.search),
  };
}

const EMPTY_POOL = {
  display: { top: [], jungle: [], mid: [], adc: [], support: [] },
  search: [],
};

// v5 phase 4: dev-only experimental engine toggle. Production never sets
// algorithm; setting it requires both the env-var gate AND a per-request flag
// from the frontend. The env var lets us harden against accidental rollout
// while still letting dev/staging environments expose the toggle.
const MCTS_TOGGLE_ENABLED = process.env.NAV_ENGINE_TOGGLE_ENABLED === "1"
  || process.env.NAV_ENGINE_TOGGLE_ENABLED === "true";

function resolveAlgorithm(requestedAlgorithm) {
  if (!MCTS_TOGGLE_ENABLED) return undefined;
  if (requestedAlgorithm !== "mcts" && requestedAlgorithm !== "ab") return undefined;
  // Pass through "ab" too so the engine-node side can log dispatched algorithm
  // explicitly. Setting "ab" is equivalent to omitting the field per the
  // schema's optional-with-default semantics, but it keeps round-trip parity.
  return requestedAlgorithm;
}

async function buildEngineRequest(session, events, exclusions, forcedBranches = [], algorithm) {
  const orderedEvents = sortEvents(events);
  const realEvents = orderedEvents.filter(isRealDraftEvent);
  const bans = [];
  const picks = [];
  for (const event of realEvents) {
    const normalized = {
      championId: event.champion_id,
      side: event.side,
      slot: event.slot,
    };
    if (event.event_type === "ban") {
      bans.push(normalized);
    } else {
      picks.push(normalized);
    }
  }

  const turnIndex = realEvents.length;
  const currentTurn = TURN_SEQUENCE[turnIndex];
  if (!currentTurn) {
    throw new Error("Cannot compute navigator snapshot: draft is complete");
  }

  const excluded = new Set(exclusions || []);
  const blue = toProtocolTeamPool(session.blue_pool || EMPTY_POOL, excluded);
  const red = toProtocolTeamPool(session.red_pool || EMPTY_POOL, excluded);

  const request = {
    protocolVersion: "1.0.0",
    draftState: {
      format: "standard",
      bans,
      picks,
      currentPhase: currentTurn.phase,
      currentSlot: turnIndex,
      currentSide: currentTurn.side,
    },
    pools: {
      ourSide: session.our_side === "red" ? "red" : "blue",
      blue,
      red,
      crossGameExclusions: Array.from(excluded),
    },
    opponentModel: { type: "meta", weights: {} },
    playerModel: {
      championTiers: { core: [], playable: [], emergency: [] },
      weights: {},
    },
    config: {
      search: {
        branchWidth: 5,
        pairBranchWidth: 500,
        singlePairTopK: 32,
        maxDepth: 8,
        broadDepth: 8,
        extensionTurnThreshold: 8,
        latencyBudgetMs: LATENCY_BUDGET_MS,
      },
      weights: {
        phaseWeights: DEFAULT_PHASE_WEIGHTS,
        penalties: { outOfRole: 0.25, outOfPool: 0.75 },
        synergyMultiplier: 1.0,
        counterMultiplier: 1.0,
        flexRetentionWeight: 1.0,
        revealCostWeight: 1.0,
      },
      profile: "firstpick-default-v1",
      forcedBranches,
    },
  };

  const resolvedAlgorithm = resolveAlgorithm(algorithm);
  if (resolvedAlgorithm) {
    request.algorithm = resolvedAlgorithm;
  }

  return request;
}

function getLastEventId(events) {
  const ordered = sortEvents(events);
  return ordered.length > 0 ? ordered[ordered.length - 1].id : null;
}

// Pure transformation: returns the in-memory wire shape used by both the
// persistence path (finals) and the partial-emit path (T10). No DB write.
// id/createdAt/updatedAt are nulled out here and filled in by persistSnapshot.
function shapeSnapshot(navigatorDraft, lastEventId, response) {
  return {
    id: null,
    navigator_draft_id: navigatorDraft.id,
    after_event_id: lastEventId,
    tree: response.tree,
    scenarios: response.scenarios,
    meta: response.meta,
    createdAt: null,
    updatedAt: null,
  };
}

// Persists a shaped snapshot via the NavigatorSnapshot model and merges the
// row's id/createdAt/updatedAt into the returned wire shape.
async function persistSnapshot(shaped) {
  const row = await NavigatorSnapshot.create({
    navigator_draft_id: shaped.navigator_draft_id,
    after_event_id: shaped.after_event_id,
    pruned_tree: shaped.tree,
    scenarios: shaped.scenarios,
    compute_meta: shaped.meta,
  });
  return {
    ...shaped,
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Composition kept for existing callers (computeForDraft). T10's partial-emit
// path will use shapeSnapshot directly without persisting.
async function storeSnapshot(navigatorDraft, lastEventId, response) {
  return persistSnapshot(shapeSnapshot(navigatorDraft, lastEventId, response));
}

function assertProtocolMajor(version) {
  const major = parseInt(String(version || "0").split(".")[0], 10);
  if (!Number.isFinite(major) || major !== EXPECTED_PROTOCOL_MAJOR) {
    throw new Error(
      `engine/backend protocol mismatch: engine returned "${version}", backend expects "${EXPECTED_PROTOCOL_MAJOR}.x"`,
    );
  }
}

// Cancel any prior in-flight compute for this session so the Rust engine
// aborts (≤50ms via Phase 8.3 gate). The new compute then dispatches.
// Handles both αβ (activeTokens) and MCTS (activeSessions) paths.
async function supersedePriorCompute(sessionId, reason = "supersede") {
  const priorToken = activeTokens.get(sessionId);
  if (priorToken && priorToken.token && !priorToken.token.isCancelled()) {
    priorToken.token.cancel();
  }
  const priorSession = activeSessions.get(sessionId);
  if (priorSession) {
    priorSession.stopReason = reason;
    priorSession.session.stop();
    if (priorSession.promise) {
      try { await priorSession.promise; } catch { /* prior handles its own */ }
    }
  }
}

async function computeForDraft(navigatorDraft, session, events, version, io, options = {}) {
  if (!navigatorDraft || !navigatorDraft.id) {
    throw new Error("navigatorDraft.id is required");
  }
  if (!session) {
    throw new Error("session is required");
  }
  if (typeof version !== "number") {
    throw new Error("version is required");
  }
  const algorithm = resolveAlgorithm(options.algorithm);
  if (algorithm === "mcts") {
    return startNavigatorSession(navigatorDraft, session, events, version, io, options);
  }
  return computeForDraftAB(navigatorDraft, session, events, version, io, options);
}

async function computeForDraftAB(navigatorDraft, session, events, version, io, options = {}) {
  void io;
  const exclusions = await getCrossGameExclusions(session, navigatorDraft);
  const request = await buildEngineRequest(
    session,
    events,
    exclusions,
    options.forcedBranches || [],
    options.algorithm,
  );
  const lastEventId = getLastEventId(events);

  await supersedePriorCompute(session.id);
  const token = new CancelToken();
  activeTokens.set(session.id, { version, token });

  let responseJson;
  try {
    responseJson = await engine.compute(JSON.stringify(request), token);
  } catch (err) {
    const decoded = decodeEngineError(err);
    if (decoded.code === "engine.cancelled") {
      // Supersession-driven cancel — swallow silently. The newer compute will
      // produce the snapshot. No DB write.
      return { version, snapshot: null, cancelled: true };
    }
    // engine.timeout / engine.invalid_input / engine.internal: surface to caller.
    const error = new Error(decoded.message || "engine error");
    error.code = decoded.code || "engine.internal";
    error.path = decoded.path || [];
    throw error;
  } finally {
    // Clean up the active-token slot only if we still own it (avoid clobbering
    // a newer compute's token that already replaced ours).
    const current = activeTokens.get(session.id);
    if (current && current.version === version) {
      activeTokens.delete(session.id);
    }
  }

  const response = JSON.parse(responseJson);
  assertProtocolMajor(response.protocolVersion);

  // Snapshot policy (spec § Node ↔ Rust Boundary "Timeout partial snapshot
  // persistence" + "No snapshot writes for cancelled jobs"):
  //   meta.cancelled === true  → swallow (no broadcast, no persist)
  //   otherwise                → broadcast + persist (including timeout-with-partial)
  if (response.meta && response.meta.cancelled === true) {
    return { version, snapshot: null, partial: response };
  }

  const snapshot = await storeSnapshot(navigatorDraft, lastEventId, response);
  return { version, snapshot };
}

// MCTS session path (Decision 9). Owns a NavigatorSession napi handle for the
// session's lifetime, streams partials via onPartial, persists only on
// user-stop. Closure-captures `entry` so the continuation reads stopReason
// off the local var (never re-reads the map, which may have been replaced).
async function startNavigatorSession(navigatorDraft, sess, events, version, io, options = {}) {
  const exclusions = await getCrossGameExclusions(sess, navigatorDraft);
  const request = await buildEngineRequest(
    sess,
    events,
    exclusions,
    options.forcedBranches || [],
    options.algorithm,
  );
  const afterEventId = getLastEventId(events);

  await supersedePriorCompute(sess.id, "supersede");

  const napiSession = engine.createNavigatorSession(JSON.stringify(request));
  const entry = {
    sessionId: sess.id,
    version,
    session: napiSession,
    promise: null,
    rootPathCache: [],
    afterEventId,
    draftId: navigatorDraft.id,
    stopReason: null,
    pendingReroots: new Map(),
    socketId: options.socketId || null,
  };
  activeSessions.set(sess.id, entry);

  const onPartial = (jsonStr) => handlePartialOrError(entry, io, jsonStr);

  // Hoist start() into try so a synchronous throw (e.g. TSF creation failure)
  // still hits the identity-checked cleanup in finally (Codex R3-#1).
  try {
    const promise = napiSession.start(onPartial);
    entry.promise = promise;
    const finalJson = await promise;
    const reason = entry.stopReason; // closure-captured, not map-read
    if (reason === "supersede" || reason === "disconnect") {
      return { version, snapshot: null, supersededOrDropped: true };
    }
    const response = JSON.parse(finalJson);
    assertProtocolMajor(response.protocolVersion);
    const shaped = shapeSnapshot(navigatorDraft, entry.afterEventId, response);
    const persisted = await persistSnapshot(shaped);
    io.to(`navigator:${sess.id}`).emit("navigatorSnapshot", {
      session: sess,
      draft: navigatorDraft,
      events,
      snapshot: persisted,
    });
    return { version, snapshot: persisted };
  } finally {
    if (activeSessions.get(sess.id) === entry) {
      activeSessions.delete(sess.id);
    }
  }
}

// Identity-checked routing of TSF emits from the iterate loop. Drops late
// partials/errors from a superseded session (Codex R2-#2). rootPath comes
// from response.meta.rootPath (authoritative per Decision 7), NOT from the
// backend's rootPathCache.
function handlePartialOrError(entry, io, jsonStr) {
  if (activeSessions.get(entry.sessionId) !== entry) return;
  if (entry.stopReason !== null) return;

  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return; }

  if (parsed.rerootError !== undefined) {
    io.to(`navigator:${entry.sessionId}`).emit("navigatorRerootError", {
      sessionId: entry.sessionId,
      draftId: entry.draftId,
      rerootId: parsed.rerootId,
      attemptedPath: parsed.attemptedPath,
      error: parsed.rerootError,
    });
    return;
  }

  const shaped = shapeSnapshot({ id: entry.draftId }, entry.afterEventId, parsed);
  shaped.id = "partial";
  io.to(`navigator:${entry.sessionId}`).emit("navigatorPartialSnapshot", {
    sessionId: entry.sessionId,
    draftId: entry.draftId,
    version: entry.version,
    afterEventId: entry.afterEventId,
    snapshot: shaped,
  });

  if (Array.isArray(parsed.meta?.rootPath)) {
    entry.rootPathCache = parsed.meta.rootPath;
  }
}

// Set stopReason BEFORE calling stop() so the resolving promise's
// closure-captured reason is correct (Decision 9 sequencing).
async function stopNavigatorSession(sessionId, reason = "user") {
  const entry = activeSessions.get(sessionId);
  if (!entry || !entry.session.isActive()) return { ok: false };
  entry.stopReason = reason;
  entry.session.stop();
  return { ok: true };
}

async function rerootNavigatorSession(sessionId, rerootId, rerootStep) {
  const entry = activeSessions.get(sessionId);
  if (!entry || !entry.session.isActive()) {
    return { ok: false, reason: "no-active-session" };
  }
  entry.session.reroot(BigInt(rerootId), JSON.stringify(rerootStep));
  return { ok: true };
}

function getEngineStatus() {
  return { activeSessions: activeTokens.size + activeSessions.size };
}

async function shutdownEngine() {
  for (const { token } of activeTokens.values()) {
    if (token && !token.isCancelled()) token.cancel();
  }
  activeTokens.clear();
  for (const entry of activeSessions.values()) {
    entry.stopReason = "supersede";
    entry.session.stop();
  }
}

module.exports = {
  computeForDraft,
  getEngineStatus,
  shutdownEngine,
  shapeSnapshot,
  persistSnapshot,
  startNavigatorSession,
  stopNavigatorSession,
  rerootNavigatorSession,
  isMctsToggleEnabled: () => MCTS_TOGGLE_ENABLED,
  __setEngineForTests,
  __activeSessionsForTests: activeSessions,
  __handlePartialOrErrorForTests: handlePartialOrError,
};
