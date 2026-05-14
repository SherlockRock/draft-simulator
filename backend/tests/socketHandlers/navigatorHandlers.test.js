import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

// Load CJS modules via Node's resolver so we can spy on the model + service
// the handler module captured at require-time. The handlers consume the
// NavigatorSession model directly and the navigatorEngine module via star
// import, so we patch their exports in place.
const require = createRequire(import.meta.url);
const NavigatorSession = require("../../models/NavigatorSession");
const navigatorEngine = require("../../services/navigatorEngine");
const { setupNavigatorHandlers } = require("../../socketHandlers/navigatorHandlers");

// Build a fake socket whose .on(event, handler) registrations are captured
// in a map so each test can invoke the registered handler directly. This
// avoids needing a real socket.io server. socket.user mirrors the shape
// produced by socketAuth middleware in production.
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

// Mirrors backend/index.js's wrapSocketHandler — registers the handler on
// socket.on. We don't need the otel metrics shim for tests.
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

describe("navigatorStopCompute (T11)", () => {
  it("emits 'sessionId is required' when sessionId missing", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    const stopSpy = vi
      .spyOn(navigatorEngine, "stopNavigatorSession")
      .mockResolvedValue({ ok: true });
    const findSpy = vi.spyOn(NavigatorSession, "findByPk");

    await handlers.get("navigatorStopCompute")({});

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "sessionId is required",
    });
    expect(findSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("auth-gates via findOwnedSession (returns null on missing session, skips engine)", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(null);
    const stopSpy = vi
      .spyOn(navigatorEngine, "stopNavigatorSession")
      .mockResolvedValue({ ok: true });

    await handlers.get("navigatorStopCompute")({ sessionId: "sess-1" });

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "Navigator session not found",
    });
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("invokes stopNavigatorSession with reason='user' on the owned session", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
      id: "sess-1",
      user_id: "user-1",
    });
    const stopSpy = vi
      .spyOn(navigatorEngine, "stopNavigatorSession")
      .mockResolvedValue({ ok: true });

    await handlers.get("navigatorStopCompute")({ sessionId: "sess-1" });

    expect(stopSpy).toHaveBeenCalledWith("sess-1", "user");
    expect(socket.emit).not.toHaveBeenCalledWith(
      "navigatorError",
      expect.anything(),
    );
  });
});

describe("navigatorReroot (T12)", () => {
  const VALID_PAYLOAD = {
    sessionId: "sess-1",
    draftId: "draft-1",
    rerootId: 7,
    rerootStep: [["X"]],
  };

  it("rejects payloads missing any required field", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    const rerootSpy = vi.spyOn(navigatorEngine, "rerootNavigatorSession");

    // Try each missing-field variant; each must emit the canonical error and
    // skip the engine call.
    const variants = [
      {},
      { sessionId: "sess-1" },
      { sessionId: "sess-1", draftId: "draft-1" },
      { sessionId: "sess-1", draftId: "draft-1", rerootId: 7 },
      // rerootId as string instead of number
      { ...VALID_PAYLOAD, rerootId: "7" },
      // rerootStep not an array
      { ...VALID_PAYLOAD, rerootStep: "not-array" },
    ];

    for (const data of variants) {
      socket.emit.mockClear();
      await handlers.get("navigatorReroot")(data);
      expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
        error: "sessionId, draftId, rerootId, rerootStep required",
      });
    }
    expect(rerootSpy).not.toHaveBeenCalled();
  });

  it("auth-gates via findOwnedSession before calling the engine", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue(null);
    const rerootSpy = vi.spyOn(navigatorEngine, "rerootNavigatorSession");

    await handlers.get("navigatorReroot")(VALID_PAYLOAD);

    expect(rerootSpy).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "Navigator session not found",
    });
  });

  it("routes to rerootNavigatorSession with id + step on the owned session", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
      id: "sess-1",
      user_id: "user-1",
    });
    const rerootSpy = vi
      .spyOn(navigatorEngine, "rerootNavigatorSession")
      .mockResolvedValue({ ok: true });

    await handlers.get("navigatorReroot")(VALID_PAYLOAD);

    expect(rerootSpy).toHaveBeenCalledWith("sess-1", 7, [["X"]]);
    expect(socket.emit).not.toHaveBeenCalledWith(
      "navigatorError",
      expect.anything(),
    );
  });

  it("surfaces engine-side rejection reasons (e.g. no-active-session)", async () => {
    const { socket, handlers } = buildFakeSocket();
    installHandlers({ socket });
    vi.spyOn(NavigatorSession, "findByPk").mockResolvedValue({
      id: "sess-1",
      user_id: "user-1",
    });
    vi.spyOn(navigatorEngine, "rerootNavigatorSession").mockResolvedValue({
      ok: false,
      reason: "no-active-session",
    });

    await handlers.get("navigatorReroot")(VALID_PAYLOAD);

    expect(socket.emit).toHaveBeenCalledWith("navigatorError", {
      error: "Reroot failed: no-active-session",
    });
  });
});
