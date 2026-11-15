// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComponent, untrack, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import TeamsPage from "../pages/TeamsPage";
import { resetAuthExpired } from "./apiClient";
import type { EsclubSyncView, EsclubTournamentView } from "@draft-sim/shared-types";
import {
    addEsclubLeague,
    fetchEsclubSync,
    fetchEsclubTournament,
    refreshEsclubLeague,
    refreshEsclubSeries
} from "./actions";
import {
    ACCEPTED_LINK_EXAMPLE,
    esclubActionMessage,
    esclubActionSync,
    esclubRefreshButton,
    esclubSyncPollInterval,
    parseEsclubUrl,
    type EsclubActionResult
} from "./esclubSync";

vi.mock("./analytics", () => ({ track: vi.fn() }));
vi.mock("../userProvider", () => ({
    useUser: () => () => [() => ({ id: "user-1" })]
}));
vi.mock("../components/AuthGuard", () => ({
    AuthGuard: (props: { children: JSX.Element }) => untrack(() => props.children)
}));
vi.mock("@solidjs/meta", () => ({ Title: () => null }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("solid-toast", () => ({ default: notifications }));

afterEach(() => {
    resetAuthExpired();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
});

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ID = "12345678-1234-1234-1234-123456789abc";
const LINK = `https://esclub.gg/multimedia/serie/${ID}`;
const sync: EsclubSyncView = {
    id: "sync-1",
    kind: "add",
    status: "running",
    tournamentId: "league-1",
    stageId: null,
    seriesId: null,
    startedAt: new Date(NOW).toISOString(),
    finishedAt: null,
    requestCount: 0,
    errorClass: null,
    summary: null
};

function view(
    state: Partial<EsclubTournamentView["sync"]> = {},
    lastSyncedAt: string | null = null
): EsclubTournamentView {
    return {
        tournament: { id: "league-1", name: "League", region: "na1", lastSyncedAt },
        stages: [],
        sync: {
            running: null,
            availableAt: null,
            syncEnabled: true,
            budgetPaused: false,
            ...state
        }
    };
}

describe("esclub refresh button", () => {
    it("offers a refresh when available", () => {
        expect(esclubRefreshButton(view(), NOW)).toEqual({
            label: "Refresh league",
            disabled: false
        });
    });

    it("disables a running sync", () => {
        expect(esclubRefreshButton(view({ running: sync }), NOW)).toEqual({
            label: "Refreshing…",
            disabled: true
        });
    });

    it("shows elapsed time and remaining cooldown", () => {
        const state = view(
            { availableAt: new Date(NOW + 7 * 60_000).toISOString() },
            new Date(NOW - 3 * 60_000).toISOString()
        );
        expect(esclubRefreshButton(state, NOW)).toEqual({
            label: "Refreshed 3 min ago · available in 7 min",
            disabled: true
        });
    });

    it("rounds remaining cooldown up", () => {
        expect(
            esclubRefreshButton(
                view({ availableAt: new Date(NOW + 1).toISOString() }),
                NOW
            )
        ).toEqual({ label: "Available in 1 min", disabled: true });
    });

    it("enables exactly at the cooldown boundary", () => {
        expect(
            esclubRefreshButton(view({ availableAt: new Date(NOW).toISOString() }), NOW)
        ).toEqual({ label: "Refresh league", disabled: false });
    });

    it("shows the kill switch even if a cooldown exists", () => {
        expect(
            esclubRefreshButton(view({ syncEnabled: false, budgetPaused: true }), NOW)
        ).toEqual({ label: "Sync is off", disabled: true });
    });

    it("shows the budget pause", () => {
        expect(esclubRefreshButton(view({ budgetPaused: true }), NOW)).toEqual({
            label: "Paused until tomorrow",
            disabled: true
        });
    });

    it("keeps a running sync visible during a budget pause", () => {
        expect(
            esclubRefreshButton(view({ running: sync, budgetPaused: true }), NOW)
        ).toEqual({ label: "Refreshing…", disabled: true });
    });
});

describe("esclub series URL pre-check", () => {
    it("shows the backend's accepted form", () => {
        expect(ACCEPTED_LINK_EXAMPLE).toBe("https://esclub.gg/serie/<series id>");
    });

    it.each([
        LINK,
        LINK.replace("/multimedia", ""),
        `http://www.esclub.gg/serie/${ID}/match/2?x=1#top`,
        `${LINK}/`,
        `${LINK}/draft?match_number=2`,
        `${LINK}?match_number=2#draft`,
        `${LINK}/other/path`,
        LINK.replace("https:", "http:"),
        LINK.replace("esclub.gg", "www.esclub.gg"),
        `  ${LINK.toUpperCase()}  `
    ])("accepts the same series link form: %s", (text) => {
        expect(parseEsclubUrl(text)).toEqual({ kind: "serie", id: ID });
    });

    it.each([
        "",
        "https://esclub.gg/serie/<series id>",
        "https://esclub.gg/multimedia/serie/not-a-uuid",
        LINK.replace("esclub.gg", "esclub.gg.example.com"),
        LINK.replace("esclub.gg", "example.com"),
        LINK.replace("esclub.gg", "user@esclub.gg"),
        LINK.replace("esclub.gg", "esclub.gg:443"),
        LINK.replace("/serie/", "/stage/"),

        LINK.replace("https:", "ftp:"),
        LINK.replace("https://", ""),
        `${LINK}extra`,
        `${LINK}/draft with space`,
        `${LINK}?with space`,
        `${LINK}#with space`
    ])("rejects unsupported links: %s", (text) => {
        expect(parseEsclubUrl(text)).toBeNull();
    });
});

describe("add league outcome messages", () => {
    const cases: { result: EsclubActionResult; message: string }[] = [
        {
            result: { status: 202, body: { sync } },
            message: "League sync started. Teams will appear when it finishes."
        },
        {
            result: { status: 200, body: { sync } },
            message: "Joined the running league sync. Teams will update when it finishes."
        },
        {
            result: {
                status: 200,
                body: { known: { tournamentId: "league-1", stageId: "stage-1" } }
            },
            message: "League added to your Teams page. It was already synced."
        },
        {
            result: { status: 409, body: { retryAfter: 61 }, retryAfter: null },
            message: "Another league is syncing. Try again in 2 min."
        },
        {
            result: { status: 429, body: { retryAfter: 60 }, retryAfter: "120" },
            message: "Sync limit reached. Try again in 2 min."
        },
        {
            result: { status: 429, body: { retryAfter: 60 }, retryAfter: null },
            message: "Sync limit reached. Try again in 1 min."
        },
        {
            result: { status: 429, body: { retryAfter: 60 }, retryAfter: "invalid" },
            message: "Sync limit reached. Try again in 1 min."
        },
        {
            result: {
                status: 429,
                body: { retryAfter: 60 },
                retryAfter: new Date(NOW + 3 * 60_000).toUTCString()
            },
            message: "Sync limit reached. Try again in 3 min."
        },
        {
            result: {
                status: 200,
                body: {
                    cooldown: { availableAt: new Date(NOW + 7 * 60_000).toISOString() }
                }
            },
            message: "League was refreshed recently. Available in 7 min."
        },
        {
            result: { status: 503, body: { reason: "disabled", error: "off" } },
            message: "esclub sync is off. Saved leagues are still available."
        },
        {
            result: { status: 503, body: { reason: "budget", error: "paused" } },
            message:
                "esclub sync is paused until tomorrow: today's request budget is spent."
        },
        {
            result: { status: 400, body: { code: "INVALID_URL", error: "invalid" } },
            message:
                "Paste an esclub series link, like https://esclub.gg/serie/<series id>."
        },
        {
            result: { status: 400, body: { code: "INVALID_REGION", error: "invalid" } },
            message: "Choose a valid region."
        }
    ];

    it.each(cases)("explains $result.status / $message", ({ result, message }) => {
        expect(esclubActionMessage(result, NOW)).toBe(message);
    });

    it("tracks started and joined syncs for polling", () => {
        expect(esclubActionSync({ status: 202, body: { sync } })).toEqual(sync);
        expect(esclubActionSync({ status: 200, body: { sync } })).toEqual(sync);
    });

    it("does not poll refused presses or known leagues", () => {
        for (const { result } of cases.slice(2)) {
            expect(esclubActionSync(result)).toBeNull();
        }
    });
});

describe("sync polling", () => {
    it.each([
        { terminalStatus: "succeeded", errorClass: null },
        { terminalStatus: "failed", errorClass: null },
        { terminalStatus: "failed", errorClass: "EsclubLeagueRejected" }
    ])(
        "does not rediscover a $terminalStatus / $errorClass sync when tournament refetches fail with 503",
        async ({ terminalStatus, errorClass }) => {
            vi.useFakeTimers();
            vi.setSystemTime(NOW);
            const statusReads: number[] = [];
            let tournamentReads = 0;
            let teamsReads = 0;
            vi.stubGlobal(
                "fetch",
                vi.fn((url: string) => {
                    if (url === "/api/teams/manage") {
                        teamsReads += 1;
                        return Promise.resolve(
                            new Response(
                                JSON.stringify({
                                    teams: [],
                                    tournaments: [
                                        {
                                            id: "league-1",
                                            name: "League",
                                            source: "esclub",
                                            region: "na1",
                                            archived_at: null
                                        }
                                    ]
                                })
                            )
                        );
                    }
                    if (url === "/api/esclub/tournaments/league-1") {
                        tournamentReads += 1;
                        return Promise.resolve(
                            tournamentReads === 1
                                ? new Response(JSON.stringify(view({ running: sync })))
                                : new Response("Unavailable", { status: 503 })
                        );
                    }
                    if (url === "/api/esclub/syncs/sync-1") {
                        statusReads.push(Date.now());
                        // Bound the diagnostic if a regression creates a loop.
                        // A pending response holds the runaway watcher in flight.
                        if (statusReads.length > 4)
                            return new Promise<Response>(() => undefined);
                        return Promise.resolve(
                            new Response(
                                JSON.stringify({
                                    sync: {
                                        ...sync,
                                        status:
                                            statusReads.length === 1
                                                ? "running"
                                                : terminalStatus,
                                        errorClass
                                    }
                                })
                            )
                        );
                    }
                    throw new Error(`Unexpected fetch: ${url}`);
                })
            );
            const client = new QueryClient({
                defaultOptions: { queries: { retry: false } }
            });
            const root = document.createElement("div");
            document.body.append(root);
            const dispose = render(
                () =>
                    createComponent(QueryClientProvider, {
                        client,
                        get children() {
                            return createComponent(TeamsPage, {});
                        }
                    }),
                root
            );

            try {
                await vi.advanceTimersByTimeAsync(100);
                expect(statusReads).toEqual([NOW]);
                await vi.advanceTimersByTimeAsync(2899);
                expect(statusReads).toHaveLength(1);
                await vi.advanceTimersByTimeAsync(101);
                // Completion invalidates each read once. Failed tournament reads
                // retain the cached running row, which must never re-arm polling.
                expect(statusReads).toEqual([NOW, NOW + 3000]);
                expect(tournamentReads).toBe(2);
                expect(teamsReads).toBe(2);
                expect(
                    notifications.success.mock.calls.length +
                        notifications.error.mock.calls.length
                ).toBe(1);
                if (errorClass === "EsclubLeagueRejected") {
                    expect(notifications.error).toHaveBeenCalledWith(
                        "This league can't be imported: it is not a League of Legends league with a supported draft (standard or fearless hard-pick; not blind). Retrying won't help."
                    );
                    expect(notifications.error.mock.calls.flat().join(" ")).not.toMatch(
                        /try again/i
                    );
                }
                await vi.advanceTimersByTimeAsync(30_000);
                expect(statusReads).toHaveLength(2);
                expect(tournamentReads).toBe(2);
                expect(teamsReads).toBe(2);
                // A later cache write must also respect the remembered terminal id.
                client.setQueryData(
                    ["esclubTournament", "league-1"],
                    view({ running: sync })
                );
                await vi.advanceTimersByTimeAsync(3100);
                expect(statusReads).toHaveLength(2);
                expect(tournamentReads).toBe(2);
                expect(teamsReads).toBe(2);
            } finally {
                dispose();
                client.clear();
                root.remove();
            }
        }
    );

    it("polls every 3 seconds before the first response and while running", () => {
        expect(esclubSyncPollInterval(undefined, false)).toBe(3000);
        expect(esclubSyncPollInterval("running", false)).toBe(3000);
    });

    it.each(["succeeded", "failed"])("stops on %s", (status) => {
        expect(
            esclubSyncPollInterval(status === "succeeded" ? "succeeded" : "failed", false)
        ).toBe(false);
    });

    it("stops after a polling error until an explicit retry", () => {
        expect(esclubSyncPollInterval("running", true)).toBe(false);
    });
});

describe("esclub actions", () => {
    const actions = [
        { name: "add", run: () => addEsclubLeague({ url: LINK, region: "na1" }) },
        { name: "league refresh", run: () => refreshEsclubLeague("league-1") },
        { name: "series refresh", run: () => refreshEsclubSeries("series-1") }
    ];

    it.each(actions)(
        "refreshes the session once without replaying $name and succeeds on the next press",
        async ({ run }) => {
            let posts = 0;
            let refreshes = 0;
            const fetch = vi.fn((url: string, options?: RequestInit) => {
                if (url === "/api/auth/refresh-token") {
                    refreshes += 1;
                    expect(options).toEqual({ credentials: "include" });
                    return Promise.resolve(new Response("{}", { status: 200 }));
                }
                if (options?.method === "POST") {
                    posts += 1;
                    return Promise.resolve(
                        posts === 1
                            ? new Response("Sign in", { status: 401 })
                            : new Response(JSON.stringify({ sync }), { status: 202 })
                    );
                }
                throw new Error(`Unexpected fetch: ${url}`);
            });
            vi.stubGlobal("fetch", fetch);

            const result = await run();

            expect(posts).toBe(1);
            expect(refreshes).toBe(1);
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(result).toEqual({ status: 401, sessionRefreshed: true });
            expect(esclubActionMessage(result, NOW)).toBe(
                "Your session was refreshed. Press again."
            );
            expect(esclubActionSync(result)).toBeNull();

            expect(await run()).toEqual({ status: 202, body: { sync } });
            expect(posts).toBe(2);
            expect(refreshes).toBe(1);
            expect(fetch).toHaveBeenCalledTimes(3);
        }
    );

    const refreshFailures: (number | "network")[] = [401, 403, 503, "network"];
    describe.each(actions)("$name when session refresh fails", ({ run }) => {
        it.each(refreshFailures)(
            "refreshes only once after a POST 401 and reports sign-in for %s",
            async (failure) => {
                let posts = 0;
                let refreshes = 0;
                const fetch = vi.fn((url: string, options?: RequestInit) => {
                    if (url === "/api/auth/refresh-token") {
                        refreshes += 1;
                        expect(options).toEqual({ credentials: "include" });
                        return failure === "network"
                            ? Promise.reject(new Error("Offline"))
                            : Promise.resolve(new Response(null, { status: failure }));
                    }
                    if (options?.method === "POST") {
                        posts += 1;
                        return Promise.resolve(new Response(null, { status: 401 }));
                    }
                    throw new Error(`Unexpected fetch: ${url}`);
                });
                vi.stubGlobal("fetch", fetch);

                const result = await run();

                expect(posts).toBe(1);
                expect(refreshes).toBe(1);
                expect(fetch).toHaveBeenCalledTimes(2);
                expect(result).toEqual({ status: 401, sessionRefreshed: false });
                expect(esclubActionMessage(result, NOW)).toBe("Sign in again.");
                expect(esclubActionSync(result)).toBeNull();
            }
        );
    });

    it("posts an add once with credentials and preserves 202", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify({ sync }), { status: 202 }));
        vi.stubGlobal("fetch", fetch);
        expect(await addEsclubLeague({ url: LINK, region: "na1" })).toEqual({
            status: 202,
            body: { sync }
        });
        expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/esclub/leagues", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ url: LINK, region: "na1" })
        });
    });

    it("preserves Retry-After and does not retry a limited POST", async () => {
        const fetch = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ retryAfter: 60 }), {
                status: 429,
                headers: { "Retry-After": "120" }
            })
        );
        vi.stubGlobal("fetch", fetch);
        expect(await refreshEsclubLeague("league/id")).toEqual({
            status: 429,
            body: { retryAfter: 60 },
            retryAfter: "120"
        });
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
            "/api/esclub/tournaments/league%2Fid/refresh",
            expect.objectContaining({ method: "POST", credentials: "include" })
        );
    });

    const cases: Exclude<EsclubActionResult, { status: 401 }>[] = [
        { status: 200, body: { sync } },
        {
            status: 200,
            body: { known: { tournamentId: "league-1", stageId: "stage-1" } }
        },
        { status: 200, body: { cooldown: { availableAt: new Date(NOW).toISOString() } } },
        { status: 409, body: { retryAfter: 30 }, retryAfter: null },
        { status: 503, body: { reason: "disabled", error: "esclub sync is off" } },
        { status: 503, body: { reason: "budget", error: "paused" } },
        { status: 400, body: { code: "INVALID_URL", error: "invalid URL" } },
        { status: 400, body: { code: "INVALID_REGION", error: "invalid region" } }
    ];

    it.each(cases)("returns the validated $status outcome", async (result) => {
        vi.stubGlobal(
            "fetch",
            vi
                .fn()
                .mockResolvedValue(
                    new Response(JSON.stringify(result.body), { status: result.status })
                )
        );
        expect(await addEsclubLeague({ url: LINK, region: "na1" })).toEqual(result);
    });

    it("throws unexpected failures without retrying the POST", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response("failure", { status: 500 }));
        vi.stubGlobal("fetch", fetch);
        await expect(refreshEsclubLeague("league-1")).rejects.toThrow("API error: 500");
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects a malformed action response", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ sync: { id: "incomplete" } }), {
                    status: 202
                })
            )
        );
        await expect(addEsclubLeague({ url: LINK, region: "na1" })).rejects.toThrow();
    });

    it("reads sync status through apiClient", async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sync })));
        vi.stubGlobal("fetch", fetch);
        expect(await fetchEsclubSync("sync/id")).toEqual({ sync });
        expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/esclub/syncs/sync%2Fid", {
            credentials: "include"
        });
    });

    it("reads the tournament sync state through apiClient", async () => {
        const data = view();
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
        vi.stubGlobal("fetch", fetch);
        expect(await fetchEsclubTournament("league/id")).toEqual(data);
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
            "/api/esclub/tournaments/league%2Fid",
            { credentials: "include" }
        );
    });
});
