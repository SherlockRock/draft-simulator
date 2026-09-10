import { z } from "zod";

/** A thinking pill with no heartbeat for this long appends "no heartbeat for N s". */
export const HEARTBEAT_STALE_MS = 2000;

export interface EngineHeartbeat {
    draftId: string;
    /** The last event id the compute was started from; null at zero events. */
    afterEventId: string | null;
    /** Last partial's depthReached; 0 before the first partial. */
    depthPainted: number;
    depthInProgress: number;
    nodes: number;
    elapsedMs: number;
}

export interface LiveHeartbeat extends EngineHeartbeat {
    /** Client clock when it arrived (staleness is measured from here). */
    receivedAt: number;
}

export const NavigatorEngineHeartbeatSchema: z.ZodType<EngineHeartbeat> = z.object({
    draftId: z.string(),
    afterEventId: z.string().nullable(),
    depthPainted: z.number().int().nonnegative(),
    depthInProgress: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
    elapsedMs: z.number().nonnegative()
});

/** A heartbeat belongs to the current state only when both the draft and the
 *  after-event id match — anything else is from a state the client has left. */
export function heartbeatMatchesState(
    hb: EngineHeartbeat,
    draftId: string | null,
    latestEventId: string | null
): boolean {
    return draftId !== null && hb.draftId === draftId && hb.afterEventId === latestEventId;
}

export interface ComputingInput {
    eventCount: number;
    latestEventId: string | null;
    snapshot: {
        after_event_id: string | null;
        meta: { inProgress?: boolean } | null;
    } | null;
    hasLiveHeartbeat: boolean;
}

/** Design § 4: event id lags, OR the snapshot is a partial, OR a live heartbeat
 *  says a recompute is running for this very state (swap/branch recomputes
 *  change no event). */
export function deriveIsComputing(input: ComputingInput): boolean {
    if (input.eventCount === 0) return false;
    if (input.snapshot === null) return true;
    if (input.snapshot.after_event_id !== input.latestEventId) return true;
    if (input.snapshot.meta?.inProgress === true) return true;
    return input.hasLiveHeartbeat;
}

/** Partials never enter the local snapshot cache (design § 4). */
export function shouldCacheSnapshot(source: "persisted" | "cache" | "partial"): boolean {
    return source !== "partial";
}

/** Design § 7: the client drops a `source: "partial"` snapshot whose
 *  `after_event_id` is not the current state — a superseded compute's late
 *  partial for the state the client has already left. Non-partials (final,
 *  cached) always pass; they carry their own version/session guards. */
export function partialMatchesState(
    snapshot: {
        source: "persisted" | "cache" | "partial";
        after_event_id: string | null;
    },
    latestEventId: string | null
): boolean {
    if (snapshot.source !== "partial") return true;
    return snapshot.after_event_id === latestEventId;
}

/** True when the event LIST actually changed — length differs, or the last
 *  event id differs — as opposed to array-identity change. Every partial
 *  rides `navigatorDraftUpdate` with a freshly-parsed `events` array even
 *  when the underlying list is unchanged; keying the heartbeat clear on
 *  identity would clear a live heartbeat on every partial (final review #2). */
export function eventListChanged(
    prev: readonly { id: string }[],
    next: readonly { id: string }[]
): boolean {
    if (prev.length !== next.length) return true;
    const prevLastId = prev.length > 0 ? prev[prev.length - 1].id : null;
    const nextLastId = next.length > 0 ? next[next.length - 1].id : null;
    return prevLastId !== nextLastId;
}
