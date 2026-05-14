import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

// Load the CJS service via Node's resolver so we can patch its module-local
// engine via the __setEngineForTests seam and spy on NavigatorSnapshot.create.
const require = createRequire(import.meta.url);
const NavigatorSnapshot = require("../../models/NavigatorSnapshot");
const navigatorEngineService = require("../../services/navigatorEngine");
const {
  startNavigatorSession,
  __setEngineForTests,
  __activeSessionsForTests,
  __handlePartialOrErrorForTests,
} = navigatorEngineService;

// Build a fresh mock napi session per test. start(onPartial) captures the
// callback and returns a controllable Promise so the test can inject partials
// and resolve with the final-snapshot JSON when ready.
function buildMockNapiSession() {
  const handle = {
    _onPartial: null,
    _resolve: null,
    _reject: null,
    _started: false,
    start: vi.fn().mockImplementation((onPartial) => {
      handle._onPartial = onPartial;
      handle._started = true;
      return new Promise((resolve, reject) => {
        handle._resolve = resolve;
        handle._reject = reject;
      });
    }),
    stop: vi.fn(),
    reroot: vi.fn(),
    isActive: vi.fn().mockReturnValue(true),
  };
  return handle;
}

function buildMockEngine(napiSession) {
  return {
    createNavigatorSession: vi.fn().mockReturnValue(napiSession),
    compute: vi.fn(),
  };
}

function buildIo() {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  return { to, emit, io: { to } };
}

// Minimal session/draft/events shapes — enough for buildEngineRequest's
// shape requirements. Pools are empty (search arrays empty); engine request
// builder accepts them.
function buildFixtures(overrides = {}) {
  const session = {
    id: "sess-1",
    our_side: "blue",
    draft_mode: "standard", // short-circuits getCrossGameExclusions to []
    blue_pool: { display: { top: [], jungle: [], mid: [], adc: [], support: [] }, search: [] },
    red_pool: { display: { top: [], jungle: [], mid: [], adc: [], support: [] }, search: [] },
    ...overrides.session,
  };
  const draft = { id: "draft-1", session_id: "sess-1", game_number: 1, ...overrides.draft };
  const events = overrides.events || [];
  return { session, draft, events };
}

// Yield enough microtasks for startNavigatorSession's awaits
// (getCrossGameExclusions → buildEngineRequest → supersedePriorCompute) to
// reach the synchronous activeSessions.set + napiSession.start() block.
async function flushAsyncSetup() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// shape of a final EngineResponse the napi handle would resolve with.
function makeEngineResponseJson(overrides = {}) {
  return JSON.stringify({
    protocolVersion: "1.0.0",
    tree: { championIds: [], children: [] },
    scenarios: [],
    meta: {
      nodesEvaluated: 100,
      computeTimeMs: 50,
      cancelled: false,
      rootPath: [],
      ...overrides.meta,
    },
    ...overrides,
  });
}

let mockNapiSession;
let mockEngine;
let createSpy;

beforeEach(() => {
  mockNapiSession = buildMockNapiSession();
  mockEngine = buildMockEngine(mockNapiSession);
  __setEngineForTests(mockEngine);
  createSpy = vi.spyOn(NavigatorSnapshot, "create").mockResolvedValue({
    id: "snap-1",
    createdAt: "2026-05-13T00:00:00Z",
    updatedAt: "2026-05-13T00:00:00Z",
  });
  __activeSessionsForTests.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  __activeSessionsForTests.clear();
});

describe("startNavigatorSession — partial emits", () => {
  it("emits navigatorPartialSnapshot to the session room (Decision 11 envelope shape)", async () => {
    const { session, draft, events } = buildFixtures();
    const { io, to, emit } = buildIo();

    const startPromise = startNavigatorSession(draft, session, events, 1, io, {});

    // Wait a microtask so the engine.createNavigatorSession + napiSession.start
    // calls complete and the entry is registered in the map.
    await flushAsyncSetup();
    expect(mockNapiSession._onPartial).toBeTruthy();

    // Feed a partial through the captured onPartial callback.
    mockNapiSession._onPartial(JSON.stringify({
      protocolVersion: "1.0.0",
      tree: { championIds: ["X"], children: [] },
      scenarios: [],
      meta: { nodesEvaluated: 10, computeTimeMs: 5, partial: true, rootPath: [["X"]] },
    }));

    expect(to).toHaveBeenCalledWith("navigator:sess-1");
    expect(emit).toHaveBeenCalledWith(
      "navigatorPartialSnapshot",
      expect.objectContaining({
        sessionId: "sess-1",
        draftId: "draft-1",
        version: 1,
        snapshot: expect.objectContaining({
          id: "partial",
          navigator_draft_id: "draft-1",
          tree: { championIds: ["X"], children: [] },
          meta: expect.objectContaining({ rootPath: [["X"]] }),
        }),
      }),
    );

    // Resolve to let startNavigatorSession complete and clean up.
    mockNapiSession._resolve(makeEngineResponseJson({ meta: { nodesEvaluated: 100, computeTimeMs: 50, cancelled: false, rootPath: [["X"]] } }));
    await startPromise;
  });

  it("partial envelope uses response.meta.rootPath, not entry.rootPathCache (Decision 7)", async () => {
    const { session, draft, events } = buildFixtures();
    const { io, emit } = buildIo();

    const startPromise = startNavigatorSession(draft, session, events, 1, io, {});
    await flushAsyncSetup();

    // Seed rootPathCache with stale value to prove the envelope ignores it.
    const entry = __activeSessionsForTests.get("sess-1");
    entry.rootPathCache = [["STALE"]];

    mockNapiSession._onPartial(JSON.stringify({
      protocolVersion: "1.0.0",
      tree: { championIds: [], children: [] },
      scenarios: [],
      meta: { nodesEvaluated: 1, computeTimeMs: 1, partial: true, rootPath: [["FRESH"]] },
    }));

    const call = emit.mock.calls.find((c) => c[0] === "navigatorPartialSnapshot");
    expect(call).toBeTruthy();
    expect(call[1].snapshot.meta.rootPath).toEqual([["FRESH"]]);

    mockNapiSession._resolve(makeEngineResponseJson());
    await startPromise;
  });
});

