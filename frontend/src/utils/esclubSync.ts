import type {
    EsclubActionResponse,
    EsclubInvalidResponse,
    EsclubOffResponse,
    EsclubRetryAfterResponse,
    EsclubSyncView,
    EsclubTournamentView
} from "@draft-sim/shared-types";

export const ACCEPTED_LINK_EXAMPLE = "https://esclub.gg/multimedia/serie/<series id>";

// Ported from backend/services/esclub/addLeague.js. Keep both rules in sync.
const SERIE_LINK =
    /^https?:\/\/(?:www\.)?esclub\.gg\/multimedia\/serie\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/[^?#\s]*)?(?:\?[^#\s]*)?(?:#\S*)?$/i;

export function parseEsclubUrl(text: string): { kind: "serie"; id: string } | null {
    const id = SERIE_LINK.exec(text.trim())?.[1];
    return id ? { kind: "serie", id: id.toLowerCase() } : null;
}

export type EsclubActionResult =
    | { status: 200 | 202; body: EsclubActionResponse }
    | { status: 401; sessionRefreshed: boolean }
    | {
          status: 409 | 429;
          body: EsclubRetryAfterResponse;
          retryAfter: string | null;
      }
    | { status: 503; body: EsclubOffResponse }
    | { status: 400; body: EsclubInvalidResponse };

export function esclubRefreshButton(view: EsclubTournamentView, now: number) {
    if (view.sync.running) return { label: "Refreshing…", disabled: true };
    if (!view.sync.syncEnabled) return { label: "Sync is off", disabled: true };
    if (view.sync.budgetPaused) return { label: "Paused until tomorrow", disabled: true };

    const remaining = Date.parse(view.sync.availableAt ?? "") - now;
    if (remaining > 0) {
        const available = `available in ${Math.ceil(remaining / 60_000)} min`;
        const last = view.tournament.lastSyncedAt;
        return {
            label: last
                ? `Refreshed ${Math.max(0, Math.floor((now - Date.parse(last)) / 60_000))} min ago · ${available}`
                : `Available in ${Math.ceil(remaining / 60_000)} min`,
            disabled: true
        };
    }
    return { label: "Refresh league", disabled: false };
}

function retryMinutes(
    result: {
        body: EsclubRetryAfterResponse;
        retryAfter: string | null;
    },
    now: number
): number {
    const header = result.retryAfter;
    const seconds =
        header && /^\d+$/.test(header)
            ? Number(header)
            : header
              ? (Date.parse(header) - now) / 1000
              : NaN;
    return Math.max(
        1,
        Math.ceil((Number.isFinite(seconds) ? seconds : result.body.retryAfter) / 60)
    );
}

export function esclubActionMessage(result: EsclubActionResult, now: number): string {
    switch (result.status) {
        case 401:
            return result.sessionRefreshed
                ? "Your session was refreshed. Press again."
                : "Sign in again.";
        case 400:
            return result.body.code === "INVALID_URL"
                ? `Paste an esclub series link, like ${ACCEPTED_LINK_EXAMPLE}.`
                : "Choose a valid region.";
        case 409:
            return `Another league is syncing. Try again in ${retryMinutes(result, now)} min.`;
        case 429:
            return `Sync limit reached. Try again in ${retryMinutes(result, now)} min.`;
        case 503:
            return result.body.reason === "disabled"
                ? "esclub sync is off. Saved leagues are still available."
                : "esclub sync is paused until tomorrow: today's request budget is spent.";
        default: {
            const body = result.body;
            if ("sync" in body)
                return result.status === 202
                    ? "League sync started. Teams will appear when it finishes."
                    : "Joined the running league sync. Teams will update when it finishes.";
            if ("known" in body)
                return "League added to your Teams page. It was already synced.";
            const minutes = Math.max(
                0,
                Math.ceil((Date.parse(body.cooldown.availableAt) - now) / 60_000)
            );
            return `League was refreshed recently. Available in ${minutes} min.`;
        }
    }
}

export function esclubActionSync(result: EsclubActionResult): EsclubSyncView | null {
    if (result.status !== 200 && result.status !== 202) return null;
    if ("sync" in result.body) return result.body.sync;
    return null;
}

export function esclubSyncFailureMessage(sync: EsclubSyncView): string {
    return sync.errorClass === "EsclubLeagueRejected"
        ? "This league can't be imported: it is not a League of Legends league with a supported draft (standard or fearless hard-pick; not blind). Retrying won't help."
        : "League sync failed. Saved teams have been refreshed; try again when available.";
}

export function esclubSyncPollInterval(
    status: EsclubSyncView["status"] | undefined,
    failed: boolean
): number | false {
    return failed || (status !== undefined && status !== "running") ? false : 3000;
}
