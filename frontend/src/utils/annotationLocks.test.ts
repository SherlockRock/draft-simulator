import { describe, expect, it } from "vitest";
import { createAnnotationLockTracker } from "./annotationLocks";

const change = (annotationId: string, userId: string | null, canvasId = "c-1") => ({
    canvasId,
    annotationId,
    userId
});

describe("createAnnotationLockTracker", () => {
    const track = (selfId: string | undefined = "u-self") =>
        createAnnotationLockTracker(() => selfId);

    it("seeds locks from a snapshot", () => {
        const tracker = track();

        tracker.handleSnapshot([{ annotationId: "note-1", userId: "u-bob" }]);

        expect(tracker.lockedBy("note-1")).toBe("u-bob");
    });

    it("replaces previous state with a snapshot", () => {
        const tracker = track();
        tracker.handleLockChanged(change("note-old", "u-carol"), "c-1");

        tracker.handleSnapshot([{ annotationId: "note-1", userId: "u-bob" }]);

        expect(tracker.lockedBy("note-old")).toBeUndefined();
        expect(tracker.lockedBy("note-1")).toBe("u-bob");
    });

    it("filters the user's own locks from snapshots and changes", () => {
        const tracker = track("u-self");

        tracker.handleSnapshot([{ annotationId: "note-1", userId: "u-self" }]);
        tracker.handleLockChanged(change("note-2", "u-self"), "c-1");

        expect(tracker.lockedBy("note-1")).toBeUndefined();
        expect(tracker.lockedBy("note-2")).toBeUndefined();
    });

    it("ignores lock changes for another canvas", () => {
        const tracker = track();

        tracker.handleLockChanged(change("note-1", "u-bob", "c-other"), "c-1");

        expect(tracker.lockedBy("note-1")).toBeUndefined();
    });

    it("removes a lock when its holder becomes null", () => {
        const tracker = track();
        tracker.handleLockChanged(change("note-1", "u-bob"), "c-1");

        tracker.handleLockChanged(change("note-1", null), "c-1");

        expect(tracker.lockedBy("note-1")).toBeUndefined();
    });

    it("silently ignores malformed changes", () => {
        const tracker = track();

        tracker.handleLockChanged(null, "c-1");
        tracker.handleLockChanged({ canvasId: "c-1", annotationId: "note-1" }, "c-1");
        tracker.handleLockChanged(
            { canvasId: "c-1", annotationId: "note-1", userId: 42 },
            "c-1"
        );

        expect(tracker.lockedBy("note-1")).toBeUndefined();
    });

    it("reset clears all locks", () => {
        const tracker = track();
        tracker.handleSnapshot([
            { annotationId: "note-1", userId: "u-bob" },
            { annotationId: "note-2", userId: "u-carol" }
        ]);

        tracker.reset();

        expect(tracker.lockedBy("note-1")).toBeUndefined();
        expect(tracker.lockedBy("note-2")).toBeUndefined();
    });
});
