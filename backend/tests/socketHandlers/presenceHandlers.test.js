import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { UserCanvas } = require("../../models/Canvas");
const { setupPresenceHandlers } = require("../../socketHandlers/presenceHandlers");
const { createPresenceStore } = require("../../services/canvasPresence");

const ALICE_ROW = {
  id: "u-alice",
  name: "Alice",
  display_name: "Ace",
  picture: "alice.png",
  email: "alice@example.com",
};

function buildFakeSocket(overrides = {}) {
  const handlers = new Map();
  const roomEmit = vi.fn();
  const socket = {
    id: overrides.id || "sock-1",
    user: "user" in overrides ? overrides.user : { dataValues: ALICE_ROW },
    emit: vi.fn(),
    join: vi.fn(),
    leave: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: roomEmit }),
    on: vi.fn((event, fn) => {
      handlers.set(event, fn);
    }),
  };
  return { socket, handlers, roomEmit };
}

function wrapSocketHandler(socket, eventName, handler) {
  socket.on(eventName, handler);
}

function installHandlers(overrides = {}, store = createPresenceStore()) {
  const { socket, handlers, roomEmit } = buildFakeSocket(overrides);
  setupPresenceHandlers(socket, store, wrapSocketHandler);
  return { socket, handlers, roomEmit, store };
}

// Presence payload derived from ALICE_ROW: display_name wins, email excluded.
const ALICE_PRESENCE = {
  userId: "u-alice",
  displayName: "Ace",
  picture: "alice.png",
};

function mockAccess(permissions) {
  vi.spyOn(UserCanvas, "findOne").mockResolvedValue(
    permissions ? { permissions } : null,
  );
}

beforeEach(() => {
  mockAccess("view");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setupPresenceHandlers", () => {
  it("registers joinCanvas, leaveCanvas and disconnecting", () => {
    const { handlers } = installHandlers();
    expect([...handlers.keys()].sort()).toEqual([
      "disconnecting",
      "joinCanvas",
      "leaveCanvas",
    ]);
  });

  it("joinCanvas with view access joins the room, broadcasts presenceJoin and returns a snapshot", async () => {
    const { socket, handlers, roomEmit } = installHandlers();

    await handlers.get("joinCanvas")({ canvasId: "c-1" });

    expect(socket.join).toHaveBeenCalledWith("c-1");
    expect(socket.to).toHaveBeenCalledWith("c-1");
    expect(roomEmit).toHaveBeenCalledWith("presenceJoin", {
      canvasId: "c-1",
      user: ALICE_PRESENCE,
    });
    expect(socket.emit).toHaveBeenCalledWith("presenceSnapshot", {
      canvasId: "c-1",
      users: [ALICE_PRESENCE],
    });
  });

  it("presence payload never contains the email", async () => {
    const { socket, handlers } = installHandlers();

    await handlers.get("joinCanvas")({ canvasId: "c-1" });

    const [, snapshot] = socket.emit.mock.calls.find(
      ([event]) => event === "presenceSnapshot",
    );
    for (const user of snapshot.users) {
      expect(user).not.toHaveProperty("email");
    }
  });

  it("falls back to name when display_name is null", async () => {
    const { socket, handlers } = installHandlers({
      user: { dataValues: { ...ALICE_ROW, display_name: null } },
    });

    await handlers.get("joinCanvas")({ canvasId: "c-1" });

    expect(socket.emit).toHaveBeenCalledWith("presenceSnapshot", {
      canvasId: "c-1",
      users: [{ ...ALICE_PRESENCE, displayName: "Alice" }],
    });
  });

  it("an anonymous socket gets NOT_AUTHENTICATED and does not join", async () => {
    const { socket, handlers } = installHandlers({ user: undefined });

    await handlers.get("joinCanvas")({ canvasId: "c-1" });

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "joinCanvas",
      code: "NOT_AUTHENTICATED",
      message: "Authentication required",
    });
  });

  it("a user without access gets NOT_AUTHORIZED and does not join", async () => {
    mockAccess(null);
    const { socket, handlers, roomEmit } = installHandlers();

    await handlers.get("joinCanvas")({ canvasId: "c-1" });

    expect(socket.join).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith("canvasMutationError", {
      event: "joinCanvas",
      code: "NOT_AUTHORIZED",
      message: "Not authorized",
    });
  });

  it("joinCanvas without a canvasId is an INVALID_MUTATION", async () => {
    const { socket, handlers } = installHandlers();

    await handlers.get("joinCanvas")({});

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "canvasMutationError",
      expect.objectContaining({ event: "joinCanvas", code: "INVALID_MUTATION" }),
    );
  });

  it("a second socket of the same user joins the room without re-broadcasting presenceJoin", async () => {
    const store = createPresenceStore();
    const first = installHandlers({ id: "sock-1" }, store);
    const second = installHandlers({ id: "sock-2" }, store);

    await first.handlers.get("joinCanvas")({ canvasId: "c-1" });
    await second.handlers.get("joinCanvas")({ canvasId: "c-1" });

    expect(second.socket.join).toHaveBeenCalledWith("c-1");
    expect(second.roomEmit).not.toHaveBeenCalled();
    expect(second.socket.emit).toHaveBeenCalledWith("presenceSnapshot", {
      canvasId: "c-1",
      users: [ALICE_PRESENCE],
    });
  });

  it("leaveCanvas leaves the room and broadcasts presenceLeave when the last socket departs", async () => {
    const { socket, handlers, roomEmit } = installHandlers();
    await handlers.get("joinCanvas")({ canvasId: "c-1" });
    roomEmit.mockClear();

    await handlers.get("leaveCanvas")({ canvasId: "c-1" });

    expect(socket.leave).toHaveBeenCalledWith("c-1");
    expect(roomEmit).toHaveBeenCalledWith("presenceLeave", {
      canvasId: "c-1",
      userId: "u-alice",
    });
  });

  it("leaveCanvas does not broadcast while another socket of the user remains", async () => {
    const store = createPresenceStore();
    const first = installHandlers({ id: "sock-1" }, store);
    const second = installHandlers({ id: "sock-2" }, store);
    await first.handlers.get("joinCanvas")({ canvasId: "c-1" });
    await second.handlers.get("joinCanvas")({ canvasId: "c-1" });

    await first.handlers.get("leaveCanvas")({ canvasId: "c-1" });

    expect(first.socket.leave).toHaveBeenCalledWith("c-1");
    const leaveEvents = first.roomEmit.mock.calls.filter(
      ([event]) => event === "presenceLeave",
    );
    expect(leaveEvents).toEqual([]);
  });

  it("disconnecting broadcasts presenceLeave for every canvas the socket departed", async () => {
    const { handlers, roomEmit } = installHandlers();
    await handlers.get("joinCanvas")({ canvasId: "c-1" });
    await handlers.get("joinCanvas")({ canvasId: "c-2" });
    roomEmit.mockClear();

    handlers.get("disconnecting")();

    expect(roomEmit).toHaveBeenCalledWith("presenceLeave", {
      canvasId: "c-1",
      userId: "u-alice",
    });
    expect(roomEmit).toHaveBeenCalledWith("presenceLeave", {
      canvasId: "c-2",
      userId: "u-alice",
    });
  });

  it("unexpected errors are logged, not emitted", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(UserCanvas, "findOne").mockRejectedValue(new Error("db exploded"));
    const { socket, handlers } = installHandlers();

    await handlers.get("joinCanvas")({ canvasId: "c-1" });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
