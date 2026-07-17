import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_IDLE_MS } from "./presence";
import { createRemoteCursorTracker } from "./remoteCursors";

const move = (userId: string, x: number, y: number, canvasId = "c-1") => ({
    canvasId,
    userId,
    x,
    y
});

describe("createRemoteCursorTracker", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const track = (selfId: string | undefined = "u-self") =>
        createRemoteCursorTracker(() => selfId);

    it("adds a cursor for a remote user's move", () => {
        const tracker = track();

        tracker.handleCursorMove(move("u-bob", 10, 20), "c-1");

        expect(tracker.cursors).toEqual([{ userId: "u-bob", x: 10, y: 20, idle: false }]);
    });

    it("updates the existing entry in place on subsequent moves", () => {
        const tracker = track();
        tracker.handleCursorMove(move("u-bob", 10, 20), "c-1");
        const before = tracker.cursors[0];

        tracker.handleCursorMove(move("u-bob", 30, 40), "c-1");

        expect(tracker.cursors).toHaveLength(1);
        expect(tracker.cursors[0]).toBe(before);
        expect(tracker.cursors[0].x).toBe(30);
        expect(tracker.cursors[0].y).toBe(40);
    });

    it("ignores the user's own cursor from another tab", () => {
        const tracker = track("u-self");

        tracker.handleCursorMove(move("u-self", 1, 2), "c-1");

        expect(tracker.cursors).toEqual([]);
    });

    it("ignores moves for a different canvas", () => {
        const tracker = track();

        tracker.handleCursorMove(move("u-bob", 1, 2, "c-other"), "c-1");

        expect(tracker.cursors).toEqual([]);
    });

    it("silently drops malformed payloads", () => {
        const tracker = track();

        tracker.handleCursorMove("garbage", "c-1");
        tracker.handleCursorMove({ canvasId: "c-1", userId: "u-b", x: "1", y: 2 }, "c-1");
        tracker.handleCursorMove(null, "c-1");

        expect(tracker.cursors).toEqual([]);
    });

    it("marks a cursor idle after CURSOR_IDLE_MS without movement", () => {
        const tracker = track();
        tracker.handleCursorMove(move("u-bob", 1, 2), "c-1");

        vi.advanceTimersByTime(CURSOR_IDLE_MS);

        expect(tracker.cursors[0].idle).toBe(true);
    });

    it("movement resets the idle timer and clears the idle flag", () => {
        const tracker = track();
        tracker.handleCursorMove(move("u-bob", 1, 2), "c-1");
        vi.advanceTimersByTime(CURSOR_IDLE_MS - 1);

        tracker.handleCursorMove(move("u-bob", 3, 4), "c-1");
        vi.advanceTimersByTime(CURSOR_IDLE_MS - 1);

        expect(tracker.cursors[0].idle).toBe(false);
        vi.advanceTimersByTime(1);
        expect(tracker.cursors[0].idle).toBe(true);
    });

    it("presenceLeave removes the cursor and its idle timer", () => {
        const tracker = track();
        tracker.handleCursorMove(move("u-bob", 1, 2), "c-1");
        tracker.handleCursorMove(move("u-eve", 3, 4), "c-1");

        tracker.handlePresenceLeave({ canvasId: "c-1", userId: "u-bob" }, "c-1");

        expect(tracker.cursors.map((c) => c.userId)).toEqual(["u-eve"]);
        vi.advanceTimersByTime(CURSOR_IDLE_MS * 2); // stale timer must not throw/resurrect
        expect(tracker.cursors.map((c) => c.userId)).toEqual(["u-eve"]);
    });

    it("presenceLeave for a different canvas is ignored", () => {
        const tracker = track();
        tracker.handleCursorMove(move("u-bob", 1, 2), "c-1");

        tracker.handlePresenceLeave({ canvasId: "c-other", userId: "u-bob" }, "c-1");

        expect(tracker.cursors).toHaveLength(1);
    });

    it("reset clears all cursors and pending idle timers (canvas switch)", () => {
        const tracker = track();
        tracker.handleCursorMove(move("u-bob", 1, 2), "c-1");
        tracker.handleCursorMove(move("u-eve", 3, 4), "c-1");

        tracker.reset();

        expect(tracker.cursors).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("cursors from a previous canvas do not survive reset into the next canvas", () => {
        const tracker = track();
        tracker.handleCursorMove(move("u-bob", 1, 2, "c-1"), "c-1");

        tracker.reset();
        tracker.handleCursorMove(move("u-eve", 5, 6, "c-2"), "c-2");

        expect(tracker.cursors).toEqual([{ userId: "u-eve", x: 5, y: 6, idle: false }]);
    });
});
