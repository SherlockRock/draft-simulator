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
const DEFAULT_PHASE_WEIGHTS = {
  blue: {
    ban1: { comp: 0.35, info: 0.65, coverage: 0.0 },
    pick1: { comp: 0.5, info: 0.5, coverage: 0.3 },
    ban2: { comp: 0.6, info: 0.4, coverage: 0.4 },
    pick2: { comp: 0.8, info: 0.2, coverage: 0.6 },
  },
  red: {
    ban1: { comp: 0.3, info: 0.7, coverage: 0.0 },
    pick1: { comp: 0.4, info: 0.6, coverage: 0.3 },
    ban2: { comp: 0.5, info: 0.5, coverage: 0.4 },
    pick2: { comp: 0.8, info: 0.2, coverage: 0.6 },
  },
};

// Engine.create is synchronous and parses JSON files at construction time.
// Eager initialization keeps the first compute() call cold-cache-free.
const engine = Engine.create({
  championMetaPath: CHAMPION_META_PATH,
  matchupDataPath: MATCHUP_DATA_PATH,
});

// Per-session active token, used for supersession cancellation. When a new
// compute is dispatched for a session, the prior token (if any) is cancelled
// so the in-flight Rust compute aborts within ~50ms (the cancellation latency
// gate from Phase 8.3).
const activeTokens = new Map();

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

async function buildEngineRequest(session, events, exclusions, forcedBranches = []) {
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

  return {
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
        latencyBudgetMs: 2000,
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
}

function getLastEventId(events) {
  const ordered = sortEvents(events);
  return ordered.length > 0 ? ordered[ordered.length - 1].id : null;
}

async function storeSnapshot(navigatorDraft, lastEventId, response) {
  const snapshot = await NavigatorSnapshot.create({
    navigator_draft_id: navigatorDraft.id,
    after_event_id: lastEventId,
    pruned_tree: response.tree,
    scenarios: response.scenarios,
    compute_meta: response.meta,
  });
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
function supersedePriorCompute(sessionId) {
  const prior = activeTokens.get(sessionId);
  if (prior && prior.token && !prior.token.isCancelled()) {
    prior.token.cancel();
  }
}

async function computeForDraft(navigatorDraft, session, events, version, io, options = {}) {
  void io;
  if (!navigatorDraft || !navigatorDraft.id) {
    throw new Error("navigatorDraft.id is required");
  }
  if (!session) {
    throw new Error("session is required");
  }
  if (typeof version !== "number") {
    throw new Error("version is required");
  }

  const exclusions = await getCrossGameExclusions(session, navigatorDraft);
  const request = await buildEngineRequest(
    session,
    events,
    exclusions,
    options.forcedBranches || [],
  );
  const lastEventId = getLastEventId(events);

  supersedePriorCompute(session.id);
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

function getEngineStatus() {
  return { activeSessions: activeTokens.size };
}

async function shutdownEngine() {
  for (const { token } of activeTokens.values()) {
    if (token && !token.isCancelled()) token.cancel();
  }
  activeTokens.clear();
}

module.exports = {
  computeForDraft,
  getEngineStatus,
  shutdownEngine,
};
