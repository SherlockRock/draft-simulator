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
const { setupNavigatorHandlers, loadAuthorizedContext } = require("../../socketHandlers/navigatorHandlers");

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

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toClientSnapshot", () => {
  const { toClientSnapshot } = require("../../socketHandlers/navigatorHandlers");

  it("returns null for null input", () => {
    expect(toClientSnapshot(null)).toBeNull();
  });

  it("passes through an already-wire-shaped snapshot (has source field)", () => {
    const wire = {
      source: "persisted",
      id: null,
      navigator_draft_id: "nd-1",
      after_event_id: "ev-1",
      tree: { championIds: [] },
      scenarios: [],
      meta: null,
      createdAt: null,
      updatedAt: null,
    };
    expect(toClientSnapshot(wire)).toBe(wire);
  });

  it("converts a Sequelize DB row to wire shape with source='persisted'", () => {
    const row = {
      id: "snap-1",
      navigator_draft_id: "nd-1",
      after_event_id: "ev-1",
      pruned_tree: { championIds: ["X"] },
      scenarios: [{ name: "Robust" }],
      compute_meta: { nodesEvaluated: 5 },
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
    };
    expect(toClientSnapshot(row)).toEqual({
      source: "persisted",
      id: "snap-1",
      navigator_draft_id: "nd-1",
      after_event_id: "ev-1",
      tree: { championIds: ["X"] },
      scenarios: [{ name: "Robust" }],
      meta: { nodesEvaluated: 5 },
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
    });
  });
});

// Shared model-layer mocks for the pick/ban recompute tests below. The αβ
// one-shot path is asserted via a spy on navigatorEngine.computeForDraft —
// the single chokepoint reached by recomputeAndBroadcast. The production
// handler accesses it via navigatorEngine.* (not destructured) so the spy is
// honoured.
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

