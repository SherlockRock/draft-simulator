import { describe, expect, test } from "vitest";
import {
    NavigatorEngineHeartbeatSchema,
    deriveIsComputing,
    heartbeatMatchesState,
    shouldCacheSnapshot
} from "./navigatorProgress";

const hb = {
    draftId: "d1",
    afterEventId: "e7",
    depthPainted: 1,
    depthInProgress: 2,
    nodes: 1840,
    elapsedMs: 4200
};

describe("NavigatorEngineHeartbeatSchema", () => {
    test("accepts the wire shape, including a null afterEventId", () => {
        expect(NavigatorEngineHeartbeatSchema.safeParse(hb).success).toBe(true);
        expect(
            NavigatorEngineHeartbeatSchema.safeParse({ ...hb, afterEventId: null }).success
        ).toBe(true);
    });
    test("rejects a missing field", () => {
        const { nodes: _dropped, ...rest } = hb;
        expect(NavigatorEngineHeartbeatSchema.safeParse(rest).success).toBe(false);
    });
});

describe("heartbeatMatchesState", () => {
    test("same draft and same after-event id", () => {
        expect(heartbeatMatchesState(hb, "d1", "e7")).toBe(true);
    });
    test("another draft or a state the client has left is discarded", () => {
        expect(heartbeatMatchesState(hb, "d2", "e7")).toBe(false);
        expect(heartbeatMatchesState(hb, "d1", "e8")).toBe(false);
        expect(heartbeatMatchesState(hb, null, "e7")).toBe(false);
    });
    test("zero-event state matches a null after-event id", () => {
        expect(heartbeatMatchesState({ ...hb, afterEventId: null }, "d1", null)).toBe(true);
    });
});

describe("deriveIsComputing (design § 4)", () => {
    const snap = (after: string | null, inProgress?: boolean) => ({
        after_event_id: after,
        meta: inProgress === undefined ? null : { inProgress }
    });
    test("no events → never computing", () => {
        expect(
            deriveIsComputing({ eventCount: 0, latestEventId: null, snapshot: null, hasLiveHeartbeat: true })
        ).toBe(false);
    });
    test("no snapshot yet with events → computing", () => {
        expect(
            deriveIsComputing({ eventCount: 1, latestEventId: "e1", snapshot: null, hasLiveHeartbeat: false })
        ).toBe(true);
    });
    test("snapshot lagging the latest event → computing", () => {
        expect(
            deriveIsComputing({ eventCount: 2, latestEventId: "e2", snapshot: snap("e1"), hasLiveHeartbeat: false })
        ).toBe(true);
    });
    test("a partial for the latest event is still computing", () => {
        expect(
            deriveIsComputing({ eventCount: 2, latestEventId: "e2", snapshot: snap("e2", true), hasLiveHeartbeat: false })
        ).toBe(true);
    });
    test("a final for the latest event is ready", () => {
        expect(
            deriveIsComputing({ eventCount: 2, latestEventId: "e2", snapshot: snap("e2", false), hasLiveHeartbeat: false })
        ).toBe(false);
        expect(
            deriveIsComputing({ eventCount: 2, latestEventId: "e2", snapshot: snap("e2"), hasLiveHeartbeat: false })
        ).toBe(false);
    });
    test("a live heartbeat with no event lag (swap/branch recompute) → computing", () => {
        expect(
            deriveIsComputing({ eventCount: 2, latestEventId: "e2", snapshot: snap("e2", false), hasLiveHeartbeat: true })
        ).toBe(true);
    });
});

describe("shouldCacheSnapshot", () => {
    test("persisted and cache yes, partial no", () => {
        expect(shouldCacheSnapshot("persisted")).toBe(true);
        expect(shouldCacheSnapshot("cache")).toBe(true);
        expect(shouldCacheSnapshot("partial")).toBe(false);
    });
});
