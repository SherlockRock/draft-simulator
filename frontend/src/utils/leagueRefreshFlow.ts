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
/** A sync still running after this long is reported as an error (no endless loop). */
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
};

/** Poll a running sync until it ends; null when the poll failed or hit the cap. */
async function pollSync(
    first: EsclubSyncView,
    deps: LeagueRefreshDeps
): Promise<EsclubSyncView | null> {
    const startedAt = deps.now();
    let sync = first;
    while (sync.status === "running") {
        if (deps.now() - startedAt >= LEAGUE_REFRESH_POLL_CAP_MS) return null;
        await deps.sleep(LEAGUE_REFRESH_POLL_MS);
        sync = (await deps.fetchEsclubSync(sync.id)).sync;
    }
    return sync;
}

/** Step 1 (D6): S2's serie refresh, only for a series that can still change. */
async function esclubStep(
    view: LeagueImport,
    deps: LeagueRefreshDeps
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
        const sync = await pollSync(body.sync, deps);
        return sync ? { kind: "synced", sync } : { kind: "error" };
    } catch {
        return { kind: "error" };
    }
}

/**
 * "Refresh from league" for one imported group (plan D6): step 1 asks esclub
 * (S2's limits apply) unless the series is complete, and waits for its sync;
 * step 2 ALWAYS applies the mirror to the group, whatever step 1 answered.
 * Never throws.
 */
export async function runLeagueRefresh(input: {
    group: { id: string; LeagueImport: LeagueImport };
    deps: LeagueRefreshDeps;
}): Promise<LeagueRefreshRun> {
    const { group, deps } = input;
    const outcome = await esclubStep(group.LeagueImport, deps);
    let applied: LeagueRefreshResponse | null = null;
    try {
        applied = await deps.applyLeagueRefresh(group.id);
    } catch {
        applied = null;
    }
    return {
        message: refreshToast(outcome, applied, deps.now()),
        ok: applied !== null
    };
}
