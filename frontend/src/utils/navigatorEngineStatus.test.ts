import { describe, expect, test } from "vitest";
import {
    deriveEngineStatus,
    formatEngineStatus,
    isHeartbeatStale,
    type EngineStatusInput
} from "./navigatorEngineStatus";

const base: EngineStatusInput = {
    hasSnapshot: true,
    eventCount: 19,
    draftComplete: false,
    isComputing: false,
    fanCount: 8,
    meta: { depthReached: 3, computeTimeMs: 301 },
    elapsedMs: 0,
    reason: () => "should not be called",
    progress: null,
    budgetHit: false,
    heartbeatStaleMs: null
};

describe("deriveEngineStatus (design § 4 table)", () => {
    test("ready", () => {
        expect(deriveEngineStatus(base)).toEqual({
            kind: "ready",
            candidates: 8,
            depthReached: 3,
            computeTimeMs: 301,
            budgetHit: false
        });
        expect(formatEngineStatus(deriveEngineStatus(base))).toBe(
            "● 8 candidates · depth 3 · 301 ms"
        );
    });
    test("thinking wins over the fan (optimistic phase still shows the promoted continuation)", () => {
        const s = deriveEngineStatus({ ...base, isComputing: true, elapsedMs: 4200 });
        expect(s).toEqual({
            kind: "thinking",
            elapsedMs: 4200,
            candidates: null,
            progress: null,
            heartbeatStaleMs: null
        });
        expect(formatEngineStatus(s)).toBe("◐ Thinking · 4.2 s");
    });
    test("empty fan with a reason", () => {
        const s = deriveEngineStatus({
            ...base,
            fanCount: 0,
            reason: () => "red cannot fill five roles with Rengar, Nidalee, Yone, Ezreal"
        });
        expect(s.kind).toBe("empty");
        expect(formatEngineStatus(s)).toBe(
            "✕ No legal completion — red cannot fill five roles with Rengar, Nidalee, Yone, Ezreal · undo or relax pool"
        );
    });
    test("initial: no snapshot and no events keeps the old waiting text", () => {
        const s = deriveEngineStatus({
            ...base,
            hasSnapshot: false,
            eventCount: 0,
            fanCount: 0
        });
        expect(s).toEqual({ kind: "initial" });
        expect(formatEngineStatus(s)).toBe("Waiting for engine output");
    });
    test("a snapshot at zero events is ready or empty, not initial", () => {
        expect(deriveEngineStatus({ ...base, eventCount: 0 }).kind).toBe("ready");
    });
    test("draft complete beats everything", () => {
        expect(
            deriveEngineStatus({ ...base, draftComplete: true, isComputing: true }).kind
        ).toBe("complete");
        expect(formatEngineStatus({ kind: "complete" })).toBe("Draft complete");
    });
    test("missing meta renders ? not NaN", () => {
        expect(formatEngineStatus(deriveEngineStatus({ ...base, meta: null }))).toBe(
            "● 8 candidates · depth ? · ? ms"
        );
    });
});

describe("streaming states (design § 4)", () => {
    test("thinking before any partial shows the depth being searched and the node count", () => {
        const s = deriveEngineStatus({
            ...base,
            isComputing: true,
            fanCount: 0,
            elapsedMs: 400,
            progress: { depthPainted: 0, depthInProgress: 1, nodes: 120 }
        });
        expect(formatEngineStatus(s)).toBe("◐ Thinking · searching depth 1 · 0.4 s · 120 nodes");
    });
    test("thinking with a painted depth names the candidates and both depths", () => {
        const s = deriveEngineStatus({
            ...base,
            isComputing: true,
            fanCount: 8,
            elapsedMs: 4200,
            progress: { depthPainted: 2, depthInProgress: 3, nodes: 1840 }
        });
        expect(formatEngineStatus(s)).toBe(
            "◐ 8 candidates · depth 2 painted · searching depth 3 · 4.2 s · 1,840 nodes"
        );
    });
    test("a stale heartbeat is appended and flagged", () => {
        const s = deriveEngineStatus({
            ...base,
            isComputing: true,
            fanCount: 8,
            elapsedMs: 7100,
            progress: { depthPainted: 2, depthInProgress: 3, nodes: 1840 },
            heartbeatStaleMs: 3000
        });
        expect(formatEngineStatus(s)).toBe(
            "◐ 8 candidates · depth 2 painted · searching depth 3 · 7.1 s · 1,840 nodes · no heartbeat for 3 s"
        );
        expect(isHeartbeatStale(s)).toBe(true);
    });
    test("a fresh heartbeat is not flagged", () => {
        const s = deriveEngineStatus({
            ...base,
            isComputing: true,
            elapsedMs: 1000,
            progress: { depthPainted: 1, depthInProgress: 2, nodes: 10 },
            heartbeatStaleMs: 500
        });
        expect(isHeartbeatStale(s)).toBe(false);
        expect(formatEngineStatus(s)).not.toContain("no heartbeat");
    });
    test("ready after a deadline cut says budget hit", () => {
        const s = deriveEngineStatus({ ...base, meta: { depthReached: 2, computeTimeMs: 5003 }, budgetHit: true });
        expect(formatEngineStatus(s)).toBe("● 8 candidates · depth 2 · 5003 ms · budget hit");
    });
    test("a stale check never applies outside thinking", () => {
        expect(isHeartbeatStale(deriveEngineStatus(base))).toBe(false);
    });
});
