import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const presenceEjection = require("../../services/presenceEjection");
const { createPresenceStore } = require("../../services/canvasPresence");

const ALICE = { userId: "u-alice", displayName: "Ace", picture: null };
const BOB = { userId: "u-bob", displayName: "Bob", picture: null };

function buildFakeIoSocket(id) {
  return {
    id,
    leave: vi.fn(),
    emit: vi.fn(),
  };
}

function buildFakeIo(sockets) {
  const roomEmit = vi.fn();
  return {
    io: {
      sockets: { sockets: new Map(sockets.map((s) => [s.id, s])) },
      to: vi.fn().mockReturnValue({ emit: roomEmit }),
    },
    roomEmit,
  };
}

describe("presenceEjection.ejectUserFromCanvas", () => {
  let store;

  beforeEach(() => {
    store = createPresenceStore();
  });

  it("ejects every socket of the user: leaves room, notifies socket, prunes store, broadcasts presenceLeave", () => {
    const sockA = buildFakeIoSocket("sock-a");
    const sockB = buildFakeIoSocket("sock-b");
    const { io, roomEmit } = buildFakeIo([sockA, sockB]);
    store.join("c-1", ALICE, "sock-a");
    store.join("c-1", ALICE, "sock-b");
    presenceEjection.init({ io, store });

    presenceEjection.ejectUserFromCanvas("c-1", "u-alice");

    for (const sock of [sockA, sockB]) {
      expect(sock.leave).toHaveBeenCalledWith("c-1");
      expect(sock.emit).toHaveBeenCalledWith("canvasAccessRevoked", {
        canvasId: "c-1",
      });
    }
    expect(store.snapshot("c-1")).toEqual([]);
    expect(io.to).toHaveBeenCalledWith("c-1");
    expect(roomEmit).toHaveBeenCalledWith("presenceLeave", {
      canvasId: "c-1",
      userId: "u-alice",
    });
  });

  it("does not touch other users or other canvases", () => {
    const sockA = buildFakeIoSocket("sock-a");
    const sockBob = buildFakeIoSocket("sock-bob");
    const { io } = buildFakeIo([sockA, sockBob]);
    store.join("c-1", ALICE, "sock-a");
    store.join("c-1", BOB, "sock-bob");
    store.join("c-2", ALICE, "sock-a");
    presenceEjection.init({ io, store });

    presenceEjection.ejectUserFromCanvas("c-1", "u-alice");

    expect(sockBob.leave).not.toHaveBeenCalled();
    expect(store.snapshot("c-1")).toEqual([{ ...BOB, viewport: null }]);
    expect(store.snapshot("c-2")).toEqual([{ ...ALICE, viewport: null }]);
  });

  it("does not broadcast when the user is not present on the canvas", () => {
    const { io, roomEmit } = buildFakeIo([]);
    store.join("c-1", BOB, "sock-bob");
    presenceEjection.init({ io, store });

    presenceEjection.ejectUserFromCanvas("c-1", "u-alice");

    expect(roomEmit).not.toHaveBeenCalled();
  });

  it("marks the revocation even when the user has no live sockets, so an in-flight join can see it", () => {
    const { io } = buildFakeIo([]);
    presenceEjection.init({ io, store });

    expect(store.revocationCount("c-1", "u-alice")).toBe(0);
    presenceEjection.ejectUserFromCanvas("c-1", "u-alice");

    expect(store.revocationCount("c-1", "u-alice")).toBe(1);
    expect(store.revocationCount("c-1", "u-bob")).toBe(0);
  });

  it("still prunes the store when a socket already disconnected from io", () => {
    const { io, roomEmit } = buildFakeIo([]);
    store.join("c-1", ALICE, "sock-gone");
    presenceEjection.init({ io, store });

    presenceEjection.ejectUserFromCanvas("c-1", "u-alice");

    expect(store.snapshot("c-1")).toEqual([]);
    expect(roomEmit).toHaveBeenCalledWith("presenceLeave", {
      canvasId: "c-1",
      userId: "u-alice",
    });
  });

  it("warns and does nothing when not initialized", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    presenceEjection.init({ io: null, store: null });

    presenceEjection.ejectUserFromCanvas("c-1", "u-alice");

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
