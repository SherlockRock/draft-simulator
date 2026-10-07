import { describe, expect, test } from "vitest";
import {
    NavigatorEngineHeartbeatSchema,
    deriveIsComputing,
    eventListChanged,
    heartbeatMatchesState,
    isFailedComputeUpdate,
    partialMatchesState,
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
            NavigatorEngineHeartbeatSchema.safeParse({ ...hb, afterEventId: null })
                .success
        ).toBe(true);
    });
    test("rejects a missing field", () => {
        const missingNodes = { ...hb };
        Reflect.deleteProperty(missingNodes, "nodes");
        expect(NavigatorEngineHeartbeatSchema.safeParse(missingNodes).success).toBe(
            false
        );
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
        expect(heartbeatMatchesState({ ...hb, afterEventId: null }, "d1", null)).toBe(
            true
        );
    });
});

describe("deriveIsComputing (design § 4)", () => {
    const snap = (after: string | null, inProgress?: boolean) => ({
        after_event_id: after,
        meta: inProgress === undefined ? null : { inProgress }
    });
    test("no events → never computing", () => {
        expect(
            deriveIsComputing({
                eventCount: 0,
                latestEventId: null,
                snapshot: null,
                hasLiveHeartbeat: true,
                computeFailed: false
            })
        ).toBe(false);
    });
    test("no snapshot yet with events → computing", () => {
        expect(
            deriveIsComputing({
                eventCount: 1,
                latestEventId: "e1",
                snapshot: null,
                hasLiveHeartbeat: false,
                computeFailed: false
            })
        ).toBe(true);
    });
    test("snapshot lagging the latest event → computing", () => {
        expect(
            deriveIsComputing({
                eventCount: 2,
                latestEventId: "e2",
                snapshot: snap("e1"),
                hasLiveHeartbeat: false,
                computeFailed: false
            })
        ).toBe(true);
    });
    test("a partial for the latest event is still computing", () => {
        expect(
            deriveIsComputing({
                eventCount: 2,
                latestEventId: "e2",
                snapshot: snap("e2", true),
                hasLiveHeartbeat: false,
                computeFailed: false
            })
        ).toBe(true);
    });
    test("a final for the latest event is ready", () => {
        expect(
            deriveIsComputing({
                eventCount: 2,
                latestEventId: "e2",
                snapshot: snap("e2", false),
                hasLiveHeartbeat: false,
                computeFailed: false
            })
        ).toBe(false);
        expect(
            deriveIsComputing({
                eventCount: 2,
                latestEventId: "e2",
                snapshot: snap("e2"),
                hasLiveHeartbeat: false,
                computeFailed: false
            })
        ).toBe(false);
    });
    test("a live heartbeat with no event lag (swap/branch recompute) → computing", () => {
        expect(
            deriveIsComputing({
                eventCount: 2,
                latestEventId: "e2",
                snapshot: snap("e2", false),
                hasLiveHeartbeat: true,
                computeFailed: false
            })
        ).toBe(true);
    });
    test("a failed compute for the latest event is NOT computing even with no snapshot (target note D10 item 2)", () => {
        expect(
            deriveIsComputing({
                eventCount: 1,
                latestEventId: "e1",
                snapshot: null,
                hasLiveHeartbeat: false,
                computeFailed: true
            })
        ).toBe(false);
    });
    test("a failed compute over a partial for the same state is NOT computing", () => {
        expect(
            deriveIsComputing({
                eventCount: 2,
                latestEventId: "e2",
                snapshot: snap("e2", true),
                hasLiveHeartbeat: false,
                computeFailed: true
            })
        ).toBe(false);
    });
});

describe("isFailedComputeUpdate (D10 item 2)", () => {
    const snapshot = { after_event_id: "e1" };
    test("an explicit `snapshot: null` on the same draft is a compute that ended without a result", () => {
        expect(isFailedComputeUpdate({ snapshot: null }, false)).toBe(true);
    });
    test("an omitted snapshot is an interim update, not a failure", () => {
        expect(isFailedComputeUpdate({}, false)).toBe(false);
        expect(isFailedComputeUpdate({ snapshot: undefined }, false)).toBe(false);
    });
    test("`snapshot: null` on a draft change is the next-game update, not a failure", () => {
        expect(isFailedComputeUpdate({ snapshot: null }, true)).toBe(false);
    });
    test("a snapshot is never a failure", () => {
        expect(isFailedComputeUpdate({ snapshot }, false)).toBe(false);
    });
});

describe("shouldCacheSnapshot", () => {
    test("persisted and cache yes, partial no", () => {
        expect(shouldCacheSnapshot("persisted")).toBe(true);
        expect(shouldCacheSnapshot("cache")).toBe(true);
        expect(shouldCacheSnapshot("partial")).toBe(false);
    });
});

describe("partialMatchesState (final review #1, design § 7)", () => {
    test("a non-partial always passes, regardless of after_event_id", () => {
        expect(
            partialMatchesState({ source: "persisted", after_event_id: "e7" }, "e9")
        ).toBe(true);
        expect(partialMatchesState({ source: "cache", after_event_id: null }, "e9")).toBe(
            true
        );
    });
    test("a partial with a matching after_event_id passes", () => {
        expect(
            partialMatchesState({ source: "partial", after_event_id: "e7" }, "e7")
        ).toBe(true);
    });
    test("a partial with a different after_event_id is dropped", () => {
        expect(
            partialMatchesState({ source: "partial", after_event_id: "e6" }, "e7")
        ).toBe(false);
    });
    test("a partial mismatched null-vs-id is dropped in either direction", () => {
        expect(
            partialMatchesState({ source: "partial", after_event_id: null }, "e7")
        ).toBe(false);
        expect(
            partialMatchesState({ source: "partial", after_event_id: "e7" }, null)
        ).toBe(false);
    });
    test("a zero-event partial matches a null after_event_id", () => {
        expect(
            partialMatchesState({ source: "partial", after_event_id: null }, null)
        ).toBe(true);
    });
});

describe("eventListChanged (final review #2)", () => {
    const ev = (id: string) => ({ id });
    test("two distinct arrays with the same ids are unchanged", () => {
        expect(eventListChanged([ev("e1"), ev("e2")], [ev("e1"), ev("e2")])).toBe(false);
    });
    test("an appended event is a change", () => {
        expect(eventListChanged([ev("e1")], [ev("e1"), ev("e2")])).toBe(true);
    });
    test("a removed event (undo) is a change", () => {
        expect(eventListChanged([ev("e1"), ev("e2")], [ev("e1")])).toBe(true);
    });
    test("the last id replaced at equal length is a change", () => {
        expect(eventListChanged([ev("e1"), ev("e2")], [ev("e1"), ev("e3")])).toBe(true);
    });
    test("both empty is unchanged", () => {
        expect(eventListChanged([], [])).toBe(false);
    });
});
