import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Team } from "@draft-sim/shared-types";
import {
    MAX_ROSTER,
    mergeScoutedRoster,
    resolveWriteBackTeam,
    shouldStayArmed
} from "../../utils/rosterWriteBack";
import { createRosterSaver, type SavePayload } from "../../utils/rosterSaver";
import type { PlayerId } from "../../utils/playerStats";

// Structurally identical to `MatchupSide` in RoleSlot.tsx, declared here so this
// module stays free of any component (and therefore JSX) import.
export type ScoutSide = "you" | "enemy";

export type RosterWriteBackDeps = {
    /**
     * Signed-in check. `fetchTeams` returns ONLY owned teams, so this plus
     * `ownedTeams` IS the ownership gate — a shared scout link naming someone
     * else's team resolves to null and arms nothing.
     */
    isSignedIn: () => boolean;
    ownedTeams: () => Team[];
    /** The `["teams"]` lookup has succeeded — the stored roster is truly known. */
    teamsResolved: () => boolean;
    /** The `["teams"]` lookup failed — nothing will ever resolve. */
    teamsFailed: () => boolean;
    /** The `team` / `enemyTeam` URL param for a side. */
    teamIdFor: (side: ScoutSide) => string;
    /**
     * The RAW region param for a side, or undefined. Must not fall back to a
     * default: a link with `region` stripped would otherwise convert a KR team
     * to NA on the first drag (decision 28).
     */
    regionFor: (side: ScoutSide) => string | undefined;
    /** The network write (PUT /teams/:id/roster). */
    saveRoster: (teamId: string, payload: SavePayload) => Promise<void>;
    /**
     * Error surface. `id` is stable per (reason, team) so repeated drags
     * replace the toast instead of stacking a new one per drop.
     */
    notifyError: (id: string, message: string) => void;
    /**
     * Drops that side's team param, so the UI stops naming a team it will not
     * write to. Used ONLY for the replayed-gesture path; a caller that is
     * already navigating this tick must fold `"disarmed"` into its own
     * `setSearchParams` instead — see `WriteBackOutcome`.
     */
    disarm: (side: ScoutSide) => void;
    /** Debounce window for coalescing rapid swaps. */
    delayMs?: number;
    /** How long the transient "saved" marker stays up. */
    savedMarkerMs?: number;
};

/**
 * What a `writeBack` call decided to do. Returned rather than acted on, because
 * `"disarmed"` needs a URL change and `@solidjs/router` navigates inside a
 * microtask-deferred transition: a second `setSearchParams` in the same
 * synchronous tick merges against the PRE-navigation search string and, since
 * the last transition target wins, silently reverts the first one. The drag
 * gesture is already navigating when it calls `writeBack`, so it must fold this
 * into that one call instead of triggering a second.
 */
export type WriteBackOutcome =
    | "saved" // queued behind the debounce
    | "stashed" // waiting on ["teams"] to resolve
    | "disarmed" // refused: this lineup is not that team any more
    | "over-cap" // refused: the merge would exceed MAX_ROSTER
    | "inert"; // this side is not armed — nothing to do

export type RosterWriteBack = {
    /** The team a side would write to, or null when that side is not armed. */
    armedTeam: (side: ScoutSide) => Team | null;
    /** Team ids currently showing the transient "saved" marker. */
    savedTeams: () => ReadonlySet<string>;
    /**
     * THE only path to a save. Must be called from a deliberate user gesture
     * (the role-swap drag) and NEVER from a URL-normalizing effect — otherwise
     * merely opening a shared link rewrites a stored roster (decision 26).
     *
     * The caller is responsible for acting on a `"disarmed"` outcome.
     */
    writeBack: (side: ScoutSide, slots: (PlayerId | null)[]) => WriteBackOutcome;
    /**
     * submit()-time URL hygiene (decision 26a): should that side's team param
     * survive this submit? `setSearchParams` merges, so a stale id would
     * otherwise outlive the roster it describes.
     */
    shouldKeepTeamParam: (side: ScoutSide, submitted: PlayerId[]) => boolean;
};

const MISMATCH_TOAST = (teamId: string): string => `roster-mismatch:${teamId}`;
const OVER_CAP_TOAST = (teamId: string): string => `roster-over-cap:${teamId}`;

/**
 * All of the roster write-back state for /scout, extracted from the view so the
 * decision-26a corruption guard can be driven directly in node-env tests: the
 * arming composition — not the pure helpers it is built from — is the thing
 * that stops one team's players landing on another team's roster.
 *
 * Every dependency is an accessor or callback rather than a Solid context read,
 * which is exactly what makes the composition testable without a DOM.
 *
 * Must be called inside a reactive owner (a component body, or `createRoot` in
 * tests) — it registers an effect and an `onCleanup`.
 */
