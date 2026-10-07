import { HEARTBEAT_STALE_MS } from "./navigatorProgress";

export interface EngineProgress {
    /** Last partial's depthReached; 0 before the first partial. */
    depthPainted: number;
    depthInProgress: number;
    nodes: number;
}

export type EngineStatus =
    | { kind: "initial" }
    | { kind: "complete" }
    | {
          kind: "thinking";
          elapsedMs: number;
          /** Fan size of the painted partial; null before the first partial. */
          candidates: number | null;
          progress: EngineProgress | null;
          /** Client clock since the last heartbeat; null when none has arrived. */
          heartbeatStaleMs: number | null;
      }
    | {
          kind: "ready";
          candidates: number;
          depthReached: number | null;
          computeTimeMs: number | null;
          budgetHit: boolean;
      }
    | { kind: "empty"; reason: string }
    /** The compute for this state ended without a result (D10 item 2). */
    | { kind: "failed" };

export interface EngineStatusInput {
    hasSnapshot: boolean;
    eventCount: number;
    draftComplete: boolean;
    isComputing: boolean;
    fanCount: number;
    meta: { depthReached: number; computeTimeMs: number } | null;
    elapsedMs: number;
    reason: () => string;
    /** From the heartbeat, else from a partial's meta; null with neither. */
    progress: EngineProgress | null;
    budgetHit: boolean;
    heartbeatStaleMs: number | null;
    computeFailed: boolean;
}

export function deriveEngineStatus(input: EngineStatusInput): EngineStatus {
    if (input.draftComplete) return { kind: "complete" };
    if (input.computeFailed) return { kind: "failed" };
    if (input.isComputing) {
        const painted = input.progress !== null && input.progress.depthPainted > 0;
        return {
            kind: "thinking",
            elapsedMs: input.elapsedMs,
            candidates: painted && input.fanCount > 0 ? input.fanCount : null,
            progress: input.progress,
            heartbeatStaleMs: input.heartbeatStaleMs
        };
    }
    if (!input.hasSnapshot && input.eventCount === 0) return { kind: "initial" };
    if (input.fanCount > 0) {
        return {
            kind: "ready",
            candidates: input.fanCount,
            depthReached: input.meta?.depthReached ?? null,
            computeTimeMs: input.meta?.computeTimeMs ?? null,
            budgetHit: input.budgetHit
        };
    }
    return { kind: "empty", reason: input.reason() };
}

export function isHeartbeatStale(status: EngineStatus): boolean {
    return (
        status.kind === "thinking" &&
        status.heartbeatStaleMs !== null &&
        status.heartbeatStaleMs >= HEARTBEAT_STALE_MS
    );
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function formatEngineStatus(status: EngineStatus): string {
    switch (status.kind) {
        case "initial":
            return "Waiting for engine output";
        case "complete":
            return "Draft complete";
        case "thinking": {
            const parts: string[] = [];
            if (status.candidates !== null && status.progress !== null) {
                parts.push(`◐ ${status.candidates} candidates`);
                parts.push(`depth ${status.progress.depthPainted} painted`);
            } else {
                parts.push("◐ Thinking");
            }
            if (status.progress !== null)
                parts.push(`searching depth ${status.progress.depthInProgress}`);
            parts.push(seconds(status.elapsedMs));
            if (status.progress !== null)
                parts.push(`${status.progress.nodes.toLocaleString("en-US")} nodes`);
            if (isHeartbeatStale(status) && status.heartbeatStaleMs !== null)
                parts.push(
                    `no heartbeat for ${Math.round(status.heartbeatStaleMs / 1000)} s`
                );
            return parts.join(" · ");
        }
        case "ready":
            return (
                `● ${status.candidates} candidates · depth ${status.depthReached ?? "?"} · ${status.computeTimeMs ?? "?"} ms` +
                (status.budgetHit ? " · budget hit" : "")
            );
        case "empty":
            return `✕ No legal completion — ${status.reason} · undo or relax pool`;
        case "failed":
            return "✕ Engine failed · next pick, ban or undo retries";
    }
}
