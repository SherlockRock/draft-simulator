import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, type Setter } from "solid-js";
import { QueryClient } from "@tanstack/solid-query";
import type { PlayerScoutResult } from "@draft-sim/shared-types";
import { ApiError } from "../../utils/apiClient";
import type { PlayerId } from "../../utils/playerStats";
import type { ScoutSide } from "./rosterWriteBackState";
import {
    createScoutFetch,
    scoutPlayerQueryKey,
    type ScoutFetch
} from "./scoutFetchCoordinator";

// Node env, no DOM: the coordinator takes its QueryClient explicitly, so the
// observers it creates need no QueryClientProvider to mount into.

const DEBOUNCE = 400;

const id = (gameName: string): PlayerId => ({ gameName, tagLine: "NA1" });

const okResult = (
    gameName: string,
    region = "na1",
    fetchedAt = "2026-07-26T00:00:00Z"
): PlayerScoutResult => ({
    status: "ok",
    input: { region, gameName, tagLine: "NA1" },
    envelope: {
        provider: "ugg",
        schemaVersion: 1,
        fetchedAt,
        season: "S2026",
        queue: "ranked_solo",
        entries: []
    }
});

const errResult = (gameName: string, region = "na1"): PlayerScoutResult => ({
    status: "error",
    input: { region, gameName, tagLine: "NA1" },
    error: "not found"
});

type SideMap<T> = Record<ScoutSide, T>;

interface BatchCall {
    region: string;
    players: PlayerId[];
    refresh?: boolean;
    resolve: (results: PlayerScoutResult[]) => void;
    reject: (error: unknown) => void;
}

interface Harness {
    fetch: ScoutFetch;
    client: QueryClient;
    calls: BatchCall[];
    setSlotted: Setter<SideMap<PlayerId[]>>;
    setRegions: Setter<SideMap<string>>;
    setActive: Setter<SideMap<boolean>>;
    dispose: () => void;
}

interface Options {
    slotted?: Partial<SideMap<PlayerId[]>>;
    regions?: Partial<SideMap<string>>;
    active?: Partial<SideMap<boolean>>;
    seed?: { region: string; result: PlayerScoutResult }[];
}

const setup = (options: Options = {}): Harness => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    });
    for (const { region, result } of options.seed ?? []) {
        client.setQueryData(scoutPlayerQueryKey(region, result.input), result);
    }
    const calls: BatchCall[] = [];

    return createRoot((dispose) => {
        const [slotted, setSlotted] = createSignal<SideMap<PlayerId[]>>({
            you: options.slotted?.you ?? [],
            enemy: options.slotted?.enemy ?? []
        });
        const [regions, setRegions] = createSignal<SideMap<string>>({
            you: options.regions?.you ?? "na1",
            enemy: options.regions?.enemy ?? "na1"
        });
        const [active, setActive] = createSignal<SideMap<boolean>>({
            you: options.active?.you ?? true,
            enemy: options.active?.enemy ?? false
        });

        const fetch = createScoutFetch({
            queryClient: client,
            slottedFor: (side) => slotted()[side],
            regionFor: (side) => regions()[side],
            isActive: (side) => active()[side],
            fetchPlayers: (input) =>
                new Promise((resolve, reject) => {
                    calls.push({
                        region: input.region,
                        players: input.players,
                        refresh: input.refresh,
                        resolve: (results) => resolve({ results }),
                        reject
                    });
                }),
            debounceMs: DEBOUNCE
        });

        return { fetch, client, calls, setSlotted, setRegions, setActive, dispose };
    });
};

// Lets the debounce fire and every queued microtask drain — the query
// observers propagate through queueMicrotask and a resource.
const settle = async (ms = DEBOUNCE): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
};

