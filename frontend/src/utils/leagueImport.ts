import type { EsclubSeriesItem, EsclubSyncView } from "@draft-sim/shared-types";
import type { EsclubActionResult } from "./esclubSync";

export type LeagueSeriesStatus = "upcoming" | "in_progress" | "finished";

/** What an imported canvas group carries as `group.LeagueImport` (plan D8). */
export type LeagueImportView = {
    leagueSeriesId: string;
    tournamentId: string;
    stageName: string | null;
    startsAt: string | null;
    status: LeagueSeriesStatus;
    complete: boolean;
    esclubUrl: string;
};

export type LeagueSendSkipReason = "no-teams" | "no-games" | "upcoming" | "not-found";

/** Response of `POST /api/canvas/:canvasId/import/league-series` (plan D5). */
export type LeagueSendResult = {
    created: { leagueSeriesId: string; groupId: string }[];
    existing: { leagueSeriesId: string; groupId: string }[];
    skipped: { leagueSeriesId: string; reason: LeagueSendSkipReason }[];
};

/** Response of `POST /api/canvas/:canvasId/group/:groupId/league-refresh` (plan D6). */
export type LeagueRefreshResult = {
    added: number;
    updated: number;
    series: { status: LeagueSeriesStatus; complete: boolean };
};

/**
 * How step 1 of "Refresh from league" (S2's serie refresh) ended:
 * - `skipped-complete`: the series is complete in the mirror, esclub not called;
 * - `synced`: a sync was started or joined and polled (its last view);
 * - `cooldown`: 200 `{cooldown}`;
 * - `refused`: any non-2xx answer (401, 409, 429, 503, 400).
 */
export type LeagueRefreshEsclubOutcome =
    | { kind: "skipped-complete" }
    | { kind: "synced"; sync: EsclubSyncView }
    | { kind: "cooldown"; availableAt: string }
    | { kind: "refused"; result: Exclude<EsclubActionResult, { status: 200 | 202 }> };

export type SeriesPickerRow = {
    id: string;
    label: string;
    stageId: string;
    checked: boolean;
    disabled: boolean;
    note: string | null;
};

const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
];