describe("startNavigatorSession — persistence policy", () => {
  it("persists + broadcasts navigatorSnapshot when stopReason='user'", async () => {
    const { session, draft, events } = buildFixtures();
    const { io, to, emit } = buildIo();

    const startPromise = startNavigatorSession(draft, session, events, 1, io, {});
    await flushAsyncSetup();

    // Simulate user stop: sets stopReason BEFORE the final-snapshot resolves.
    const entry = __activeSessionsForTests.get("sess-1");
    entry.stopReason = "user";
    mockNapiSession._resolve(makeEngineResponseJson());

    const result = await startPromise;
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(result.snapshot).toMatchObject({
      id: "snap-1",
      navigator_draft_id: "draft-1",
    });
    expect(to).toHaveBeenCalledWith("navigator:sess-1");
    const broadcast = emit.mock.calls.find((c) => c[0] === "navigatorSnapshot");
    expect(broadcast).toBeTruthy();
    expect(broadcast[1].snapshot.id).toBe("snap-1");
  });

  it("does NOT persist or broadcast when stopReason='supersede'", async () => {
    const { session, draft, events } = buildFixtures();
    const { io, emit } = buildIo();

    const startPromise = startNavigatorSession(draft, session, events, 1, io, {});
    await flushAsyncSetup();
    const entry = __activeSessionsForTests.get("sess-1");
    entry.stopReason = "supersede";
    mockNapiSession._resolve(makeEngineResponseJson());

    const result = await startPromise;
    expect(createSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ version: 1, snapshot: null, supersededOrDropped: true });
    const broadcast = emit.mock.calls.find((c) => c[0] === "navigatorSnapshot");
    expect(broadcast).toBeFalsy();
  });

  it("does NOT persist or broadcast when stopReason='disconnect'", async () => {
    const { session, draft, events } = buildFixtures();
    const { io, emit } = buildIo();

    const startPromise = startNavigatorSession(draft, session, events, 1, io, {});
    await flushAsyncSetup();
    const entry = __activeSessionsForTests.get("sess-1");
    entry.stopReason = "disconnect";
    mockNapiSession._resolve(makeEngineResponseJson());

    const result = await startPromise;
    expect(createSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ version: 1, snapshot: null, supersededOrDropped: true });
    const broadcast = emit.mock.calls.find((c) => c[0] === "navigatorSnapshot");
    expect(broadcast).toBeFalsy();
  });
});

describe("handlePartialOrError — identity + stopReason guards (Codex R2-#2)", () => {
  it("drops late partials after the map slot has been replaced", () => {
    const { io, emit } = buildIo();
    // entryA is the "old" session. Register it in the map, then replace
    // the slot with entryB to simulate supersession.
    const entryA = {
      sessionId: "sess-1", draftId: "draft-1", version: 1,
      afterEventId: null, stopReason: null, rootPathCache: [],
    };
    const entryB = {
      sessionId: "sess-1", draftId: "draft-1", version: 2,
      afterEventId: null, stopReason: null, rootPathCache: [],
    };
    __activeSessionsForTests.set("sess-1", entryA);
    __activeSessionsForTests.set("sess-1", entryB); // replace slot

    __handlePartialOrErrorForTests(entryA, io, JSON.stringify({
      protocolVersion: "1.0.0",
      tree: { championIds: [], children: [] },
      scenarios: [],
      meta: { partial: true, rootPath: [] },
    }));

    expect(emit).not.toHaveBeenCalled();
  });

  it("drops partials when entry.stopReason is set (stop in flight)", () => {
    const { io, emit } = buildIo();
    const entry = {
      sessionId: "sess-1", draftId: "draft-1", version: 1,
      afterEventId: null, stopReason: "user", rootPathCache: [],
    };
    __activeSessionsForTests.set("sess-1", entry);

    __handlePartialOrErrorForTests(entry, io, JSON.stringify({
      protocolVersion: "1.0.0",
      tree: { championIds: [], children: [] },
      scenarios: [],
      meta: { partial: true, rootPath: [] },
    }));

    expect(emit).not.toHaveBeenCalled();
  });

  it("emits navigatorRerootError when payload carries rerootError", () => {
    const { io, to, emit } = buildIo();
    const entry = {
      sessionId: "sess-1", draftId: "draft-1", version: 1,
      afterEventId: null, stopReason: null, rootPathCache: [],
    };
    __activeSessionsForTests.set("sess-1", entry);

    __handlePartialOrErrorForTests(entry, io, JSON.stringify({
      rerootError: "path mismatch",
      rerootId: 7,
      attemptedPath: [["X"]],
    }));

    expect(to).toHaveBeenCalledWith("navigator:sess-1");
    expect(emit).toHaveBeenCalledWith("navigatorRerootError", {
      sessionId: "sess-1",
      draftId: "draft-1",
      rerootId: 7,
      attemptedPath: [["X"]],
      error: "path mismatch",
    });
  });
});
