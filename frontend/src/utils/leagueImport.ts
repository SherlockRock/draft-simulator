import type {
    EsclubSeriesItem,
    EsclubSyncView,
    LeagueImport,
    LeagueRefreshResponse,
    LeagueSendResponse,
    LeagueSendSkipReason
} from "@draft-sim/shared-types";
import type { EsclubActionResult } from "./esclubSync";

export type LeagueSeriesStatus = LeagueImport["status"];

/** What an imported canvas group carries as `group.LeagueImport` (plan D8). */
export type LeagueImportView = LeagueImport;

export type { LeagueSendSkipReason };

/** Response of `POST /api/canvas/:canvasId/import/league-series` (plan D5). */
export type LeagueSendResult = LeagueSendResponse;

/** Response of `POST /api/canvas/:canvasId/group/:groupId/league-refresh` (plan D6). */
export type LeagueRefreshResult = LeagueRefreshResponse;

/**
 * How step 1 of "Refresh from league" (S2's serie refresh) ended:
 * - `skipped-complete`: the series is complete in the mirror, esclub not called;
 * - `synced`: a sync was started or joined and polled (its last view);
 * - `cooldown`: 200 `{cooldown}`;
 * - `refused`: a typed non-2xx answer (401, 409, 429, 503, 400);
 * - `error`: the call threw (404, 500, network) or answered something
 *   unusable (e.g. a 2xx body with neither `sync` nor `cooldown`).
 */
export type LeagueRefreshEsclubOutcome =
    | { kind: "skipped-complete" }
    | { kind: "error" }
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
    // The read schema's status is any string: offer only the ones we know.
    if (series.status !== "finished" && series.status !== "in_progress")
        return { checked: false, disabled: true, note: "unknown status" };
    if (!series.team1 || !series.team2)
        return { checked: false, disabled: true, note: "teams not known yet" };
    if (series.gameCount <= 0)
        return { checked: false, disabled: true, note: "no games yet" };
    if (series.status === "in_progress")
        return { checked: false, disabled: false, note: "in progress" };
    return { checked: true, disabled: false, note: null };
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
        case "error":
            // Said first by refreshToast, not as a trailing note.
            return null;
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
 * saying. A signed-out press with no apply result just asks to sign in; a
 * step 1 that couldn't run leads with that, then the apply result.
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
    if (esclubOutcome.kind === "error") return `Couldn't reach esclub refresh · ${head}`;
    return note ? `${head} · ${note}` : head;
}

const SKIP_REASONS: Record<LeagueSendSkipReason, string> = {
    "no-teams": "teams not known yet",
    "no-games": "no games yet",
    upcoming: "upcoming",
    "unsupported-length": "unsupported series length",
    "not-found": "not found",
    "not-linkable": "teams can't be linked"
};

// The wire reason is any string (a newer server may add one): word the known
// ones, show the rest as sent.
function skipReasonText(reason: string): string {
    const known = Object.entries(SKIP_REASONS).find(([key]) => key === reason);
    return known ? known[1] : reason;
}

/** "Sent 3 series · 1 already on this canvas · 1 skipped". */
export function sendResultToast(result: LeagueSendResult): string {
    const parts: string[] = [];
    if (result.created.length > 0) parts.push(`Sent ${result.created.length} series`);
    if (result.existing.length > 0)
        parts.push(`${result.existing.length} already on this canvas`);
    const [onlySkip] = result.skipped;
    if (result.skipped.length === 1 && onlySkip)
        parts.push(`1 skipped: ${skipReasonText(onlySkip.reason)}`);
    else if (result.skipped.length > 1) parts.push(`${result.skipped.length} skipped`);
    return parts.length > 0 ? parts.join(" · ") : "Nothing sent";
}

/** The group to pan to after a send: first created, else first existing. */
export function focusGroupId(result: LeagueSendResult): string | null {
    return result.created[0]?.groupId ?? result.existing[0]?.groupId ?? null;
}

/** The server's cap on one send (`MAX_SERIES_PER_SEND` in send.js). */
export const MAX_SERIES_PER_SEND = 50;

export type LeagueOption = { id: string; name: string };

type LinkedTeam = {
    id: string;
    name: string;
    tournament_id?: string | null;
    Tournament?: { id: string; name: string; source: string } | null;
};

/** The parts of a canvas group the "From league" tab reads. */
export type LeagueCanvasGroup = {
    Team1?: LinkedTeam | null;
    Team2?: LinkedTeam | null;
    LeagueImport?: LeagueImportView | null;
};

function linkedTeams(groups: LeagueCanvasGroup[]): LinkedTeam[] {
    return groups
        .flatMap((g) => [g.Team1, g.Team2])
        .filter((t): t is LinkedTeam => t != null);
}

const byName = (a: LeagueOption, b: LeagueOption) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/**
 * The league select (Q1 A): your esclub leagues from the Teams page (archived
 * ones left out) plus the esclub leagues of teams already linked on this
 * canvas, once each, by name.
 */
