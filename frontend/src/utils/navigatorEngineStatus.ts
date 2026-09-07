export type EngineStatus =
    | { kind: "initial" }
    | { kind: "complete" }
    | { kind: "thinking"; elapsedMs: number }
    | {
          kind: "ready";
          candidates: number;
          depthReached: number | null;
          computeTimeMs: number | null;
      }
    | { kind: "empty"; reason: string };

export interface EngineStatusInput {
    hasSnapshot: boolean;
    /** Confirmed (ban/pick) events. */
    eventCount: number;
    draftComplete: boolean;
    isComputing: boolean;
    /** `fanoutParent(...).children.length`. */
    fanCount: number;
    meta: { depthReached: number; computeTimeMs: number } | null;
    /** Client clock since the latest confirmed event. */
    elapsedMs: number;
    /** Lazy: only evaluated for the empty state (it runs the role solver). */
    reason: () => string;
}

/** Design § 4: thinking · ready · empty, plus the two edges (initial join before
 *  any snapshot at zero events; draft complete). */
export function deriveEngineStatus(input: EngineStatusInput): EngineStatus {
    if (input.draftComplete) return { kind: "complete" };
    if (input.isComputing) return { kind: "thinking", elapsedMs: input.elapsedMs };
    if (!input.hasSnapshot && input.eventCount === 0) return { kind: "initial" };
    if (input.fanCount > 0) {
        return {
            kind: "ready",
            candidates: input.fanCount,
            depthReached: input.meta?.depthReached ?? null,
            computeTimeMs: input.meta?.computeTimeMs ?? null
        };
    }
    return { kind: "empty", reason: input.reason() };
}

export function formatEngineStatus(status: EngineStatus): string {
    switch (status.kind) {
        case "initial":
            return "Waiting for engine output";
        case "complete":
            return "Draft complete";
        case "thinking":
            return `◐ Thinking · ${(status.elapsedMs / 1000).toFixed(1)} s`;
        case "ready":
            return `● ${status.candidates} candidates · depth ${status.depthReached ?? "?"} · ${status.computeTimeMs ?? "?"} ms`;
        case "empty":
            return `✕ No legal completion — ${status.reason} · undo or relax pool`;
    }
}
