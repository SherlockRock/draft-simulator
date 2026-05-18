import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

// Load CJS modules via Node's resolver so we can spy on the models + service
// the handler module captured at require-time. The handlers consume the
// NavigatorSession / NavigatorDraft / NavigatorEvent models directly and the
// navigatorEngine module via star import, so we patch their exports in place.
const require = createRequire(import.meta.url);
const NavigatorSession = require("../../models/NavigatorSession");
const NavigatorDraft = require("../../models/NavigatorDraft");
const NavigatorEvent = require("../../models/NavigatorEvent");
const NavigatorSnapshot = require("../../models/NavigatorSnapshot");
const navigatorEngine = require("../../services/navigatorEngine");
const { setupNavigatorHandlers } = require("../../socketHandlers/navigatorHandlers");

function buildFakeSocket(overrides = {}) {
  const handlers = new Map();
  const socket = {
    id: overrides.id || "socket-1",
    user: { id: overrides.userId || "user-1" },
    emit: vi.fn(),
    join: vi.fn(),
    on: vi.fn((event, fn) => {
      handlers.set(event, fn);
    }),
  };
  return { socket, handlers };
}

function buildIo() {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  return { to, emit };
}

function wrapSocketHandler(socket, eventName, handler) {
  socket.on(eventName, handler);
}

function installHandlers({ socket }) {
  const io = buildIo();
  setupNavigatorHandlers(io, socket, wrapSocketHandler);
  return { io };
}

// Drain microtasks + a setImmediate so the disconnect handler's async IIFEs
// (pause -> end) have a chance to run before assertions.
const flushAsync = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  navigatorEngine.activeSessions.clear();
  vi.restoreAllMocks();
});

describe("navigatorStopCompute (T11)", () => {
  it("emits 'sessionId is required' when sessionId missing", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    const pauseSpy = vi
      .spyOn(navigatorEngine, "pauseNavigatorSession")
      .mockResolvedValue({ ok: true });
    const findSpy = vi.spyOn(NavigatorSession, "findByPk");

    await handlers.get("navigatorStopCompute")({});

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "sessionId is required",
    });
    expect(findSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it("auth-gates via findOwnedSession (returns null on missing session, skips engine)", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(null);
    const pauseSpy = vi
      .spyOn(navigatorEngine, "pauseNavigatorSession")
      .mockResolvedValue({ ok: true });

    await handlers.get("navigatorStopCompute")({ sessionId: "sess-1" });

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "Navigator session not found",
    });
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it("invokes pauseNavigatorSession with (sessionId, io) on the owned session", async () => {
    const { socket, handlers } = buildFakeSocket();
    const { io } = installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
      id: "sess-1",
      user_id: "user-1",
    });
    const pauseSpy = vi
      .spyOn(navigatorEngine, "pauseNavigatorSession")
      .mockResolvedValue({ ok: true });

    await handlers.get("navigatorStopCompute")({ sessionId: "sess-1" });

    expect(pauseSpy).toHaveBeenCalledWith("sess-1", io);
    expect(socket.emit).not.toHaveBeenCalledWith(
      "navigatorError",
      expect.anything(),
    );
  });

  it("swallows expected silent rejection reasons", async () => {
    const silent = ["superseded-mid-pause", "session-superseded", "no-active-session"];
    for (const reason of silent) {
      const { socket, handlers } = buildFakeSocket();
      installHandlers({ socket });
      vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
        id: "sess-1",
        user_id: "user-1",
      });
      vi.spyOn(navigatorEngine, "pauseNavigatorSession").mockResolvedValue({
        ok: false,
        reason,
      });

      await handlers.get("navigatorStopCompute")({ sessionId: "sess-1" });

      expect(socket.emit).not.toHaveBeenCalledWith(
        "navigatorError",
        expect.anything(),
      );
      vi.restoreAllMocks();
    }
  });

  it("surfaces unexpected pause failures via navigatorError", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
      id: "sess-1",
      user_id: "user-1",
    });
    vi.spyOn(navigatorEngine, "pauseNavigatorSession").mockResolvedValue({
      ok: false,
      reason: "unknown-explosion",
    });

    await handlers.get("navigatorStopCompute")({ sessionId: "sess-1" });

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "Stop failed: unknown-explosion",
    });
  });
});