describe("createScoutFetch", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    describe("batching", () => {
        it("requests every missing player in one batch", async () => {
            const h = setup({ slotted: { you: [id("A"), id("B"), id("C")] } });
            await settle();

            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].region).toBe("na1");
            expect(h.calls[0].players.map((p) => p.gameName)).toEqual(["A", "B", "C"]);
            h.dispose();
        });

        it("requests only the player missing from the cache", async () => {
            const h = setup({
                slotted: { you: [id("A"), id("B"), id("C"), id("D"), id("E")] },
                seed: ["A", "B", "C", "D"].map((n) => ({
                    region: "na1",
                    result: okResult(n)
                }))
            });
            await settle();

            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].players.map((p) => p.gameName)).toEqual(["E"]);
            h.dispose();
        });

        it("requests nothing when every player is already cached", async () => {
            const h = setup({
                slotted: { you: [id("A"), id("B")] },
                seed: ["A", "B"].map((n) => ({ region: "na1", result: okResult(n) }))
            });
            await settle();

            expect(h.calls).toEqual([]);
            h.dispose();
        });

        it("requests nothing for a side that is not active", async () => {
            const h = setup({
                slotted: { you: [id("A")], enemy: [id("Z")] },
                active: { you: true, enemy: false }
            });
            await settle();

            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].players.map((p) => p.gameName)).toEqual(["A"]);
            h.dispose();
        });

        // Sides can carry different regions, so a merged batch is impossible —
        // and a merged missing-set could reach ten players and 400.
        it("issues one batch per side", async () => {
            const h = setup({
                slotted: { you: [id("A")], enemy: [id("Z")] },
                regions: { you: "na1", enemy: "kr" },
                active: { you: true, enemy: true }
            });
            await settle();

            expect(h.calls).toHaveLength(2);
            expect(h.calls.map((c) => c.region).sort()).toEqual(["kr", "na1"]);
            h.dispose();
        });

        it("does not double-request a player both sides want", async () => {
            const h = setup({
                slotted: { you: [id("A"), id("Shared")], enemy: [id("Shared")] },
                active: { you: true, enemy: true }
            });
            await settle();

            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].players.map((p) => p.gameName)).toEqual(["A", "Shared"]);
            h.dispose();
        });

        // Freshness is decided against dataUpdatedAt: staleTime is a useQuery
        // config and does not govern hand-written setQueryData entries. It is
        // evaluated when a pass runs — there is no background poller, and one
        // would burn the 3-per-10s budget on its own.
        it("refetches an entry that is present but stale", async () => {
            const h = setup({ seed: [{ region: "na1", result: okResult("A") }] });
            await settle(6 * 60 * 1000);

            h.setSlotted({ you: [id("A")], enemy: [] });
            await settle();

            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].players.map((p) => p.gameName)).toEqual(["A"]);
            h.dispose();
        });

        it("leaves a fresh entry alone when the wanted set changes around it", async () => {
            const h = setup({
                slotted: { you: [id("A")] },
                seed: [{ region: "na1", result: okResult("A") }]
            });
            await settle();
            expect(h.calls).toEqual([]);

            h.setSlotted({ you: [id("A"), id("B")], enemy: [] });
            await settle();

            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].players.map((p) => p.gameName)).toEqual(["B"]);
            h.dispose();
        });
    });

    describe("fan-out", () => {
        it("writes one cache entry per player, reactively", async () => {
            const h = setup({ slotted: { you: [id("A"), id("B")] } });
            await settle();
            expect(h.fetch.resultFor("you", id("A"))).toBeNull();

            h.calls[0].resolve([okResult("A"), okResult("B")]);
            await settle(0);

            expect(h.client.getQueryData(scoutPlayerQueryKey("na1", id("A")))).toEqual(
                okResult("A")
            );
            // The reactive read is the one that matters: an observer that does
            // not update leaves the render gate permanently closed.
            expect(h.fetch.resultFor("you", id("A"))).toEqual(okResult("A"));
            expect(h.fetch.resultFor("you", id("B"))).toEqual(okResult("B"));
            expect(h.fetch.resultsFor("you", [id("B"), id("A")])).toEqual([
                okResult("B"),
                okResult("A")
            ]);
            h.dispose();
        });

        it("caches a per-player error row and does not re-request it", async () => {
            const h = setup({ slotted: { you: [id("A"), id("Bad")] } });
            await settle();
            h.calls[0].resolve([okResult("A"), errResult("Bad")]);
            await settle(0);

            expect(h.fetch.resultFor("you", id("Bad"))).toEqual(errResult("Bad"));
            expect(h.fetch.hasCompleteResultsFor("you")).toBe(true);

            await settle();
            expect(h.calls).toHaveLength(1);
            h.dispose();
        });

        it("files results under the region they were requested with", async () => {
            const h = setup({ slotted: { you: [id("A")] }, regions: { you: "na1" } });
            await settle();

            // The region changes while the batch is in flight.
            h.setRegions({ you: "kr", enemy: "na1" });
            h.calls[0].resolve([okResult("A", "na1")]);
            await settle(0);

            expect(h.client.getQueryData(scoutPlayerQueryKey("na1", id("A")))).toEqual(
                okResult("A", "na1")
            );
            expect(
                h.client.getQueryData(scoutPlayerQueryKey("kr", id("A")))
            ).toBeUndefined();
            h.dispose();
        });
    });

    describe("in-flight and trailing batches", () => {
        it("records a mid-flight promotion and fetches it once the batch settles", async () => {
            const h = setup({ slotted: { you: [id("A"), id("B")] } });
            await settle();
            expect(h.calls).toHaveLength(1);

            // Promotion while the first batch is outstanding.
            h.setSlotted({ you: [id("A"), id("B"), id("Sub")], enemy: [] });
            await settle();
            // No second batch: the four pending players must not look missing.
            expect(h.calls).toHaveLength(1);

            h.calls[0].resolve([okResult("A"), okResult("B")]);
            await settle(0);

            // ...but the newcomer IS fetched. Asserting only "no second batch"
            // would pass an implementation that never fetches them at all.
            expect(h.calls).toHaveLength(2);
            expect(h.calls[1].players.map((p) => p.gameName)).toEqual(["Sub"]);
            h.dispose();
        });

        it("drops a trailing key that is no longer wanted", async () => {
            const h = setup({ slotted: { you: [id("A")] } });
            await settle();

            h.setSlotted({ you: [id("A"), id("Sub")], enemy: [] });
            await settle();
            h.setSlotted({ you: [id("A")], enemy: [] });
            await settle();

            h.calls[0].resolve([okResult("A")]);
            await settle(0);

            expect(h.calls).toHaveLength(1);
            h.dispose();
        });
    });

    describe("batch-level failure", () => {
        it("reports the failure, leaves the cache untouched and does not retry", async () => {
            const h = setup({ slotted: { you: [id("A"), id("B")] } });
            await settle();

            h.calls[0].reject(new ApiError(502));
            await settle(0);

            expect(h.fetch.isError("you")).toBe(true);
            expect(h.fetch.errorFor("you")).toBe("failed");
            expect(h.fetch.isFetching("you")).toBe(false);
            expect(
                h.client.getQueryData(scoutPlayerQueryKey("na1", id("A")))
            ).toBeUndefined();

            // A rejection leaves those keys missing, so an unscoped trailing
            // rule would fire again immediately, burn the 3-per-10s budget and
            // never reach a stable error state.
            await settle(10_000);
            expect(h.calls).toHaveLength(1);
            h.dispose();
        });

        it("distinguishes a throttle rejection from an upstream failure", async () => {
            const h = setup({ slotted: { you: [id("A")] } });
            await settle();

            h.calls[0].reject(new ApiError(429));
            await settle(0);

            expect(h.fetch.errorFor("you")).toBe("throttled");
            h.dispose();
        });

        it("retries the failed players once the wanted set changes, and clears", async () => {
            const h = setup({ slotted: { you: [id("A")] } });
            await settle();
            h.calls[0].reject(new ApiError(502));
            await settle(0);
            expect(h.fetch.isError("you")).toBe(true);

            h.setSlotted({ you: [id("A"), id("B")], enemy: [] });
            await settle();
            expect(h.fetch.isError("you")).toBe(false);
            expect(h.calls).toHaveLength(2);
            expect(h.calls[1].players.map((p) => p.gameName)).toEqual(["A", "B"]);

            h.calls[1].resolve([okResult("A"), okResult("B")]);
            await settle(0);
            expect(h.fetch.isError("you")).toBe(false);
            h.dispose();
        });
    });

    // The backend caches u.gg envelopes for 20 minutes, so "wait for it to go
    // stale" is not an answer for someone who just played a game.
    describe("deliberate refresh", () => {
        it("re-requests a fresh player, telling the backend to bypass its cache", async () => {
            const h = setup({
                slotted: { you: [id("A"), id("B")] },
                seed: ["A", "B"].map((n) => ({ region: "na1", result: okResult(n) }))
            });
            await settle();
            expect(h.calls).toEqual([]);

            h.fetch.refreshPlayer("you", id("A"));
            await settle(0);

            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].players.map((p) => p.gameName)).toEqual(["A"]);
            expect(h.calls[0].refresh).toBe(true);
            h.dispose();
        });

        it("writes the refreshed envelope over the stale entry", async () => {
            const h = setup({
                slotted: { you: [id("A")] },
                seed: [{ region: "na1", result: okResult("A") }]
            });
            await settle();

            h.fetch.refreshPlayer("you", id("A"));
            await settle(0);
            const refreshed = okResult("A", "na1", "2026-07-27T09:00:00Z");
            h.calls[0].resolve([refreshed]);
            await settle(0);

            expect(h.fetch.resultFor("you", id("A"))).toEqual(refreshed);
            h.dispose();
        });

        it("marks the side as fetching while the refresh is outstanding", async () => {
            const h = setup({
                slotted: { you: [id("A")] },
                seed: [{ region: "na1", result: okResult("A") }]
            });
            await settle();

            h.fetch.refreshPlayer("you", id("A"));
            await settle(0);
            expect(h.fetch.isFetching("you")).toBe(true);

            h.calls[0].resolve([okResult("A")]);
            await settle(0);
            expect(h.fetch.isFetching("you")).toBe(false);
            h.dispose();
        });

        // Double-clicking the button must not spend two of the three requests
        // the user gets every ten seconds.
        it("ignores a refresh for a player already being fetched", async () => {
            const h = setup({ slotted: { you: [id("A")] } });
            await settle();
            expect(h.calls).toHaveLength(1);

            h.fetch.refreshPlayer("you", id("A"));
            await settle(0);

            expect(h.calls).toHaveLength(1);
            h.dispose();
        });

        it("surfaces a failed refresh as the side's error", async () => {
            const h = setup({
                slotted: { you: [id("A")] },
                seed: [{ region: "na1", result: okResult("A") }]
            });
            await settle();

            h.fetch.refreshPlayer("you", id("A"));
            await settle(0);
            h.calls[0].reject(new ApiError(429));
            await settle(0);

            expect(h.fetch.errorFor("you")).toBe("throttled");
            expect(h.fetch.isFetching("you")).toBe(false);
            // The stale entry survives a failed refresh — losing the data the
            // user was reading would be a worse outcome than stale data.
            expect(h.fetch.resultFor("you", id("A"))).toEqual(okResult("A"));
            h.dispose();
        });
    });

    describe("readiness predicates", () => {
        it("are both false for an empty slotted set", () => {
            const h = setup();
            expect(h.fetch.hasCompleteResultsFor("you")).toBe(false);
            expect(h.fetch.hasScoutedFor("you")).toBe(false);
            h.dispose();
        });

        // The pair that keeps the bench reachable: a batch-level failure leaves
        // the cache untouched, so "every slotted player has an entry" is false
        // in exactly the state where rearranging a lineup by hand matters most.
        it("disagree after a batch-level failure", async () => {
            const h = setup({ slotted: { you: [id("A"), id("B")] } });
            await settle();
            h.calls[0].reject(new ApiError(502));
            await settle(0);

            expect(h.fetch.hasCompleteResultsFor("you")).toBe(false);
            expect(h.fetch.hasScoutedFor("you")).toBe(true);
            h.dispose();
        });

        it("agree when every slotted player has a cached error row", async () => {
            const h = setup({ slotted: { you: [id("A"), id("B")] } });
            await settle();
            h.calls[0].resolve([errResult("A"), errResult("B")]);
            await settle(0);

            expect(h.fetch.hasCompleteResultsFor("you")).toBe(true);
            expect(h.fetch.hasScoutedFor("you")).toBe(true);
            h.dispose();
        });

        it("is false while a batch is still outstanding", async () => {
            const h = setup({ slotted: { you: [id("A")] } });
            await settle();

            expect(h.fetch.isFetching("you")).toBe(true);
            expect(h.fetch.hasCompleteResultsFor("you")).toBe(false);
            expect(h.fetch.hasScoutedFor("you")).toBe(false);
            h.dispose();
        });

        // A remount with a warm cache needs no batch at all, so nothing ever
        // settles — gating on the settled flag alone would render nothing.
        it("counts a fully cached side as scouted without any batch", async () => {
            const h = setup({
                slotted: { you: [id("A")] },
                seed: [{ region: "na1", result: okResult("A") }]
            });
            await settle();

            expect(h.calls).toEqual([]);
            expect(h.fetch.hasCompleteResultsFor("you")).toBe(true);
            expect(h.fetch.hasScoutedFor("you")).toBe(true);
            h.dispose();
        });
    });
});
