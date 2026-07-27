import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { useQueries, type QueryClient } from "@tanstack/solid-query";
import type { PlayerScoutResult } from "@draft-sim/shared-types";
import { ApiError } from "../../utils/apiClient";
import { scoutPlayers } from "../../utils/scoutingApi";
import type { PlayerId } from "../../utils/playerStats";
import type { ScoutSide } from "./rosterWriteBackState";

// Columns render from PER-PLAYER cache entries, but fetching stays BATCHED.
//
// Both halves are load-bearing. Per-player keys mean a promotion finds the four
// unchanged starters cached and fetches only the newcomer — and the true cost of
// a re-scout is far higher than it looks, because scoutPlayer loops the five
// role ids, one u.gg POST per role: five players is 25 sequential POSTs.
//
// Batching is not an optimisation either. `POST /player` and `POST /players`
// share ONE perUserThrottle({ windowMs: 10_000, max: 3 }) instance, so five
// concurrent per-player requests would 429 two of the five columns on every
// scout. And `fetcher = new UggFetcher()` is a default parameter, so every
// scoutPlayer call builds a fresh TokenBucket — there is no global u.gg rate
// limit to lean on instead.

const SIDES: ScoutSide[] = ["you", "enemy"];

// setQueryData entries are hand-written, so `staleTime` (a useQuery config)
// does not govern them; freshness is decided against dataUpdatedAt here.
const FRESH_MS = 5 * 60 * 1000;

// Coalesces a burst of changes into one batch. It does NOT rescue four
// deliberate drags a second apart — that is the 3-per-10s budget, and the
// answer to it is an honest 429 message, not a longer window.
const DEBOUNCE_MS = 400;

export type ScoutBatchError = "throttled" | "failed";

const playerKey = (p: { gameName: string; tagLine: string }): string =>
    `${p.gameName.toLowerCase()}#${p.tagLine.toLowerCase()}`;

export const scoutPlayerQueryKey = (
    region: string,
    player: { gameName: string; tagLine: string }
): [string, string, string] => ["scoutPlayer", region, playerKey(player)];

// Identity of one wanted fetch. The region is part of it: the same player in
// two regions is two different results.
const entryId = (region: string, player: { gameName: string; tagLine: string }): string =>
    `${region}|${playerKey(player)}`;

interface DesiredEntry {
    side: ScoutSide;
    region: string;
    player: PlayerId;
    id: string;
    queryKey: [string, string, string];
}

export interface ScoutFetchDeps {
    /** Passed explicitly: there is no DOM in which to mount a provider. */
    queryClient: QueryClient;
    /** The (at most five) players a side's scout request carries. */
    slottedFor: (side: ScoutSide) => PlayerId[];
    regionFor: (side: ScoutSide) => string;
    /** The enemy side only participates in matchup mode. */
    isActive: (side: ScoutSide) => boolean;
    fetchPlayers?: (input: {
        region: string;
        players: PlayerId[];
    }) => Promise<{ results: PlayerScoutResult[] }>;
    debounceMs?: number;
    freshMs?: number;
    now?: () => number;
}

export interface ScoutFetch {
    resultFor: (side: ScoutSide, player: PlayerId) => PlayerScoutResult | null;
    /** The results for `players`, in order, skipping any not yet fetched. */
    resultsFor: (side: ScoutSide, players: PlayerId[]) => PlayerScoutResult[];
    isFetching: (side: ScoutSide) => boolean;
    errorFor: (side: ScoutSide) => ScoutBatchError | null;
    isError: (side: ScoutSide) => boolean;
    /**
     * Every slotted player has a result. The readiness guard for auto-assign —
     * anything weaker normalizes role assignment on partial data. False after a
     * batch-level failure, because that leaves the cache untouched.
     */
    hasCompleteResultsFor: (side: ScoutSide) => boolean;
    /**
     * A scout has been attempted for this side and is no longer outstanding —
     * successfully OR not. The render gate, and the bench's gate.
     *
     * Deliberately weaker than hasCompleteResultsFor: a batch-level u.gg failure
     * must still show the bench, because rearranging a lineup by hand is exactly
     * what a user wants in that state (decision 44).
     */
    hasScoutedFor: (side: ScoutSide) => boolean;
}

type SideMap<T> = Record<ScoutSide, T>;

