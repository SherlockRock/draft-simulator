import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPresenceStore } = require("../../services/canvasPresence");

const ALICE = { userId: "u-alice", displayName: "Alice", picture: "a.png" };
const BOB = { userId: "u-bob", displayName: "Bob", picture: null };

// Snapshot entries carry the last-known viewport (null until the user's
// client first broadcasts one).
const ALICE_SNAP = { ...ALICE, viewport: null };
const BOB_SNAP = { ...BOB, viewport: null };

let store;

beforeEach(() => {
  store = createPresenceStore();
});

describe("createPresenceStore", () => {
  it("join reports a newly present user and snapshot lists them", () => {
    const joined = store.join("c-1", ALICE, "sock-1");

    expect(joined).toBe(true);
    expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
  });

  it("a second socket for the same user does not re-join presence", () => {
    store.join("c-1", ALICE, "sock-1");
    const joined = store.join("c-1", ALICE, "sock-2");

    expect(joined).toBe(false);
    expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
  });

  it("re-joining with the same socket is idempotent", () => {
    store.join("c-1", ALICE, "sock-1");
    const joined = store.join("c-1", ALICE, "sock-1");

    expect(joined).toBe(false);
    expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
  });

  it("re-joining refreshes the stored user payload", () => {
    store.join("c-1", ALICE, "sock-1");
    const renamed = { ...ALICE, displayName: "Alice Prime" };
    store.join("c-1", renamed, "sock-2");

    expect(store.snapshot("c-1")).toEqual([{ ...renamed, viewport: null }]);
  });

  it("leave reports departure only when the last socket leaves", () => {
    store.join("c-1", ALICE, "sock-1");
    store.join("c-1", ALICE, "sock-2");

    expect(store.leave("c-1", ALICE.userId, "sock-1")).toBe(false);
    expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);

    expect(store.leave("c-1", ALICE.userId, "sock-2")).toBe(true);
    expect(store.snapshot("c-1")).toEqual([]);
  });

  it("leave of an unknown user or canvas is a no-op", () => {
    expect(store.leave("c-none", "u-none", "sock-1")).toBe(false);
    store.join("c-1", ALICE, "sock-1");
    expect(store.leave("c-1", BOB.userId, "sock-1")).toBe(false);
  });

  it("users are scoped per canvas", () => {
    store.join("c-1", ALICE, "sock-1");
    store.join("c-2", BOB, "sock-2");

    expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
    expect(store.snapshot("c-2")).toEqual([BOB_SNAP]);
  });

  it("leaveAll removes a socket from every canvas and reports departures", () => {
    store.join("c-1", ALICE, "sock-1");
    store.join("c-2", ALICE, "sock-1");
    store.join("c-1", ALICE, "sock-other");

    const departures = store.leaveAll("sock-1");

    expect(departures).toEqual([
      { canvasId: "c-1", userId: ALICE.userId, departed: false },
      { canvasId: "c-2", userId: ALICE.userId, departed: true },
    ]);
    expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
    expect(store.snapshot("c-2")).toEqual([]);
  });

  it("leaveAll for an untracked socket returns no departures", () => {
    expect(store.leaveAll("sock-ghost")).toEqual([]);
  });

  it("snapshot of an empty canvas is an empty array", () => {
    expect(store.snapshot("c-none")).toEqual([]);
  });

  describe("last-known viewport", () => {
    const VIEWPORT = { x: 120.5, y: -40, zoom: 1.5 };

    it("setViewport stores the viewport and snapshot carries it", () => {
      store.join("c-1", ALICE, "sock-1");

      expect(store.setViewport("c-1", ALICE.userId, VIEWPORT)).toBe(true);
      expect(store.snapshot("c-1")).toEqual([{ ...ALICE, viewport: VIEWPORT }]);
    });

    it("setViewport for an unknown user or canvas is a no-op", () => {
      expect(store.setViewport("c-none", ALICE.userId, VIEWPORT)).toBe(false);
      store.join("c-1", ALICE, "sock-1");
      expect(store.setViewport("c-1", BOB.userId, VIEWPORT)).toBe(false);
      expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
    });

    it("clearViewport resets the viewport to null", () => {
      store.join("c-1", ALICE, "sock-1");
      store.setViewport("c-1", ALICE.userId, VIEWPORT);

      store.clearViewport("c-1", ALICE.userId);

      expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
    });

    it("clearViewport for an unknown user or canvas is a no-op", () => {
      expect(() => store.clearViewport("c-none", ALICE.userId)).not.toThrow();
    });

    it("a second socket joining preserves the stored viewport", () => {
      store.join("c-1", ALICE, "sock-1");
      store.setViewport("c-1", ALICE.userId, VIEWPORT);

      store.join("c-1", ALICE, "sock-2");

      expect(store.snapshot("c-1")).toEqual([{ ...ALICE, viewport: VIEWPORT }]);
    });

    it("the viewport does not survive a full departure and re-join", () => {
      store.join("c-1", ALICE, "sock-1");
      store.setViewport("c-1", ALICE.userId, VIEWPORT);
      store.leave("c-1", ALICE.userId, "sock-1");

      store.join("c-1", ALICE, "sock-1");

      expect(store.snapshot("c-1")).toEqual([ALICE_SNAP]);
    });

    it("viewports are scoped per canvas", () => {
      store.join("c-1", ALICE, "sock-1");
      store.join("c-2", ALICE, "sock-1");
      store.setViewport("c-1", ALICE.userId, VIEWPORT);

      expect(store.snapshot("c-1")).toEqual([{ ...ALICE, viewport: VIEWPORT }]);
      expect(store.snapshot("c-2")).toEqual([ALICE_SNAP]);
    });
  });
});