export function createRosterWriteBack(deps: RosterWriteBackDeps): RosterWriteBack {
    const armedTeam = (side: ScoutSide): Team | null =>
        resolveWriteBackTeam(deps.teamIdFor(side), deps.ownedTeams());

    const [savedTeams, setSavedTeams] = createSignal<ReadonlySet<string>>(new Set());
    // Per team — one shared marker would let the second side's success clear
    // the first side's.
    const savedTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const markSaved = (teamId: string): void => {
        setSavedTeams((prev) => new Set(prev).add(teamId));
        clearTimeout(savedTimers.get(teamId));
        savedTimers.set(
            teamId,
            setTimeout(() => {
                setSavedTeams((prev) => {
                    const next = new Set(prev);
                    next.delete(teamId);
                    return next;
                });
                savedTimers.delete(teamId);
            }, deps.savedMarkerMs ?? 2000)
        );
    };

    const saver = createRosterSaver({
        delayMs: deps.delayMs ?? 500,
        save: deps.saveRoster,
        onSaved: markSaved,
        onError: (teamId, error) =>
            deps.notifyError(
                `roster-error:${teamId}`,
                `Couldn't save roster: ${error.message}`
            )
    });

    onCleanup(() => {
        saver.dispose();
        savedTimers.forEach((t) => clearTimeout(t));
    });

    // A gesture that arrives before ["teams"] resolves must not be silently
    // dropped — with no save button there is nothing to retry with. Stash it
    // and flush once ownership is known. This IS gesture-originated: the effect
    // only ever replays something the user actually did, and never infers a
    // save from URL state (decision 26).
    // `teamId` is stashed alongside the lineup, NOT re-read at flush time: if
    // the `team` param changes between the drag and the flush, the stashed
    // lineup would otherwise be written onto whatever team the URL names then.
    const [pendingGesture, setPendingGesture] = createSignal<{
        side: ScoutSide;
        teamId: string;
        slots: (PlayerId | null)[];
    } | null>(null);

    // Called ONLY from the drag gesture and from the flush effect below (which
    // replays an already-made gesture). `slots` is passed in rather than
    // re-read from the URL because setSearchParams has not settled when this
    // runs, and the debounce would otherwise persist a stale lineup.
    const writeBack = (side: ScoutSide, slots: (PlayerId | null)[]): WriteBackOutcome => {
        const teamId = deps.teamIdFor(side);
        if (!teamId) return "inert";
        const team = resolveWriteBackTeam(teamId, deps.ownedTeams());
        if (!team) {
            // Stash ONLY while an armed lookup is genuinely still in flight.
            // Resolution is the gate, not "pending": a disabled v5 query
            // (anonymous user) stays pending forever, so keying off that would
            // strand the gesture instead of correctly discarding it.
            if (deps.isSignedIn() && !deps.teamsResolved() && !deps.teamsFailed()) {
                setPendingGesture({ side, teamId, slots });
                return "stashed";
            }
            return "inert";
        }
        setPendingGesture(null);
        // THE authoritative arming check (decision 26a). Here — unlike in
        // submit() — the roster is genuinely known, so there is no load-window
        // race, and this also catches hand-edited URLs that the submit path
        // structurally cannot see. Overlap, not equality: decision 27 supports
        // scouting a sub who is not yet on the roster.
        //
        // Gated on the team HAVING stored players: shouldStayArmed returns
        // false against an empty roster (nothing to overlap with), which as a
        // write gate would permanently refuse every save to a team whose roster
        // was emptied in Settings while this tab was open. With no stored
        // roster there is also nothing to protect from being overwritten.
        const storedPlayers = team.TeamPlayers ?? [];
        const lineup = slots.filter((s): s is PlayerId => s !== null);
        if (storedPlayers.length > 0 && !shouldStayArmed(storedPlayers, lineup)) {
            // Refusing silently would leave the label naming a team every later
            // drag also refuses to write to. Say so here; the caller drops the
            // now-stale param so the label goes away too.
            deps.notifyError(
                MISMATCH_TOAST(team.id),
                `These players aren't on ${team.name}, so nothing was saved. Auto-save is off — open ${team.name} from My Teams to scout it.`
            );
            return "disarmed";
        }
        const merged = mergeScoutedRoster(storedPlayers, slots);
        if (!merged.ok) {
            deps.notifyError(
                OVER_CAP_TOAST(team.id),
                `That change would give ${team.name} ${merged.count} players; the maximum is ${MAX_ROSTER}. Remove someone in Settings → My Teams.`
            );
            return "over-cap";
        }
        saver.request(team.id, { players: merged.players, region: deps.regionFor(side) });
        return "saved";
    };

    createEffect(() => {
        const pending = pendingGesture();
        if (!pending) return;
        if (deps.teamsFailed()) {
            setPendingGesture(null);
            return;
        }
        if (!deps.teamsResolved()) return;
        const currentTeamId = deps.teamIdFor(pending.side);
        setPendingGesture(null);
        // Drop rather than redirect: the gesture was made against a different
        // team than the URL now names, and replaying it would write that
        // team's lineup onto this one.
        if (currentTeamId !== pending.teamId) return;
        // Nothing is navigating on this tick (the flush is driven by ["teams"]
        // resolving, not by a URL change), so a standalone disarm is safe here.
        if (writeBack(pending.side, pending.slots) === "disarmed") {
            deps.disarm(pending.side);
        }
    });

    const shouldKeepTeamParam = (side: ScoutSide, submitted: PlayerId[]): boolean => {
        if (submitted.length === 0) return false;
        // Leniency during the load window: disarming out of pure ignorance
        // turned auto-save off for the whole session. This is URL/label hygiene
        // only — the authoritative refusal lives in writeBack, which runs when
        // the roster is actually known.
        if (!deps.teamsResolved()) return true;
        return shouldStayArmed(armedTeam(side)?.TeamPlayers ?? [], submitted);
    };

    return { armedTeam, savedTeams, writeBack, shouldKeepTeamParam };
}