describe("navigatorResumeCompute (T11)", () => {
  it("emits 'sessionId is required' when sessionId missing", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    const resumeSpy = vi.spyOn(navigatorEngine, "resumeNavigatorSession");

    await handlers.get("navigatorResumeCompute")({});

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "sessionId is required",
    });
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("auth-gates before calling the engine", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(null);
    const resumeSpy = vi.spyOn(navigatorEngine, "resumeNavigatorSession");

    await handlers.get("navigatorResumeCompute")({ sessionId: "sess-1" });

    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("emits 'No current draft' when session has no draft", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
      id: "sess-1",
      user_id: "user-1",
    });
    vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue(null);
    const resumeSpy = vi.spyOn(navigatorEngine, "resumeNavigatorSession");

    await handlers.get("navigatorResumeCompute")({ sessionId: "sess-1" });

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "No current draft",
    });
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("dispatches resumeNavigatorSession(draft, session, events, version, io, options)", async () => {
    const { socket, handlers } = buildFakeSocket();
    const { io } = installHandlers({ socket });
    const session = { id: "sess-1", user_id: "user-1" };
    const draft = { id: "draft-1", session_id: "sess-1" };
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(session);
    vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue(draft);
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([]);
    const resumeSpy = vi
      .spyOn(navigatorEngine, "resumeNavigatorSession")
      .mockResolvedValue({ ok: true });

    await handlers.get("navigatorResumeCompute")({ sessionId: "sess-1" });

    expect(resumeSpy).toHaveBeenCalledWith(
      draft,
      session,
      [],
      expect.any(Number),
      io,
      expect.objectContaining({ socketId: "socket-1" }),
    );
  });
});

describe("disconnect cleanup (T11)", () => {
  it("pauses then ends only the sessions owned by this socket", async () => {
    const { socket, handlers } = buildFakeSocket({ id: "socket-A" });
    installHandlers({ socket });

    // Three mock entries: two owned by socket-A, one by socket-B. The
    // disconnect handler must run the pause+end IIFE only for the first two.
    const entries = [
      { sessionId: "sess-1", socketId: "socket-A", stopReason: null },
      { sessionId: "sess-2", socketId: "socket-A", stopReason: null },
      { sessionId: "sess-3", socketId: "socket-B", stopReason: null },
    ];
    vi.spyOn(navigatorEngine, "forEachActiveSession").mockImplementation(
      (cb) => {
        for (const entry of entries) cb(entry);
      },
    );
    const pauseSpy = vi
      .spyOn(navigatorEngine, "pauseNavigatorSession")
      .mockResolvedValue({ ok: true });
    const endSpy = vi
      .spyOn(navigatorEngine, "endNavigatorSession")
      .mockResolvedValue({ ok: true });

    handlers.get("disconnect")();
    await flushAsync();
    await flushAsync();

    expect(pauseSpy).toHaveBeenCalledTimes(2);
    expect(endSpy).toHaveBeenCalledTimes(2);
    expect(pauseSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["sess-1", "sess-2"]);
    expect(endSpy.mock.calls.map((c) => [c[0], c[1]]).sort()).toEqual([
      ["sess-1", "disconnect"],
      ["sess-2", "disconnect"],
    ]);
    expect(pauseSpy).not.toHaveBeenCalledWith("sess-3", expect.anything());
    expect(endSpy).not.toHaveBeenCalledWith("sess-3", expect.anything());

    // v4 R3 B1: stopReason set BEFORE pause so the pre-await guard recognises
    // the disconnect path.
    expect(entries[0].stopReason).toBe("disconnect");
    expect(entries[1].stopReason).toBe("disconnect");
    expect(entries[2].stopReason).toBe(null);
  });

  it("forEachActiveSession invokes its callback for each registered entry", () => {
    const { __activeSessionsForTests, forEachActiveSession } = navigatorEngine;
    __activeSessionsForTests.clear();
    __activeSessionsForTests.set("a", { sessionId: "a", socketId: "s-1" });
    __activeSessionsForTests.set("b", { sessionId: "b", socketId: "s-2" });

    const seen = [];
    forEachActiveSession((entry) => seen.push(entry.sessionId));

    expect(seen).toEqual(["a", "b"]);
    __activeSessionsForTests.clear();
  });
});

