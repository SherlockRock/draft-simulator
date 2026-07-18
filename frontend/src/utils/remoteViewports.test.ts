import { describe, expect, it } from "vitest";
import { createRemoteViewportTracker } from "./remoteViewports";

const move = (
    userId: string,
    x: number,
    y: number,
    zoom: number,
    canvasId = "c-1"
) => ({ canvasId, userId, x, y, zoom });

const leave = (userId: string, canvasId = "c-1") => ({ canvasId, userId });

describe("createRemoteViewportTracker", () => {
    const track = (selfId: string | undefined = "u-self") =>
        createRemoteViewportTracker(() => selfId);

    it("records a remote user's viewport move", () => {
        const tracker = track();

        tracker.handleViewportMove(move("u-bob", 10, 20, 1.5), "c-1");

        expect(tracker.viewportOf("u-bob")).toEqual({ x: 10, y: 20, zoom: 1.5 });
    });

    it("keeps only the latest viewport per user", () => {
        const tracker = track();
        tracker.handleViewportMove(move("u-bob", 10, 20, 1.5), "c-1");

        tracker.handleViewportMove(move("u-bob", 30, 40, 0.5), "c-1");

        expect(tracker.viewportOf("u-bob")).toEqual({ x: 30, y: 40, zoom: 0.5 });
    });

    it("ignores the user's own viewport from another tab", () => {
        const tracker = track("u-self");

        tracker.handleViewportMove(move("u-self", 1, 2, 1), "c-1");

        expect(tracker.viewportOf("u-self")).toBeUndefined();
    });

    it("ignores moves for a different canvas", () => {
        const tracker = track();

        tracker.handleViewportMove(move("u-bob", 1, 2, 1, "c-other"), "c-1");

        expect(tracker.viewportOf("u-bob")).toBeUndefined();
    });

    it("silently drops malformed payloads", () => {
        const tracker = track();

        tracker.handleViewportMove(null, "c-1");
        tracker.handleViewportMove({ canvasId: "c-1", userId: "u-bob" }, "c-1");
        tracker.handleViewportMove(move("u-bob", NaN, 2, 1), "c-1");
        tracker.handleViewportMove(move("u-bob", 1, 2, 0), "c-1");

        expect(tracker.viewportOf("u-bob")).toBeUndefined();
    });

    it("handleViewportLeave forgets the user's viewport", () => {
        const tracker = track();
        tracker.handleViewportMove(move("u-bob", 1, 2, 1), "c-1");

        tracker.handleViewportLeave(leave("u-bob"), "c-1");

        expect(tracker.viewportOf("u-bob")).toBeUndefined();
    });

    it("handleViewportLeave ignores other canvases and malformed payloads", () => {
        const tracker = track();
        tracker.handleViewportMove(move("u-bob", 1, 2, 1), "c-1");

        tracker.handleViewportLeave(leave("u-bob", "c-other"), "c-1");
        tracker.handleViewportLeave(null, "c-1");
        tracker.handleViewportLeave({ canvasId: "c-1" }, "c-1");

        expect(tracker.viewportOf("u-bob")).toEqual({ x: 1, y: 2, zoom: 1 });
    });

    it("handleSnapshot seeds viewports for users that have one", () => {
        const tracker = track();

        tracker.handleSnapshot([
            { userId: "u-bob", viewport: { x: 1, y: 2, zoom: 1 } },
            { userId: "u-carol", viewport: null }
        ]);

        expect(tracker.viewportOf("u-bob")).toEqual({ x: 1, y: 2, zoom: 1 });
        expect(tracker.viewportOf("u-carol")).toBeUndefined();
    });

    it("handleSnapshot replaces previous state wholesale", () => {
        const tracker = track();
        tracker.handleViewportMove(move("u-old", 9, 9, 9), "c-1");

        tracker.handleSnapshot([
            { userId: "u-bob", viewport: { x: 1, y: 2, zoom: 1 } }
        ]);

        expect(tracker.viewportOf("u-old")).toBeUndefined();
        expect(tracker.viewportOf("u-bob")).toEqual({ x: 1, y: 2, zoom: 1 });
    });

    it("handleSnapshot never records the user's own viewport", () => {
        const tracker = track("u-self");

        tracker.handleSnapshot([
            { userId: "u-self", viewport: { x: 1, y: 2, zoom: 1 } }
        ]);

        expect(tracker.viewportOf("u-self")).toBeUndefined();
    });

    it("reset clears all viewports", () => {
        const tracker = track();
        tracker.handleViewportMove(move("u-bob", 1, 2, 1), "c-1");
        tracker.handleViewportMove(move("u-carol", 3, 4, 2), "c-1");

        tracker.reset();

        expect(tracker.viewportOf("u-bob")).toBeUndefined();
        expect(tracker.viewportOf("u-carol")).toBeUndefined();
    });
});