describe("navigatorPick recompute", () => {
  // TURN_SEQUENCE slot 6 = first pick1 (blue, solo).
  it("recomputes via computeForDraft on a solo pick", async () => {
    setupHappyMocks();
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

  it("recomputes via computeForDraft on a pair pick", async () => {
    setupHappyMocks();
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

    expect(computeSpy).toHaveBeenCalled();
  });
});

describe("navigatorBan recompute", () => {
  // TURN_SEQUENCE slot 0 = blue ban1 (first ban).
  it("recomputes via computeForDraft on a ban", async () => {
    setupHappyMocks();
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

// Item 1: since engine-core 2c45cbd, a root state that lists the same
// champion twice returns EngineError::InvalidInput. Duplicate picks/bans must
// be rejected at the handler layer, before they are ever persisted.
describe("navigatorPick / navigatorBan reject already-taken champions", () => {
  function getNavigatorErrors(socket) {
    return socket.emit.mock.calls
      .filter(([event]) => event === "navigatorError")
      .map(([, payload]) => payload.error);
  }

  it("navigatorPick: rejects a champion already in a persisted PICK event", async () => {
    setupHappyMocks();
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([
      { champion_id: "Ahri", event_type: "pick", slot: 6, side: "blue" },
    ]);
    const createSpy = vi.spyOn(NavigatorEvent, "create");
    const computeSpy = vi.spyOn(navigatorEngine, "computeForDraft");

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Ahri"],
      firstSlot: 6,
    });

    expect(getNavigatorErrors(socket)).toEqual(["Champion Ahri is already picked or banned"]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("navigatorPick: rejects a champion already in a persisted BAN event", async () => {
    setupHappyMocks();
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([
      { champion_id: "Ahri", event_type: "ban", slot: 0, side: "blue" },
    ]);
    const createSpy = vi.spyOn(NavigatorEvent, "create");
    const computeSpy = vi.spyOn(navigatorEngine, "computeForDraft");

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Ahri"],
      firstSlot: 6,
    });

    expect(getNavigatorErrors(socket)).toEqual(["Champion Ahri is already picked or banned"]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("navigatorPick: rejects a pair pick of the same champion twice", async () => {
    setupHappyMocks();
    const createSpy = vi.spyOn(NavigatorEvent, "create");
    const computeSpy = vi.spyOn(navigatorEngine, "computeForDraft");

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    // Slots 7+8 are both red pick1 → valid 2-slot pair window.
    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista", "Kalista"],
      firstSlot: 7,
    });

    expect(getNavigatorErrors(socket)).toEqual(["A pair pick needs two different champions"]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("navigatorPick: rejects a pair pick when only the second id is taken, with zero creates", async () => {
    setupHappyMocks();
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([
      { champion_id: "Braum", event_type: "pick", slot: 2, side: "blue" },
    ]);
    const createSpy = vi.spyOn(NavigatorEvent, "create");
    const computeSpy = vi.spyOn(navigatorEngine, "computeForDraft");

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista", "Braum"],
      firstSlot: 7,
    });

    expect(getNavigatorErrors(socket)).toEqual(["Champion Braum is already picked or banned"]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("navigatorBan: rejects a ban of an already-picked champion", async () => {
    setupHappyMocks();
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([
      { champion_id: "Aatrox", event_type: "pick", slot: 6, side: "blue" },
    ]);
    const createSpy = vi.spyOn(NavigatorEvent, "create");
    const computeSpy = vi.spyOn(navigatorEngine, "computeForDraft");

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorBan")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championId: "Aatrox",
      slot: 0,
    });

    expect(getNavigatorErrors(socket)).toEqual(["Champion Aatrox is already picked or banned"]);
    expect(createSpy).not.toHaveBeenCalled();
    expect(computeSpy).not.toHaveBeenCalled();
  });

  it("navigatorPick: a happy-path pick with a non-empty history of OTHER champions still creates and recomputes", async () => {
    setupHappyMocks();
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([
      { champion_id: "Ahri", event_type: "pick", slot: 6, side: "blue" },
      { champion_id: "Zed", event_type: "ban", slot: 0, side: "blue" },
    ]);
    const createSpy = vi.spyOn(NavigatorEvent, "create").mockResolvedValue({ id: "ev-2" });
    const computeSpy = vi
      .spyOn(navigatorEngine, "computeForDraft")
      .mockResolvedValue({ version: 1, snapshot: null });

    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });

    await handlers.get("navigatorPick")({
      sessionId: "sess-1",
      draftId: "draft-1",
      championIds: ["Kalista"],
      firstSlot: 7,
    });

    expect(getNavigatorErrors(socket)).toEqual([]);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(computeSpy).toHaveBeenCalled();
  });
});

describe("loadAuthorizedContext", () => {
  let socket;
  let emittedErrors;

  beforeEach(() => {
    emittedErrors = [];
    socket = {
      emit: vi.fn((event, payload) => {
        if (event === "navigatorError") emittedErrors.push(payload.error);
      }),
      user: { id: "user-1" },
    };
  });

  it("emits 'sessionId is required' and returns null when sessionId missing", async () => {
    const ctx = await loadAuthorizedContext(socket, {});
    expect(ctx).toBeNull();
    expect(emittedErrors).toEqual(["sessionId is required"]);
  });

  it("returns null when session not found (findOwnedSession emits the error)", async () => {
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(null);
    const ctx = await loadAuthorizedContext(socket, { sessionId: "s-1" });
    expect(ctx).toBeNull();
    expect(emittedErrors).toEqual(["Navigator session not found"]);
  });

  it("returns { session, draft, events } when called with requireDraftId=false and a current draft exists", async () => {
    const session = { id: "s-1", user_id: "user-1" };
    const draft = { id: "d-1", session_id: "s-1", status: "active", game_number: 1 };
    const events = [{ id: "e-1" }];
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(session);
    vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue(draft);
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue(events);

    const ctx = await loadAuthorizedContext(socket, { sessionId: "s-1" });
    expect(ctx).toEqual({ session, draft, events });
    expect(emittedErrors).toEqual([]);
  });

  it("returns { session, draft: null, events: [] } when no current draft", async () => {
    const session = { id: "s-1", user_id: "user-1" };
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(session);
    vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue(null);

    const ctx = await loadAuthorizedContext(socket, { sessionId: "s-1" });
    expect(ctx).toEqual({ session, draft: null, events: [] });
  });

  it("emits 'draftId is required' when requireDraftId=true and draftId missing", async () => {
    const session = { id: "s-1", user_id: "user-1" };
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(session);
    const ctx = await loadAuthorizedContext(socket, { sessionId: "s-1" }, { requireDraftId: true });
    expect(ctx).toBeNull();
    expect(emittedErrors).toEqual(["draftId is required"]);
  });

  it("emits 'Navigator draft not found' when requireDraftId=true and the draft does not belong to the session", async () => {
    const session = { id: "s-1", user_id: "user-1" };
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(session);
    vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue(null);

    const ctx = await loadAuthorizedContext(
      socket,
      { sessionId: "s-1", draftId: "d-missing" },
      { requireDraftId: true }
    );
    expect(ctx).toBeNull();
    expect(emittedErrors).toEqual(["Navigator draft not found"]);
  });

  it("skips listDraftEvents when fetchEvents=false", async () => {
    const session = { id: "s-1", user_id: "user-1" };
    const draft = { id: "d-1", session_id: "s-1", status: "active", game_number: 1 };
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(session);
    vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue(draft);
    const eventsSpy = vi.spyOn(NavigatorEvent, "findAll");

    const ctx = await loadAuthorizedContext(
      socket,
      { sessionId: "s-1", draftId: "d-1" },
      { requireDraftId: true, fetchEvents: false }
    );
    expect(ctx).toEqual({ session, draft, events: null });
    expect(eventsSpy).not.toHaveBeenCalled();
  });
});

describe("navigatorStartDraft", () => {
  it("broadcasts the draft update to the session room instead of throwing", async () => {
    const { socket, handlers } = buildFakeSocket();
    const { io } = installHandlers({ socket });

    const session = { id: "s-1", user_id: "user-1", status: "setup", save: vi.fn() };
    const draft = { id: "d-1", session_id: "s-1", status: "active", game_number: 1 };
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(session);
    vi.spyOn(NavigatorDraft, "findOne").mockResolvedValue(draft);
    vi.spyOn(NavigatorEvent, "findAll").mockResolvedValue([]);
    vi.spyOn(NavigatorSnapshot, "findOne").mockResolvedValue(null);

    await handlers.get("navigatorStartDraft")({ sessionId: "s-1" });

    // Regression: the handler used a `sessionId` binding that no longer existed
    // after the loadAuthorizedContext refactor, so every start threw a
    // ReferenceError and the client only ever saw "Failed to start navigator
    // draft". Nothing must be emitted on the error channel.
    const errorEmits = socket.emit.mock.calls.filter(([event]) => event === "navigatorError");
    expect(errorEmits).toEqual([]);
    expect(io.to).toHaveBeenCalledWith("navigator:s-1");
    expect(session.status).toBe("active");
    expect(session.save).toHaveBeenCalled();
  });
});