function parseTime(iso: string | null): number | null {
    if (iso === null) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

/** "Nov 11", from UTC, independent of the browser's locale. */
function shortDate(iso: string | null): string | null {
    const ms = parseTime(iso);
    if (ms === null) return null;
    const date = new Date(ms);
    return `${MONTHS[date.getUTCMonth()] ?? ""} ${date.getUTCDate()}`;
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

function seriesLabel(series: EsclubSeriesItem): string {
    const team1 = series.team1?.name ?? "TBD";
    const team2 = series.team2?.name ?? "TBD";
    const teams =
        series.gameCount > 0
            ? `${team1} ${series.wins.team1}–${series.wins.team2} ${team2}`
            : `${team1} vs ${team2}`;
    const date = shortDate(series.startsAt);
    return date ? `${date} · ${teams}` : teams;
}

function pickerState(
    series: EsclubSeriesItem,
    onCanvas: boolean
): Pick<SeriesPickerRow, "checked" | "disabled" | "note"> {
    if (onCanvas)
        return { checked: false, disabled: true, note: "already on this canvas" };
    if (series.status === "upcoming")
        return { checked: false, disabled: true, note: "upcoming" };
    if (!series.team1 || !series.team2)
        return { checked: false, disabled: true, note: "teams not known yet" };
    if (series.gameCount <= 0)
        return { checked: false, disabled: true, note: "no games yet" };
    if (series.status === "in_progress")
        return { checked: false, disabled: false, note: "in progress" };
    return { checked: series.status === "finished", disabled: false, note: null };
}

/**
 * The "From league" checklist (plan Q4 A): newest first (`startsAt`
 * descending, undated last, then series number descending); finished series
 * with games pre-checked, in-progress ones offered unchecked, and the rest
 * disabled with the reason.
 */
export function seriesPickerRows(
    series: EsclubSeriesItem[],
    onCanvasSeriesIds: Set<string>
): SeriesPickerRow[] {
    return [...series]
        .sort((a, b) => {
            const ta = parseTime(a.startsAt);
            const tb = parseTime(b.startsAt);
            if (ta !== tb) {
                if (ta === null) return 1;
                if (tb === null) return -1;
                return tb - ta;
            }
            return b.number - a.number;
        })
        .map((s) => ({
            id: s.id,
            label: seriesLabel(s),
            stageId: s.stageId,
            ...pickerState(s, onCanvasSeriesIds.has(s.id))
        }));
}

/** The imported group's header line: "esclub · Regular Season · Nov 11". */
export function importedHeaderLabel(view: LeagueImportView): string {
    const parts = ["esclub"];
    if (view.stageName) parts.push(view.stageName);
    const date = shortDate(view.startsAt);
    if (date) parts.push(date);
    if (view.status === "in_progress") parts.push("in progress");
    return parts.join(" · ");
}

/** Step 1 of a refresh calls esclub only for a series that can still change (D6). */
export function shouldCallEsclubRefresh(view: LeagueImportView): boolean {
    return !view.complete;
}

// Same rule as esclubSync.ts's retryMinutes: the Retry-After header (seconds
// or an HTTP date) wins over the body's seconds; at least 1 minute.
function retryMinutes(
    result: Extract<EsclubActionResult, { status: 409 | 429 }>,
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

function esclubNote(outcome: LeagueRefreshEsclubOutcome, now: number): string | null {
    switch (outcome.kind) {
        case "skipped-complete":
            return "series finished";
        case "synced":
            if (outcome.sync.status === "failed") return "esclub refresh failed";
            if (outcome.sync.status === "running") return "esclub refresh still running";
            return null;
        case "cooldown": {
            const minutes = Math.max(
                1,
                Math.ceil((Date.parse(outcome.availableAt) - now) / 60_000)
            );
            return `esclub refresh available in ${Number.isFinite(minutes) ? minutes : 1} min`;
        }
        case "refused": {
            const result = outcome.result;
            switch (result.status) {
                case 401:
                    return result.sessionRefreshed
                        ? "Session refreshed · press again"
                        : "Sign in again";
                case 409:
                    return `Another league is syncing · try again in ${retryMinutes(result, now)} min`;
                case 429:
                    return `Too many refreshes · try in ${retryMinutes(result, now)} min`;
                case 503:
                    return result.body.reason === "disabled"
                        ? "Sync is off"
                        : "Paused until tomorrow";
                case 400:
                    return "esclub refresh failed";
            }
        }
    }
}

function appliedSummary(result: LeagueRefreshResult): string {
    const parts: string[] = [];
    if (result.added > 0) parts.push(plural(result.added, "new game", "new games"));
    if (result.updated > 0)
        parts.push(plural(result.updated, "game updated", "games updated"));
    return parts.length > 0 ? parts.join(" · ") : "Up to date";
}

/**
 * One toast for a "Refresh from league" press (D7): what the mirror apply
 * changed (`null` when that call failed), then what esclub said, if worth
 * saying. A signed-out press with no apply result just asks to sign in.
 */
export function refreshToast(
    esclubOutcome: LeagueRefreshEsclubOutcome,
    applyResult: LeagueRefreshResult | null,
    now: number
): string {
    const note = esclubNote(esclubOutcome, now);
    if (
        applyResult === null &&
        esclubOutcome.kind === "refused" &&
        esclubOutcome.result.status === 401 &&
        note !== null
    )
        return note;
    const head = applyResult ? appliedSummary(applyResult) : "Couldn't update the series";
    return note ? `${head} · ${note}` : head;
}

const SKIP_REASONS: Record<LeagueSendSkipReason, string> = {
    "no-teams": "teams not known yet",
    "no-games": "no games yet",
    upcoming: "upcoming",
    "not-found": "not found"
};

/** "Sent 3 series · 1 already on this canvas · 1 skipped". */
export function sendResultToast(result: LeagueSendResult): string {
    const parts: string[] = [];
    if (result.created.length > 0) parts.push(`Sent ${result.created.length} series`);
    if (result.existing.length > 0)
        parts.push(`${result.existing.length} already on this canvas`);
    const [onlySkip] = result.skipped;
    if (result.skipped.length === 1 && onlySkip)
        parts.push(`1 skipped: ${SKIP_REASONS[onlySkip.reason]}`);
    else if (result.skipped.length > 1) parts.push(`${result.skipped.length} skipped`);
    return parts.length > 0 ? parts.join(" · ") : "Nothing sent";
}

/** The group to pan to after a send: first created, else first existing. */
export function focusGroupId(result: LeagueSendResult): string | null {
    return result.created[0]?.groupId ?? result.existing[0]?.groupId ?? null;
}