const bySide = <T>(value: T): SideMap<T> => ({ you: value, enemy: value });

/**
 * Owns every scout fetch on the page.
 *
 * Must be called inside a reactive owner (a component body, or `createRoot` in
 * tests): it creates the query observers, an effect and an `onCleanup`. The
 * observers exist so that cache reads are reactive; they are permanently
 * disabled, and this coordinator is the sole writer of their entries.
 */
export function createScoutFetch(deps: ScoutFetchDeps): ScoutFetch {
    const client = deps.queryClient;
    const fetchPlayers = deps.fetchPlayers ?? scoutPlayers;
    const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    const freshMs = deps.freshMs ?? FRESH_MS;
    const now = deps.now ?? (() => Date.now());

    // What we want fetched, per side, with each side's region captured now.
    const desired = createMemo<DesiredEntry[]>(() =>
        SIDES.filter((side) => deps.isActive(side)).flatMap((side) => {
            const region = deps.regionFor(side);
            return deps.slottedFor(side).map((player) => ({
                side,
                region,
                player,
                id: entryId(region, player),
                queryKey: scoutPlayerQueryKey(region, player)
            }));
        })
    );

    // One observer per distinct entry. Both sides may want the same player.
    const observedEntries = createMemo<DesiredEntry[]>(() => {
        const seen = new Set<string>();
        return desired().filter((e) => {
            if (seen.has(e.id)) return false;
            seen.add(e.id);
            return true;
        });
    });

    // Never called: `enabled` is false and the coordinator writes every entry.
    // Typed so the observers carry PlayerScoutResult rather than unknown.
    const neverFetch = (): Promise<PlayerScoutResult> =>
        Promise.reject(new Error("scout entries are written by the coordinator"));

    const observed = useQueries(
        () => ({
            queries: observedEntries().map((e) => ({
                queryKey: e.queryKey,
                queryFn: neverFetch,
                enabled: false,
                retry: false,
                staleTime: freshMs
            }))
        }),
        () => client
    );

    // Keyed by the result's OWN input, which echoes the region and spelling the
    // request was made with — so a mid-flight region change can never file a
    // result under the wrong key, and no index-zipping is needed.
    const cached = createMemo(() => {
        const map = new Map<string, PlayerScoutResult>();
        for (const query of observed) {
            const data = query.data;
            if (data) map.set(entryId(data.input.region, data.input), data);
        }
        return map;
    });

    const [fetching, setFetching] = createSignal<SideMap<number>>(bySide(0));
    const [settled, setSettled] = createSignal<SideMap<boolean>>(bySide(false));
    const [errors, setErrors] = createSignal<SideMap<ScoutBatchError | null>>(
        bySide(null)
    );

    // Non-reactive bookkeeping. Reading these must never re-trigger the effect.
    const inFlight = new Set<string>();
    // Keys whose batch was REJECTED. They are not retried automatically: a
    // rejection leaves the cache untouched, so they are still "missing", and a
    // trailing batch would fire immediately, burn more of the 3-per-10s budget,
    // fail again, and never reach a stable error state.
    const failed = new Set<string>();
    // Keys that became desired while a batch was in flight. They are recorded
    // rather than requested, and go out as ONE trailing batch when it settles —
    // so a promotion mid-flight starts no second batch, and is still fetched.
    const trailing = new Map<string, DesiredEntry>();

    const isFresh = (entry: DesiredEntry): boolean => {
        const updatedAt = client.getQueryState(entry.queryKey)?.dataUpdatedAt;
        return !!updatedAt && now() - updatedAt < freshMs;
    };

    const bumpFetching = (side: ScoutSide, delta: number): void => {
        setFetching((prev) => ({ ...prev, [side]: prev[side] + delta }));
    };

    const runBatch = async (side: ScoutSide, batch: DesiredEntry[]): Promise<void> => {
        // Captured at request time, not read at fan-out time.
        const region = batch[0].region;
        batch.forEach((e) => inFlight.add(e.id));
        bumpFetching(side, 1);
        try {
            const response = await fetchPlayers({
                region,
                players: batch.map((e) => ({
                    gameName: e.player.gameName,
                    tagLine: e.player.tagLine
                }))
            });
            // Per-player error rows cache normally — the backend turns a single
            // bad Riot ID into a result row rather than failing the batch.
            for (const result of response.results) {
                client.setQueryData(scoutPlayerQueryKey(region, result.input), result);
            }
            setErrors((prev) => ({ ...prev, [side]: null }));
        } catch (error) {
            batch.forEach((e) => failed.add(e.id));
            // A throttle rejection is not an upstream outage, and telling the
            // user u.gg is down when they simply dragged four times in ten
            // seconds sends them away instead of making them wait.
            setErrors((prev) => ({
                ...prev,
                [side]:
                    error instanceof ApiError && error.status === 429
                        ? "throttled"
                        : "failed"
            }));
        } finally {
            batch.forEach((e) => inFlight.delete(e.id));
            setSettled((prev) => (prev[side] ? prev : { ...prev, [side]: true }));
            bumpFetching(side, -1);
            flushTrailing();
        }
    };

    // One batch per side. Sides can carry different regions, so a merged batch
    // is impossible anyway — and a merged missing-set could reach ten players
    // and 400 against MAX_SCOUT_PLAYERS.
    const issueBatches = (entries: DesiredEntry[]): void => {
        const batches = new Map<ScoutSide, DesiredEntry[]>();
        const claimed = new Set<string>();
        for (const entry of entries) {
            // Do not re-request what another side's batch in this same pass
            // already covers.
            if (claimed.has(entry.id)) continue;
            claimed.add(entry.id);
            const batch = batches.get(entry.side) ?? [];
            batch.push(entry);
            batches.set(entry.side, batch);
        }
        for (const [side, batch] of batches) {
            if (batch.length > 0) void runBatch(side, batch);
        }
    };

    const missingFrom = (entries: DesiredEntry[]): DesiredEntry[] =>
        entries.filter((e) => !inFlight.has(e.id) && !failed.has(e.id) && !isFresh(e));

    const flushTrailing = (): void => {
        if (inFlight.size > 0 || trailing.size === 0) return;
        const recorded = [...trailing.values()];
        trailing.clear();
        const stillWanted = new Set(desired().map((e) => e.id));
        const batch = missingFrom(recorded.filter((e) => stillWanted.has(e.id)));
        if (batch.length > 0) issueBatches(batch);
    };

    const runPass = (entries: DesiredEntry[]): void => {
        const missing = missingFrom(entries);
        if (inFlight.size > 0) {
            // Everything still missing while a batch is in flight is by
            // definition newly desired — the in-flight batch's own keys are
            // excluded above.
            for (const entry of missing) {
                if (!trailing.has(entry.id)) trailing.set(entry.id, entry);
            }
            return;
        }
        if (missing.length > 0) issueBatches(missing);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSignature = "";
    createEffect(() => {
        const entries = desired();
        const signature = entries
            .map((e) => e.id)
            .sort()
            .join(",");
        if (signature !== lastSignature) {
            lastSignature = signature;
            // Wanting something different re-enables the failed keys and clears
            // a stale banner. A bench-only reorder does not change this, so it
            // does not retry anything either.
            failed.clear();
            setErrors(bySide(null));
        }
        clearTimeout(timer);
        timer = setTimeout(() => runPass(entries), debounceMs);
    });
    onCleanup(() => clearTimeout(timer));

    const resultFor = (side: ScoutSide, player: PlayerId): PlayerScoutResult | null =>
        cached().get(entryId(deps.regionFor(side), player)) ?? null;

    const hasCompleteResultsFor = (side: ScoutSide): boolean => {
        const slotted = deps.slottedFor(side);
        if (slotted.length === 0) return false;
        const entries = cached();
        const region = deps.regionFor(side);
        return slotted.every((p) => entries.has(entryId(region, p)));
    };

    return {
        resultFor,
        resultsFor: (side, players) =>
            players.flatMap((p) => {
                const result = resultFor(side, p);
                return result ? [result] : [];
            }),
        isFetching: (side) => fetching()[side] > 0,
        errorFor: (side) => errors()[side],
        isError: (side) => errors()[side] !== null,
        hasCompleteResultsFor,
        // The settled flag alone would strand a remount whose players are all
        // still cached: no batch is needed, so nothing ever settles, and the
        // page would render nothing. Having every result IS having scouted.
        hasScoutedFor: (side) =>
            deps.slottedFor(side).length > 0 &&
            (settled()[side] || hasCompleteResultsFor(side))
    };
}
