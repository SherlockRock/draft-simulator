const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const NavigatorSnapshot = require("../models/NavigatorSnapshot");

const ENGINE_INDEX_PATH = path.resolve(
  __dirname,
  "../../packages/engine-proto/dist/index.js"
);
const ENGINE_TURN_SEQUENCE_PATH = path.resolve(
  __dirname,
  "../../packages/engine-proto/dist/draft-state.js"
);
const CHAMPION_META_PATH = path.resolve(
  __dirname,
  "../../data/compiled/champion-meta.json"
);
const MATCHUP_DATA_PATH = path.resolve(
  __dirname,
  "../../data/compiled/matchup-data.json"
);

const FALLBACK_TURN_SEQUENCE = [
  { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "red", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "red", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "red", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
  { side: "blue", type: "pick", phase: "pick1", pairStart: false, pairEnd: false },
  { side: "red", type: "pick", phase: "pick1", pairStart: true, pairEnd: false },
  { side: "red", type: "pick", phase: "pick1", pairStart: false, pairEnd: true },
  { side: "blue", type: "pick", phase: "pick1", pairStart: true, pairEnd: false },
  { side: "blue", type: "pick", phase: "pick1", pairStart: false, pairEnd: true },
  { side: "red", type: "pick", phase: "pick1", pairStart: false, pairEnd: false },
  { side: "red", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  { side: "red", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  { side: "blue", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
  { side: "red", type: "pick", phase: "pick2", pairStart: false, pairEnd: false },
  { side: "blue", type: "pick", phase: "pick2", pairStart: true, pairEnd: false },
  { side: "blue", type: "pick", phase: "pick2", pairStart: false, pairEnd: true },
  { side: "red", type: "pick", phase: "pick2", pairStart: false, pairEnd: false },
];

let engine = null;
let engineModulePromise = null;
let turnSequencePromise = null;
let pending = null;
const queue = [];

const cachedMetaData = loadMetaData();

function loadJsonOnce(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadMetaData() {
  const championMeta = loadJsonOnce(CHAMPION_META_PATH);
  const matchupData = loadJsonOnce(MATCHUP_DATA_PATH);
  const champions = championMeta.champions || {};

  return {
    winRates: Object.values(champions).reduce((acc, champion) => {
      acc[champion.id] = champion.winRate;
      return acc;
    }, {}),
    synergies: Array.isArray(matchupData.synergyRules) ? matchupData.synergyRules : [],
    counters: matchupData.counters || {},
  };
}

async function loadEngineModule() {
  if (!engineModulePromise) {
    engineModulePromise = import(pathToFileURL(ENGINE_INDEX_PATH).href);
  }

  return engineModulePromise;
}

async function loadTurnSequence() {
  if (!turnSequencePromise) {
    turnSequencePromise = import(pathToFileURL(ENGINE_TURN_SEQUENCE_PATH).href)
      .then((module) => module.TURN_SEQUENCE || FALLBACK_TURN_SEQUENCE)
      .catch(() => FALLBACK_TURN_SEQUENCE);
  }

  return turnSequencePromise;
}

async function getEngine() {
  if (engine) {
    return engine;
  }

  const engineModule = await loadEngineModule();
  if (typeof engineModule.createEngine !== "function") {
    throw new Error("engine-proto createEngine() export is unavailable");
  }

  engine = engineModule.createEngine();
  return engine;
}

function isRealDraftEvent(event) {
  return event && (event.event_type === "ban" || event.event_type === "pick");
}

function sortEvents(events) {
  return [...(Array.isArray(events) ? events : [])].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;

    if (aTime !== bTime) {
      return aTime - bTime;
    }

    if (typeof a.slot === "number" && typeof b.slot === "number" && a.slot !== b.slot) {
      return a.slot - b.slot;
    }

    if (a.id && b.id) {
      return String(a.id).localeCompare(String(b.id));
    }

    return 0;
  });
}

async function buildEngineRequest(session, events) {
  const turnSequence = await loadTurnSequence();
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
  const currentTurn = turnSequence[turnIndex];

  if (!currentTurn) {
    throw new Error("Cannot compute navigator snapshot: draft is complete");
  }

  const EMPTY_TEAM_POOL = {
    display: { top: [], jungle: [], mid: [], adc: [], support: [] },
    search: [],
  };
  const bluePool = session.blue_pool || EMPTY_TEAM_POOL;
  const redPool = session.red_pool || EMPTY_TEAM_POOL;
  const flattenDisplay = (d) => [
    ...(d.top || []),
    ...(d.jungle || []),
    ...(d.mid || []),
    ...(d.adc || []),
    ...(d.support || []),
  ];
  const ourPool = session.our_side === "red" ? redPool : bluePool;

  return {
    draftState: {
      format: "standard",
      bans,
      picks,
      currentPhase: currentTurn.phase,
      currentSlot: turnIndex,
      currentSide: currentTurn.side,
    },
    searchPool: Array.from(
      new Set([...(bluePool.search || []), ...(redPool.search || [])])
    ),
    opponentModel: {
      type: "meta",
      weights: {},
      conditionalAdjustments: {},
    },
    playerModel: {
      championTiers: {
        core: flattenDisplay(ourPool.display || {}),
        playable: [],
        emergency: [],
      },
      weights: {},
    },
    metaData: cachedMetaData,
    config: {
      branchWidth: 5,
      maxDepth: 8,
      broadDepth: 8,
      extensionTurnThreshold: 8,
      latencyBudgetMs: 2000,
      forcedMoves: [],
    },
  };
}

function getLastEventId(events) {
  const orderedEvents = sortEvents(events);
  return orderedEvents.length > 0 ? orderedEvents[orderedEvents.length - 1].id : null;
}

async function storeSnapshot(navigatorDraft, lastEventId, output) {
  const snapshot = await NavigatorSnapshot.create({
    navigator_draft_id: navigatorDraft.id,
    after_event_id: lastEventId,
    pruned_tree: output.tree,
    scenarios: output.scenarios,
    compute_meta: output.meta,
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

async function processQueue() {
  if (pending || queue.length === 0) {
    return pending;
  }

  const next = queue.shift();

  pending = (async () => {
    try {
      const activeEngine = await getEngine();
      const output = await activeEngine.compute(next.request);
      const snapshot = await storeSnapshot(next.navigatorDraft, next.lastEventId, output);
      next.resolve(snapshot);
    } catch (error) {
      next.reject(error);
    } finally {
      pending = null;
      processQueue().catch((queueError) => {
        console.error("Navigator engine queue failed", queueError);
      });
    }
  })();

  return pending;
}

async function enqueue(request, navigatorDraft, lastEventId) {
  return new Promise((resolve, reject) => {
    queue.push({ request, navigatorDraft, lastEventId, resolve, reject });
    processQueue().catch((error) => {
      console.error("Navigator engine queue failed to start", error);
    });
  });
}

async function computeForDraft(navigatorDraft, session, events, io) {
  void io;

  if (!navigatorDraft || !navigatorDraft.id) {
    throw new Error("navigatorDraft.id is required");
  }

  if (!session) {
    throw new Error("session is required");
  }

  const request = await buildEngineRequest(session, events);
  const lastEventId = getLastEventId(events);
  return enqueue(request, navigatorDraft, lastEventId);
}

function getEngineStatus() {
  return {
    busy: pending !== null,
    queueLength: queue.length,
  };
}

async function shutdownEngine() {
  const activePending = pending;

  while (queue.length > 0) {
    const queued = queue.shift();
    queued.reject(new Error("Navigator engine shutdown"));
  }

  if (engine) {
    engine.terminate();
    engine = null;
  }

  try {
    await activePending;
  } catch (error) {
    if (error && error.message !== "Engine terminated") {
      throw error;
    }
  } finally {
    pending = null;
  }
}

module.exports = {
  computeForDraft,
  getEngineStatus,
  shutdownEngine,
};