// Shared helpers for the warm/cold pick+ban tests below. Mock the model layer
// (findByPk / findOne / create / findAll / save) plus NavigatorSnapshot.destroy
// so the handler reaches the warm/cold branch without hitting the real DB.
// The cold path is asserted via a spy on navigatorEngine.computeForDraft —
// the single chokepoint reached by recomputeAndBroadcast in both αβ and MCTS
// modes. The production handler accesses it via navigatorEngine.* (not
// destructured) so the spy is honoured.
function setupHappyMocks({ sessionId = "sess-1", draftId = "draft-1" } = {}) {
  vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
    id: sessionId,
    user_id: "user-1",
  });
  vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue({
    id: draftId,
    session_id: sessionId,
    status: "active",
    save: vi.fn().mockResolvedValue(undefined),
  });
  vi.spyOn(NavigatorEvent, "create").mockResolvedValue({ id: "ev-1" });
  vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([]);
  vi.spyOn(NavigatorSnapshot, "destroy").mockResolvedValue(0);
}

function buildEntry({
  sessionId = "sess-1",
  draftId = "draft-1",
  projectedChildren = new Set(),
  applyPickImpl = vi.fn().mockResolvedValue(undefined),
  lastPersistedPauseSnapshotId = null,
} = {}) {
  return {
    sessionId,
    draftId,
    session: { applyPick: applyPickImpl },
    projectedChildren,
    pausePersistPromise: null,
    lastPersistedPauseSnapshotId,
    socketId: "socket-1",
    stopReason: null,
  };
}

describe("navigatorPick warm path", () => {
  // TURN_SEQUENCE slot 6 = first pick1 (blue, solo).
  // Slot 7 + 8 = red pair pick (red, red, same side).
  it("warm-restarts when championIds matches a solo projected child", async () => {
    setupHappyMocks();
    const applyPickSpy = vi.fn().mockResolvedValue(undefined);
    const entry = buildEntry({
      projectedChildren: new Set(["Kalista"]),
      applyPickImpl: applyPickSpy,
    });
    navigatorEngine.activeSessions.set("sess-1", entry);
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista"],
      firstSlot: 6,
    });

    expect(applyPickSpy).toHaveBeenCalledWith(["Kalista"]);
    expect(applyPickSpy).toHaveBeenCalledTimes(1);
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("advances entry.afterEventId + entry.version after warm restart", async () => {
    setupHappyMocks();
    // listDraftEvents (NavigatorEvent.findAll) returns the post-pick events;
    // the warm path must mirror the latest id onto the entry so that a Stop
    // after the warm pick persists a snapshot whose after_event_id matches
    // the latest NavigatorEvent (driving frontend hasPausedSession freshness).
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([
      { id: "ev-pre", event_type: "pick", slot: 5, side: "red", champion_id: "Pre", createdAt: "2026-05-18T00:00:00Z" },
      { id: "ev-warm", event_type: "pick", slot: 6, side: "blue", champion_id: "Kalista", createdAt: "2026-05-18T00:00:01Z" },
    ]);
    const entry = buildEntry({
      projectedChildren: new Set(["Kalista"]),
    });
    entry.afterEventId = "ev-pre";
    entry.version = 7;
    navigatorEngine.activeSessions.set("sess-1", entry);
    vi.spyOn(navigatorEngine, "computeForDraft").mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista"],
      firstSlot: 6,
    });

    expect(entry.afterEventId).toBe("ev-warm");
    expect(entry.version).not.toBe(7);
    expect(typeof entry.version).toBe("number");
  });

  it("warm-restarts pair when championIds matches a pair projected child", async () => {
    setupHappyMocks();
    const applyPickSpy = vi.fn().mockResolvedValue(undefined);
    const entry = buildEntry({
      projectedChildren: new Set(["Kalista|Braum"]),
      applyPickImpl: applyPickSpy,
    });
    navigatorEngine.activeSessions.set("sess-1", entry);
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    // Slots 7+8 are both red pick1 → valid 2-slot pair window.
    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista", "Braum"],
      firstSlot: 7,
    });

    expect(applyPickSpy).toHaveBeenCalledWith(["Kalista", "Braum"]);
    expect(applyPickSpy).toHaveBeenCalledTimes(1);
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("falls back to cold path when applyPick rejects with notProjected", async () => {
    setupHappyMocks();
    const applyPickSpy = vi
      .fn()
      .mockRejectedValue(new Error("applyPick.notProjected"));
    const entry = buildEntry({
      projectedChildren: new Set(["Kalista"]),
      applyPickImpl: applyPickSpy,
    });
    navigatorEngine.activeSessions.set("sess-1", entry);
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista"],
      firstSlot: 6,
    });

    expect(applyPickSpy).toHaveBeenCalledWith(["Kalista"]);
    expect(computeSpy).toHaveBeenCalled();
  });
});