export function leagueOptions(
    managed: { id: string; name: string; source: string; archived_at: string | null }[],
    groups: LeagueCanvasGroup[]
): LeagueOption[] {
    const options = new Map<string, LeagueOption>();
    for (const team of linkedTeams(groups)) {
        const t = team.Tournament;
        if (t && t.source === "esclub") options.set(t.id, { id: t.id, name: t.name });
    }
    for (const t of managed) {
        if (t.source !== "esclub") continue;
        if (t.archived_at !== null && !options.has(t.id)) continue;
        options.set(t.id, { id: t.id, name: t.name });
    }
    return [...options.values()].sort(byName);
}

/**
 * The team select for one league: its teams from the Teams page plus the ones
 * linked on this canvas (a league only linked here has no Teams-page rows).
 */
export function leagueTeamOptions(
    tournamentId: string,
    managedTeams: { id: string; name: string; tournament_id?: string | null }[],
    groups: LeagueCanvasGroup[]
): LeagueOption[] {
    const options = new Map<string, LeagueOption>();
    for (const team of [...managedTeams, ...linkedTeams(groups)]) {
        if (team.tournament_id === tournamentId)
            options.set(team.id, { id: team.id, name: team.name });
    }
    return [...options.values()].sort(byName);
}

/** The league series already on this canvas (D4), for the checklist. */
export function onCanvasSeriesIds(groups: LeagueCanvasGroup[]): Set<string> {
    const ids = new Set<string>();
    for (const g of groups) {
        if (g.LeagueImport) ids.add(g.LeagueImport.leagueSeriesId);
    }
    return ids;
}

/** Every pre-checkable (finished, enabled) row: "Check all finished". */
export function finishedIds(rows: SeriesPickerRow[]): Set<string> {
    return new Set(rows.filter((r) => r.checked && !r.disabled).map((r) => r.id));
}

/**
 * The checklist's starting selection (Q4 A): the pre-checked rows, at most
 * the newest `MAX_SERIES_PER_SEND` (rows come newest first), so a default
 * send is never over the server's cap.
 */
export function checkedIds(rows: SeriesPickerRow[]): Set<string> {
    return new Set([...finishedIds(rows)].slice(0, MAX_SERIES_PER_SEND));
}

export type SeriesSelection = {
    /** The list (league and team) the selection was seeded for. */
    seededFor: string | null;
    checked: Set<string>;
};

/**
 * Seed the checklist once per list (league and team): a background refetch
 * of the same list keeps the user's picks, and nothing changes while the
 * list is still loading (`rows` null). Returns `state` itself when unchanged.
 */
export function seedSelection(
    state: SeriesSelection,
    listKey: string,
    rows: SeriesPickerRow[] | null
): SeriesSelection {
    if (rows === null || state.seededFor === listKey) return state;
    return { seededFor: listKey, checked: checkedIds(rows) };
}

const SERIES_STATUSES: readonly LeagueSeriesStatus[] = [
    "upcoming",
    "in_progress",
    "finished"
];

/**
 * After a refresh's apply: the group's LeagueImport with the mirror's status
 * and complete flag, or null when they already match (the apply broadcasts
 * only when games changed, so a status-only change must be patched in by the
 * caller). A status this client doesn't know keeps the current one.
 */
export function leagueImportAfterApply(
    current: LeagueImportView,
    series: LeagueRefreshResult["series"]
): LeagueImportView | null {
    const status =
        SERIES_STATUSES.find((known) => known === series.status) ?? current.status;
    if (status === current.status && series.complete === current.complete) return null;
    return { ...current, status, complete: series.complete };
}

/** Per-game sides, first pick and winner: read-only on an imported series (Q3 A). */
export function canEditSeriesGames(
    canEdit: boolean,
    leagueImport: LeagueImportView | null | undefined
): boolean {
    return canEdit && !leagueImport;
}

/** A per-game control's tooltip, marked "set by esclub" on an imported series. */
export function seriesGameControlTitle(
    title: string,
    leagueImport: LeagueImportView | null | undefined
): string {
    return leagueImport ? `${title} · set by esclub` : title;
}

/** "Send N series", disabled at 0 and above the server's cap. */
export function sendButtonLabel(count: number): { label: string; disabled: boolean } {
    if (count > MAX_SERIES_PER_SEND)
        return {
            label: `At most ${MAX_SERIES_PER_SEND} series per send`,
            disabled: true
        };
    return { label: `Send ${count} series`, disabled: count === 0 };
}

/**
 * A failed send, by HTTP status (null: network or an unreadable reply). The
 * send is never replayed after a 401; the session is refreshed for the next
 * press instead.
 */
export function leagueSendErrorMessage(status: number | null): string {
    switch (status) {
        case 401:
            return "Your session expired · press Send again, or sign in";
        case 403:
            return "You can't edit this canvas";
        case 404:
            return "Canvas not found";
        case 400:
            return "Couldn't send these series";
        default:
            return "Couldn't send the series · try again";
    }
}

/** The header refresh button's tooltip (D7). */
export function refreshButtonTitle(view: LeagueImportView, running: boolean): string {
    if (running) return "Refreshing…";
    return view.complete
        ? "Series finished · re-apply from league"
        : "Refresh from league";
}
