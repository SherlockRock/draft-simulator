import type {
    EsclubSyncResponse,
    EsclubSyncView,
    LeagueImport,
    LeagueRefreshResponse
} from "@draft-sim/shared-types";
import type { EsclubActionResult } from "./esclubSync";
import {
    refreshToast,
    shouldCallEsclubRefresh,
    type LeagueRefreshEsclubOutcome
} from "./leagueImport";

/** Same cadence as the Teams page's sync polling (esclubSyncPollInterval). */
export const LEAGUE_REFRESH_POLL_MS = 3000;
/** Polling stops after this long (no endless loop); the toast says the sync is still running. */
export const LEAGUE_REFRESH_POLL_CAP_MS = 180_000;

export type LeagueRefreshDeps = {
    /** S2's `POST /api/esclub/series/:id/refresh` (sent once, never replayed). */
    refreshEsclubSeries: (leagueSeriesId: string) => Promise<EsclubActionResult>;
    /** S2's `GET /api/esclub/syncs/:id`. */
    fetchEsclubSync: (syncId: string) => Promise<EsclubSyncResponse>;
    /** `POST /api/canvas/:canvasId/group/:groupId/league-refresh`, canvas bound. */
    applyLeagueRefresh: (groupId: string) => Promise<LeagueRefreshResponse>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
};

export type LeagueRefreshRun = {
    /** One toast for the press (refreshToast). */
    message: string;
    /** False when the mirror apply failed. */
    ok: boolean;
    /** The apply's answer (null when it failed), for patching the group. */
    applied: LeagueRefreshResponse | null;
};

export type LeagueRefreshScope = {
    /** The signal for a run started now. */
    signal: () => AbortSignal;
    /** Abort every run started so far; later runs get a fresh signal. */
    reset: () => void;
};

/**
 * The lifetime of the refresh runs of one canvas. Canvas.tsx stays mounted
 * across canvas-to-canvas navigation, so it resets the scope when the canvas
 * changes (and on unmount): a run for the canvas left behind stops polling,
 * skips its apply and patches nothing.
 */
export function createLeagueRefreshScope(): LeagueRefreshScope {
    let controller = new AbortController();
    return {
        signal: () => controller.signal,
        reset: () => {
            controller.abort();
            controller = new AbortController();
        }
    };
}

/**
 * Poll a running sync until it ends. At the cap (or once aborted) it returns
 * the last view, still `running`, so the toast says the sync is still
 * running; a poll that throws throws (an error outcome).
 */
async function pollSync(
    first: EsclubSyncView,
    deps: LeagueRefreshDeps,
    aborted: () => boolean
): Promise<EsclubSyncView> {
    const startedAt = deps.now();
    let sync = first;
    while (sync.status === "running") {
        if (aborted() || deps.now() - startedAt >= LEAGUE_REFRESH_POLL_CAP_MS)
            return sync;
        await deps.sleep(LEAGUE_REFRESH_POLL_MS);
        if (aborted()) return sync;
        sync = (await deps.fetchEsclubSync(sync.id)).sync;
    }
    return sync;
}

/** Step 1 (D6): S2's serie refresh, only for a series that can still change. */
async function esclubStep(
    view: LeagueImport,
    deps: LeagueRefreshDeps,
    aborted: () => boolean
): Promise<LeagueRefreshEsclubOutcome> {
    if (!shouldCallEsclubRefresh(view)) return { kind: "skipped-complete" };
    try {
        const result = await deps.refreshEsclubSeries(view.leagueSeriesId);
        if (result.status === 401 || result.status === 409 || result.status === 429)
            return { kind: "refused", result };
        if (result.status === 503 || result.status === 400)
            return { kind: "refused", result };
        const body = result.body;
        if ("cooldown" in body)
            return { kind: "cooldown", availableAt: body.cooldown.availableAt };
        if (!("sync" in body)) return { kind: "error" };
        return { kind: "synced", sync: await pollSync(body.sync, deps, aborted) };
    } catch {
        return { kind: "error" };
    }
}

/**
 * "Refresh from league" for one imported group (plan D6): step 1 asks esclub
 * (S2's limits apply) unless the series is complete, and waits for its sync;
 * step 2 ALWAYS applies the mirror to the group, whatever step 1 answered.
 * Never throws. Once `signal` is aborted (the canvas went away) it stops
 * polling, skips the apply and returns null: nothing to toast or patch.
 */
export async function runLeagueRefresh(input: {
    group: { id: string; LeagueImport: LeagueImport };
    deps: LeagueRefreshDeps;
    signal?: AbortSignal;
}): Promise<LeagueRefreshRun | null> {
    const { group, deps, signal } = input;
    const aborted = () => signal?.aborted === true;
    if (aborted()) return null;
    const outcome = await esclubStep(group.LeagueImport, deps, aborted);
    if (aborted()) return null;
    let applied: LeagueRefreshResponse | null = null;
    try {
        applied = await deps.applyLeagueRefresh(group.id);
    } catch {
        applied = null;
    }
    if (aborted()) return null;
    return {
        message: refreshToast(outcome, applied, deps.now()),
        ok: applied !== null,
        applied
    };
}
