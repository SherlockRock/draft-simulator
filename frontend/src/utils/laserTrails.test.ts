import { describe, expect, it } from "vitest";
import { LASER_FADE_MS, LASER_MAX_POINTS } from "./presence";
import { createLaserTrailTracker } from "./laserTrails";

const point = (userId: string, x: number, y: number, canvasId = "c-1") => ({
    canvasId,
    userId,
    x,
    y
});

const end = (userId: string, canvasId = "c-1") => ({ canvasId, userId });

// Deterministic injectable clock.
function makeClock(start = 1000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms: number) => {
            t += ms;
        }
    };
}

const track = (selfId: string | undefined = "u-self", clock = makeClock()) => ({
    tracker: createLaserTrailTracker(() => selfId, clock.now),
    clock
});

describe("createLaserTrailTracker", () => {
    it("starts a stroke on a remote user's first laserPoint", () => {
        const { tracker } = track();

        tracker.handleLaserPoint(point("u-bob", 10, 20), "c-1");

        expect(tracker.trails["u-bob"].strokes).toEqual([[{ x: 10, y: 20, t: 1000 }]]);
    });

    it("appends subsequent points to the same open stroke", () => {
        const { tracker, clock } = track();
        tracker.handleLaserPoint(point("u-bob", 10, 20), "c-1");
        clock.advance(35);

        tracker.handleLaserPoint(point("u-bob", 30, 40), "c-1");

        expect(tracker.trails["u-bob"].strokes).toEqual([
            [
                { x: 10, y: 20, t: 1000 },
                { x: 30, y: 40, t: 1035 }
            ]
        ]);
    });

    it("keeps per-user trails independent", () => {
        const { tracker } = track();

        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");
        tracker.handleLaserPoint(point("u-eve", 3, 4), "c-1");

        expect(Object.keys(tracker.trails).sort()).toEqual(["u-bob", "u-eve"]);
        expect(tracker.trails["u-bob"].strokes[0]).toHaveLength(1);
        expect(tracker.trails["u-eve"].strokes[0]).toHaveLength(1);
    });

    it("laserEnd closes the stroke so the next point starts a new one", () => {
        const { tracker } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");

        tracker.handleLaserEnd(end("u-bob"), "c-1");
        tracker.handleLaserPoint(point("u-bob", 5, 6), "c-1");

        expect(tracker.trails["u-bob"].strokes).toHaveLength(2);
        expect(tracker.trails["u-bob"].strokes[1]).toEqual([{ x: 5, y: 6, t: 1000 }]);
    });

    it("laserEnd for a user without a trail is a no-op", () => {
        const { tracker } = track();

        tracker.handleLaserEnd(end("u-bob"), "c-1");

        expect(tracker.trails["u-bob"]).toBeUndefined();
    });

    it("ignores the user's own events from another tab", () => {
        const { tracker } = track("u-self");

        tracker.handleLaserPoint(point("u-self", 1, 2), "c-1");
        tracker.handleLaserEnd(end("u-self"), "c-1");

        expect(tracker.trails["u-self"]).toBeUndefined();
    });

    it("ignores events for a different canvas", () => {
        const { tracker } = track();

        tracker.handleLaserPoint(point("u-bob", 1, 2, "c-other"), "c-1");
        tracker.handleLaserEnd(end("u-bob", "c-other"), "c-1");

        expect(tracker.trails["u-bob"]).toBeUndefined();
    });

    it("silently drops malformed payloads", () => {
        const { tracker } = track();

        tracker.handleLaserPoint("garbage", "c-1");
        tracker.handleLaserPoint({ canvasId: "c-1", userId: "u-b", x: "1", y: 2 }, "c-1");
        tracker.handleLaserPoint(null, "c-1");
        tracker.handleLaserEnd("garbage", "c-1");

        expect(tracker.trails).toEqual({});
    });

    it("addLocalPoint and endLocalStroke track under the user's own id", () => {
        const { tracker } = track("u-self");

        tracker.addLocalPoint(1, 2);
        tracker.endLocalStroke();
        tracker.addLocalPoint(3, 4);

        expect(tracker.trails["u-self"].strokes).toEqual([
            [{ x: 1, y: 2, t: 1000 }],
            [{ x: 3, y: 4, t: 1000 }]
        ]);
    });

    it("addLocalPoint is a no-op while the user is unknown", () => {
        // Constructed directly: passing undefined through track() would
        // trigger its "u-self" default parameter.
        const tracker = createLaserTrailTracker(() => undefined, makeClock().now);

        tracker.addLocalPoint(1, 2);

        expect(tracker.trails).toEqual({});
    });

    it("prune drops points older than LASER_FADE_MS and removes emptied users", () => {
        const { tracker, clock } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");
        clock.advance(LASER_FADE_MS + 1);

        const hasContent = tracker.prune(clock.now());

        expect(hasContent).toBe(false);
        expect(tracker.trails).toEqual({});
    });

    it("prune keeps younger points and reports remaining content", () => {
        const { tracker, clock } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");
        clock.advance(LASER_FADE_MS + 1);
        tracker.handleLaserPoint(point("u-bob", 3, 4), "c-1");

        const hasContent = tracker.prune(clock.now());

        expect(hasContent).toBe(true);
        expect(tracker.trails["u-bob"].strokes).toEqual([
            [{ x: 3, y: 4, t: 1000 + LASER_FADE_MS + 1 }]
        ]);
    });

    it("prune drops strokes that empty while keeping younger strokes", () => {
        const { tracker, clock } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");
        tracker.handleLaserEnd(end("u-bob"), "c-1");
        clock.advance(LASER_FADE_MS + 1);
        tracker.handleLaserPoint(point("u-bob", 3, 4), "c-1");

        tracker.prune(clock.now());

        expect(tracker.trails["u-bob"].strokes).toEqual([
            [{ x: 3, y: 4, t: 1000 + LASER_FADE_MS + 1 }]
        ]);
    });

    it("prune with nothing expired reports content without rewriting state", () => {
        const { tracker, clock } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");
        const before = tracker.trails["u-bob"];

        const hasContent = tracker.prune(clock.now());

        expect(hasContent).toBe(true);
        expect(tracker.trails["u-bob"]).toBe(before);
    });

    it("presenceLeave removes the departed user's trail", () => {
        const { tracker } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");
        tracker.handleLaserPoint(point("u-eve", 3, 4), "c-1");

        tracker.handlePresenceLeave({ canvasId: "c-1", userId: "u-bob" }, "c-1");

        expect(Object.keys(tracker.trails)).toEqual(["u-eve"]);
    });

    it("presenceLeave for a different canvas is ignored", () => {
        const { tracker } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");

        tracker.handlePresenceLeave({ canvasId: "c-other", userId: "u-bob" }, "c-1");

        expect(tracker.trails["u-bob"]).toBeDefined();
    });

    it("caps retained points per user, dropping the oldest", () => {
        const { tracker, clock } = track();
        for (let i = 0; i < LASER_MAX_POINTS + 25; i++) {
            tracker.handleLaserPoint(point("u-bob", i, i), "c-1");
            clock.advance(1);
        }

        const kept = tracker.trails["u-bob"].strokes.flat();
        expect(kept).toHaveLength(LASER_MAX_POINTS);
        expect(kept[0].x).toBe(25);
        expect(kept[kept.length - 1].x).toBe(LASER_MAX_POINTS + 24);
    });

    it("the cap drops whole emptied strokes from the front", () => {
        const { tracker, clock } = track();
        tracker.handleLaserPoint(point("u-bob", 0, 0), "c-1");
        tracker.handleLaserEnd(end("u-bob"), "c-1");
        for (let i = 1; i <= LASER_MAX_POINTS; i++) {
            tracker.handleLaserPoint(point("u-bob", i, i), "c-1");
            clock.advance(1);
        }

        expect(tracker.trails["u-bob"].strokes).toHaveLength(1);
        expect(tracker.trails["u-bob"].strokes[0]).toHaveLength(LASER_MAX_POINTS);
    });

    it("reset clears all trails (canvas switch)", () => {
        const { tracker } = track();
        tracker.handleLaserPoint(point("u-bob", 1, 2), "c-1");
        tracker.addLocalPoint(3, 4);

        tracker.reset();

        expect(tracker.trails).toEqual({});
    });
});
