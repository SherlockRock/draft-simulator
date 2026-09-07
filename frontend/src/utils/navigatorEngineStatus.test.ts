import { describe, expect, test } from "vitest";
import {
    deriveEngineStatus,
    formatEngineStatus,
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
    reason: () => "should not be called"
};

describe("deriveEngineStatus (design § 4 table)", () => {
    test("ready", () => {
        expect(deriveEngineStatus(base)).toEqual({
            kind: "ready",
            candidates: 8,
            depthReached: 3,
            computeTimeMs: 301
        });
        expect(formatEngineStatus(deriveEngineStatus(base))).toBe(
            "● 8 candidates · depth 3 · 301 ms"
        );
    });
    test("thinking wins over the fan (optimistic phase still shows the promoted continuation)", () => {
        const s = deriveEngineStatus({ ...base, isComputing: true, elapsedMs: 4200 });
        expect(s).toEqual({ kind: "thinking", elapsedMs: 4200 });
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