describe("navigatorPick cold path", () => {
  it("cold-restarts when championIds not in projectedChildren", async () => {
    setupHappyMocks();
    const applyPickSpy = vi.fn();
    const entry = buildEntry({
      projectedChildren: new Set(["Tristana"]),
      applyPickImpl: applyPickSpy,
    });
    navigatorEngine.activeSessions.set("sess-1", entry);
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista"],
      firstSlot: 6,
    });

    expect(applyPickSpy).not.toHaveBeenCalled();
    expect(computeSpy).toHaveBeenCalled();
  });

  it("cold-restarts when no activeSessions entry exists", async () => {
    setupHappyMocks();
    navigatorEngine.activeSessions.delete("sess-1");
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista"],
      firstSlot: 6,
    });

    expect(computeSpy).toHaveBeenCalled();
  });
});

describe("navigatorBan warm/cold path", () => {
  // TURN_SEQUENCE slot 0 = blue ban1 (first ban). Slot 1 = red ban1.
  it("warm-restarts when ban championId matches a projected child", async () => {
    setupHappyMocks();
    const applyPickSpy = vi.fn().mockResolvedValue(undefined);
    const entry = buildEntry({
      projectedChildren: new Set(["Aatrox"]),
      applyPickImpl: applyPickSpy,
    });
    navigatorEngine.activeSessions.set("sess-1", entry);
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorBan")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championId: "Aatrox",
      slot: 0,
    });

    expect(applyPickSpy).toHaveBeenCalledWith(["Aatrox"]);
    expect(applyPickSpy).toHaveBeenCalledTimes(1);
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("falls back to cold path when applyPick rejects with notProjected (ban)", async () => {
    setupHappyMocks();
    const applyPickSpy = vi
      .fn()
      .mockRejectedValue(new Error("applyPick.notProjected"));
    const entry = buildEntry({
      projectedChildren: new Set(["Aatrox"]),
      applyPickImpl: applyPickSpy,
    });
    navigatorEngine.activeSessions.set("sess-1", entry);
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorBan")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championId: "Aatrox",
      slot: 0,
    });

    expect(applyPickSpy).toHaveBeenCalledWith(["Aatrox"]);
    expect(computeSpy).toHaveBeenCalled();
  });

  it("cold-restarts when ban championId not in projectedChildren", async () => {
    setupHappyMocks();
    const applyPickSpy = vi.fn();
    const entry = buildEntry({
      projectedChildren: new Set(["Other"]),
      applyPickImpl: applyPickSpy,
    });
    navigatorEngine.activeSessions.set("sess-1", entry);
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorBan")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championId: "Aatrox",
      slot: 0,
    });

    expect(applyPickSpy).not.toHaveBeenCalled();
    expect(computeSpy).toHaveBeenCalled();
  });

  it("cold-restarts when no activeSessions entry exists (ban)", async () => {
    setupHappyMocks();
    navigatorEngine.activeSessions.delete("sess-1");
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorBan")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championId: "Aatrox",
      slot: 0,
    });

    expect(computeSpy).toHaveBeenCalled();
  });
});

describe("setProjectedChildren", () => {
  const { setProjectedChildren } = navigatorEngine;

  it("mirrors solo children as bare keys", () => {
    const entry = {};
    setProjectedChildren(entry, {
      tree: {
        children: [
          { championIds: ["Kalista"] },
          { championIds: ["Tristana"] },
        ],
      },
    });
    expect(entry.projectedChildren).toEqual(new Set(["Kalista", "Tristana"]));
  });

  it("mirrors pair child as joined 'A|B' key", () => {
    const entry = {};
    setProjectedChildren(entry, {
      tree: { children: [{ championIds: ["Kalista", "Braum"] }] },
    });
    expect(entry.projectedChildren).toEqual(new Set(["Kalista|Braum"]));
  });

  it("sets empty Set when tree.children is empty", () => {
    const entry = { projectedChildren: new Set(["stale"]) };
    setProjectedChildren(entry, { tree: { children: [] } });
    expect(entry.projectedChildren).toEqual(new Set());
  });

  it("sets empty Set when tree is missing entirely", () => {
    const entry = {};
    setProjectedChildren(entry, {});
    expect(entry.projectedChildren).toEqual(new Set());
  });

  it("skips children with missing or empty championIds", () => {
    const entry = {};
    setProjectedChildren(entry, {
      tree: {
        children: [
          { championIds: [] },
          { /* no championIds */ },
          { championIds: ["Lux"] },
        ],
      },
    });
    expect(entry.projectedChildren).toEqual(new Set(["Lux"]));
  });
});
