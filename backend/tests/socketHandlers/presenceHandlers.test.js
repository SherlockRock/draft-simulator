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
    rooms: new Set([overrides.id || "sock-1"]),
    emit: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: roomEmit }),
    on: vi.fn((event, fn) => {
      handlers.set(event, fn);
    }),
  };
  socket.join = vi.fn((room) => {
    socket.rooms.add(room);
  });
  socket.leave = vi.fn((room) => {
    socket.rooms.delete(room);
  });
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

// Snapshot entries additionally carry the last-known viewport (slice 4).
const ALICE_SNAPSHOT = { ...ALICE_PRESENCE, viewport: null };

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
      "cursorLeave",
      "cursorMove",
      "disconnecting",
      "joinCanvas",
      "leaveCanvas",
      "viewportLeave",
      "viewportMove",
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
      users: [ALICE_SNAPSHOT],
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
      users: [{ ...ALICE_SNAPSHOT, displayName: "Alice" }],
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

  it("joinCanvas with a non-string canvasId is an INVALID_MUTATION", async () => {
    const { socket, handlers } = installHandlers();

    await handlers.get("joinCanvas")({ canvasId: { nested: true } });

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith(
      "canvasMutationError",
      expect.objectContaining({ event: "joinCanvas", code: "INVALID_MUTATION" }),
    );
  });

  it("displayName falls back to 'Unknown' when display_name and name are blank", async () => {
    const { socket, handlers } = installHandlers({
      user: { dataValues: { ...ALICE_ROW, display_name: null, name: "" } },
    });

    await handlers.get("joinCanvas")({ canvasId: "c-1" });

    expect(socket.emit).toHaveBeenCalledWith("presenceSnapshot", {
      canvasId: "c-1",
      users: [{ ...ALICE_SNAPSHOT, displayName: "Unknown" }],
    });
  });

  it("a revocation processed during the pending access check cancels the join", async () => {
    let releaseAccessCheck;
    vi.spyOn(UserCanvas, "findOne").mockReturnValue(
      new Promise((resolve) => {
        releaseAccessCheck = () => resolve({ permissions: "view" });
      }),
    );
    const { socket, handlers, roomEmit, store } = installHandlers();

    const pendingJoin = handlers.get("joinCanvas")({ canvasId: "c-1" });
    // Revocation lands while the ACL lookup is in flight: the lookup read
    // the pre-delete row, so its stale success must not grant room entry.
    store.markRevoked("c-1", "u-alice");
    releaseAccessCheck();
    await pendingJoin;

    expect(socket.join).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
    expect(store.snapshot("c-1")).toEqual([]);
    expect(socket.emit).toHaveBeenCalledWith(
      "canvasMutationError",
      expect.objectContaining({ event: "joinCanvas", code: "NOT_AUTHORIZED" }),
    );
  });

  it("a revocation on a different canvas does not cancel the join", async () => {
    let releaseAccessCheck;
    vi.spyOn(UserCanvas, "findOne").mockReturnValue(
      new Promise((resolve) => {
        releaseAccessCheck = () => resolve({ permissions: "view" });
      }),
    );
    const { socket, handlers, store } = installHandlers();

    const pendingJoin = handlers.get("joinCanvas")({ canvasId: "c-1" });
    store.markRevoked("c-2", "u-alice");
    releaseAccessCheck();
    await pendingJoin;

    expect(socket.join).toHaveBeenCalledWith("c-1");
  });

  it("a leaveCanvas processed during the pending access check cancels the join", async () => {
    let releaseAccessCheck;
    vi.spyOn(UserCanvas, "findOne").mockReturnValue(
      new Promise((resolve) => {
        releaseAccessCheck = () => resolve({ permissions: "view" });
      }),
    );
    const { socket, handlers, roomEmit, store } = installHandlers();

    const pendingJoin = handlers.get("joinCanvas")({ canvasId: "c-1" });
    await handlers.get("leaveCanvas")({ canvasId: "c-1" });
    releaseAccessCheck();
    await pendingJoin;

    expect(socket.join).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
    expect(store.snapshot("c-1")).toEqual([]);
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
      users: [ALICE_SNAPSHOT],
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

  describe("cursorMove relay", () => {
    async function joinedSocket(overrides = {}) {
      const installed = installHandlers(overrides);
      await installed.handlers.get("joinCanvas")({ canvasId: "c-1" });
      installed.socket.to.mockClear();
      installed.roomEmit.mockClear();
      vi.mocked(UserCanvas.findOne).mockClear();
      return installed;
    }

    it("relays cursorMove to the room excluding the sender", async () => {
      const { socket, handlers, roomEmit } = await joinedSocket();

      await handlers.get("cursorMove")({ canvasId: "c-1", x: 120.5, y: -40 });

      expect(socket.to).toHaveBeenCalledWith("c-1");
      expect(roomEmit).toHaveBeenCalledWith("cursorMove", {
        canvasId: "c-1",
        userId: "u-alice",
        x: 120.5,
        y: -40,
      });
    });

    it("does not hit the database", async () => {
      const { handlers } = await joinedSocket();

      await handlers.get("cursorMove")({ canvasId: "c-1", x: 1, y: 2 });

      expect(UserCanvas.findOne).not.toHaveBeenCalled();
    });

    it("stamps the sender's userId, ignoring one supplied by the client", async () => {
      const { handlers, roomEmit } = await joinedSocket();

      await handlers.get("cursorMove")({
        canvasId: "c-1",
        userId: "u-spoofed",
        x: 1,
        y: 2,
      });

      expect(roomEmit).toHaveBeenCalledWith("cursorMove", {
        canvasId: "c-1",
        userId: "u-alice",
        x: 1,
        y: 2,
      });
    });

    it("drops the event when the socket is not in the room", async () => {
      const { socket, handlers, roomEmit } = installHandlers();

      await handlers.get("cursorMove")({ canvasId: "c-1", x: 1, y: 2 });

      expect(socket.to).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalled();
    });

    it("stops relaying after leaveCanvas", async () => {
      const { handlers, roomEmit } = await joinedSocket();
      await handlers.get("leaveCanvas")({ canvasId: "c-1" });
      roomEmit.mockClear();

      await handlers.get("cursorMove")({ canvasId: "c-1", x: 1, y: 2 });

      expect(roomEmit).not.toHaveBeenCalled();
    });

    it("drops events with a missing or non-string canvasId", async () => {
      const { socket, handlers } = await joinedSocket();

      await handlers.get("cursorMove")({ x: 1, y: 2 });
      await handlers.get("cursorMove")({ canvasId: { nested: true }, x: 1, y: 2 });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it("drops events with non-finite coordinates", async () => {
      const { socket, handlers } = await joinedSocket();

      await handlers.get("cursorMove")({ canvasId: "c-1", x: "12", y: 2 });
      await handlers.get("cursorMove")({ canvasId: "c-1", x: 1 });
      await handlers.get("cursorMove")({ canvasId: "c-1", x: Infinity, y: 2 });
      await handlers.get("cursorMove")({ canvasId: "c-1", x: NaN, y: 2 });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it("drops events from a socket without a user", async () => {
      const { socket, handlers } = installHandlers({ user: undefined });
      socket.rooms.add("c-1");

      await handlers.get("cursorMove")({ canvasId: "c-1", x: 1, y: 2 });

      expect(socket.to).not.toHaveBeenCalled();
    });
  });

  describe("cursorLeave relay", () => {
    async function joinedSocket(overrides = {}) {
      const installed = installHandlers(overrides);
      await installed.handlers.get("joinCanvas")({ canvasId: "c-1" });
      installed.socket.to.mockClear();
      installed.roomEmit.mockClear();
      vi.mocked(UserCanvas.findOne).mockClear();
      return installed;
    }

    it("relays cursorLeave to the room with the sender's userId stamped", async () => {
      const { socket, handlers, roomEmit } = await joinedSocket();

      await handlers.get("cursorLeave")({ canvasId: "c-1", userId: "u-spoofed" });

      expect(socket.to).toHaveBeenCalledWith("c-1");
      expect(roomEmit).toHaveBeenCalledWith("cursorLeave", {
        canvasId: "c-1",
        userId: "u-alice",
      });
      expect(UserCanvas.findOne).not.toHaveBeenCalled();
    });

    it("drops the event when the socket is not in the room", async () => {
      const { socket, handlers, roomEmit } = installHandlers();

      await handlers.get("cursorLeave")({ canvasId: "c-1" });

      expect(socket.to).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalled();
    });

    it("drops events with a missing or non-string canvasId", async () => {
      const { socket, handlers } = await joinedSocket();

      await handlers.get("cursorLeave")({});
      await handlers.get("cursorLeave")({ canvasId: { nested: true } });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it("drops events from a socket without a user", async () => {
      const { socket, handlers } = installHandlers({ user: undefined });
      socket.rooms.add("c-1");

      await handlers.get("cursorLeave")({ canvasId: "c-1" });

      expect(socket.to).not.toHaveBeenCalled();
    });
  });

  describe("viewportMove relay", () => {
    async function joinedSocket(overrides = {}, store = createPresenceStore()) {
      const installed = installHandlers(overrides, store);
      await installed.handlers.get("joinCanvas")({ canvasId: "c-1" });
      installed.socket.to.mockClear();
      installed.roomEmit.mockClear();
      vi.mocked(UserCanvas.findOne).mockClear();
      return installed;
    }

    it("relays viewportMove to the room with the sender's userId stamped", async () => {
      const { socket, handlers, roomEmit } = await joinedSocket();

      await handlers.get("viewportMove")({
        canvasId: "c-1",
        userId: "u-spoofed",
        x: 120.5,
        y: -40,
        zoom: 1.5,
      });

      expect(socket.to).toHaveBeenCalledWith("c-1");
      expect(roomEmit).toHaveBeenCalledWith("viewportMove", {
        canvasId: "c-1",
        userId: "u-alice",
        x: 120.5,
        y: -40,
        zoom: 1.5,
      });
      expect(UserCanvas.findOne).not.toHaveBeenCalled();
    });

    it("stores the last-known viewport so later snapshots carry it", async () => {
      const store = createPresenceStore();
      const { handlers } = await joinedSocket({}, store);

      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: 2, zoom: 0.5 });

      expect(store.snapshot("c-1")).toEqual([
        { ...ALICE_PRESENCE, viewport: { x: 1, y: 2, zoom: 0.5 } },
      ]);
    });

    it("drops the event when the socket is not in the room", async () => {
      const { socket, handlers, roomEmit } = installHandlers();

      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: 2, zoom: 1 });

      expect(socket.to).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalled();
    });

    it("drops events with a missing or non-string canvasId", async () => {
      const { socket, handlers } = await joinedSocket();

      await handlers.get("viewportMove")({ x: 1, y: 2, zoom: 1 });
      await handlers.get("viewportMove")({
        canvasId: { nested: true },
        x: 1,
        y: 2,
        zoom: 1,
      });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it("drops events with non-finite or missing coordinates", async () => {
      const { socket, handlers } = await joinedSocket();

      await handlers.get("viewportMove")({ canvasId: "c-1", x: "12", y: 2, zoom: 1 });
      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: 2 });
      await handlers.get("viewportMove")({
        canvasId: "c-1",
        x: Infinity,
        y: 2,
        zoom: 1,
      });
      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: NaN, zoom: 1 });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it("drops events with a non-positive zoom", async () => {
      const { socket, handlers } = await joinedSocket();

      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: 2, zoom: 0 });
      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: 2, zoom: -1 });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it("drops events from a socket without a user", async () => {
      const { socket, handlers } = installHandlers({ user: undefined });
      socket.rooms.add("c-1");

      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: 2, zoom: 1 });

      expect(socket.to).not.toHaveBeenCalled();
    });
  });

  describe("viewportLeave relay", () => {
    async function joinedSocket(overrides = {}, store = createPresenceStore()) {
      const installed = installHandlers(overrides, store);
      await installed.handlers.get("joinCanvas")({ canvasId: "c-1" });
      installed.socket.to.mockClear();
      installed.roomEmit.mockClear();
      vi.mocked(UserCanvas.findOne).mockClear();
      return installed;
    }

    it("relays viewportLeave with the sender's userId stamped and clears the stored viewport", async () => {
      const store = createPresenceStore();
      const { socket, handlers, roomEmit } = await joinedSocket({}, store);
      await handlers.get("viewportMove")({ canvasId: "c-1", x: 1, y: 2, zoom: 1 });
      roomEmit.mockClear();

      await handlers.get("viewportLeave")({ canvasId: "c-1", userId: "u-spoofed" });

      expect(socket.to).toHaveBeenCalledWith("c-1");
      expect(roomEmit).toHaveBeenCalledWith("viewportLeave", {
        canvasId: "c-1",
        userId: "u-alice",
      });
      expect(store.snapshot("c-1")).toEqual([ALICE_SNAPSHOT]);
      expect(UserCanvas.findOne).not.toHaveBeenCalled();
    });

    it("drops the event when the socket is not in the room", async () => {
      const { socket, handlers, roomEmit } = installHandlers();

      await handlers.get("viewportLeave")({ canvasId: "c-1" });

      expect(socket.to).not.toHaveBeenCalled();
      expect(roomEmit).not.toHaveBeenCalled();
    });

    it("drops events with a missing or non-string canvasId", async () => {
      const { socket, handlers } = await joinedSocket();

      await handlers.get("viewportLeave")({});
      await handlers.get("viewportLeave")({ canvasId: { nested: true } });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it("drops events from a socket without a user", async () => {
      const { socket, handlers } = installHandlers({ user: undefined });
      socket.rooms.add("c-1");

      await handlers.get("viewportLeave")({ canvasId: "c-1" });

      expect(socket.to).not.toHaveBeenCalled();
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
