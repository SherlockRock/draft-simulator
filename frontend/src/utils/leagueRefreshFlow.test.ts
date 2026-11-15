import { describe, expect, it, vi } from "vitest";
import type {
    EsclubSyncResponse,
    EsclubSyncView,
    LeagueImport,
    LeagueRefreshResponse
} from "@draft-sim/shared-types";
import type { EsclubActionResult } from "./esclubSync";
import {
    LEAGUE_REFRESH_POLL_CAP_MS,
    LEAGUE_REFRESH_POLL_MS,
    runLeagueRefresh,
    type LeagueRefreshDeps
} from "./leagueRefreshFlow";

const START = Date.parse("2026-11-14T12:00:00Z");

const leagueImport = (overrides: Partial<LeagueImport> = {}): LeagueImport => ({
    leagueSeriesId: "ls-1",
    tournamentId: "tour-1",
    stageName: "Regular Season",
    startsAt: "2026-11-11T18:00:00Z",
    status: "in_progress",
    complete: false,
    esclubUrl: "https://esclub.gg/multimedia/serie/00000000-0000-0000-0000-000000000001",
    ...overrides
});

const group = (overrides: Partial<LeagueImport> = {}) => ({
    id: "group-1",
    LeagueImport: leagueImport(overrides)
});

const syncView = (status: EsclubSyncView["status"]): EsclubSyncView => ({
    id: "sync-1",
    kind: "serie",
    status,
    tournamentId: "tour-1",
    stageId: "stage-1",
    seriesId: "ls-1",
    startedAt: "2026-11-14T11:59:00Z",
    finishedAt: status === "running" ? null : "2026-11-14T12:00:30Z",
    requestCount: 2,
    errorClass: status === "failed" ? "EsclubTransportError" : null,
    summary: null
});

const applied = (added: number, updated = 0): LeagueRefreshResponse => ({
    added,
    updated,
    series: { status: "in_progress", complete: false }
});

/**
 * Fake deps on a fake clock: `sleep` advances `now`. `polls` are the sync
 * statuses the poll answers in turn (the last one repeats).
 */
function fakeDeps(options: {
    esclub?: () => Promise<EsclubActionResult>;
    polls?: EsclubSyncView["status"][];
    pollError?: boolean;
    apply?: () => Promise<LeagueRefreshResponse>;
}) {
    let clock = START;
    let pollIndex = 0;
    const polls = options.polls ?? ["succeeded"];
    const deps: LeagueRefreshDeps = {
        refreshEsclubSeries: vi.fn(
            options.esclub ??
                (async (): Promise<EsclubActionResult> => ({
                    status: 202,
                    body: { sync: syncView("running") }
                }))
        ),
        fetchEsclubSync: vi.fn(async (): Promise<EsclubSyncResponse> => {
            if (options.pollError) throw new Error("network");
            const status = polls[Math.min(pollIndex, polls.length - 1)] ?? "succeeded";
            pollIndex += 1;
            return { sync: syncView(status) };
        }),
        applyLeagueRefresh: vi.fn(options.apply ?? (async () => applied(0))),
        sleep: vi.fn(async (ms: number) => {
            clock += ms;
        }),
        now: () => clock
    };
    return deps;
}

describe("runLeagueRefresh", () => {
    it("doesn't call esclub for a complete series, and still applies the mirror", async () => {
        const deps = fakeDeps({});
        const result = await runLeagueRefresh({
            group: group({ status: "finished", complete: true }),
            deps
        });
        expect(deps.refreshEsclubSeries).not.toHaveBeenCalled();
        expect(deps.fetchEsclubSync).not.toHaveBeenCalled();
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(deps.applyLeagueRefresh).toHaveBeenCalledWith("group-1");
        expect(result).toMatchObject({
            message: "Up to date · series finished",
            ok: true
        });
    });

    it("presses the series refresh once, polls every 3 s while running, stops when the sync ends", async () => {
        const deps = fakeDeps({ polls: ["running", "running", "succeeded"] });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.refreshEsclubSeries).toHaveBeenCalledTimes(1);
        expect(deps.refreshEsclubSeries).toHaveBeenCalledWith("ls-1");
        expect(deps.fetchEsclubSync).toHaveBeenCalledTimes(3);
        expect(deps.fetchEsclubSync).toHaveBeenCalledWith("sync-1");
        expect(deps.sleep).toHaveBeenCalledTimes(3);
        for (const call of vi.mocked(deps.sleep).mock.calls) {
            expect(call[0]).toBe(LEAGUE_REFRESH_POLL_MS);
        }
        expect(LEAGUE_REFRESH_POLL_MS).toBe(3000);
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ message: "Up to date", ok: true });
    });

    it("doesn't poll a sync that already finished (200 joined)", async () => {
        const deps = fakeDeps({
            esclub: async () => ({ status: 200, body: { sync: syncView("succeeded") } }),
            apply: async () => applied(2)
        });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.fetchEsclubSync).not.toHaveBeenCalled();
        expect(deps.sleep).not.toHaveBeenCalled();
        expect(result).toMatchObject({ message: "2 new games", ok: true });
    });

    it("applies the mirror only after the sync ended", async () => {
        const order: string[] = [];
        const deps = fakeDeps({ polls: ["running", "succeeded"] });
        deps.fetchEsclubSync = vi.fn(async (): Promise<EsclubSyncResponse> => {
            order.push("poll");
            return { sync: syncView(order.length === 1 ? "running" : "succeeded") };
        });
        deps.applyLeagueRefresh = vi.fn(async () => {
            order.push("apply");
            return applied(1);
        });
        await runLeagueRefresh({ group: group(), deps });
        expect(order).toEqual(["poll", "poll", "apply"]);
    });

    it("reports a failed sync and still applies", async () => {
        const deps = fakeDeps({ polls: ["failed"], apply: async () => applied(1) });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            message: "1 new game · esclub refresh failed",
            ok: true
        });
    });

    it("stops polling at the cap (about 3 minutes), says the sync is still running, and applies", async () => {
        const deps = fakeDeps({ polls: ["running"] });
        const result = await runLeagueRefresh({ group: group(), deps });
        const polls = vi.mocked(deps.fetchEsclubSync).mock.calls.length;
        expect(polls).toBe(LEAGUE_REFRESH_POLL_CAP_MS / LEAGUE_REFRESH_POLL_MS);
        expect(LEAGUE_REFRESH_POLL_CAP_MS).toBe(180_000);
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            message: "Up to date · esclub refresh still running",
            ok: true
        });
    });

    it("returns the apply's answer, for the caller to update the group", async () => {
        const answer: LeagueRefreshResponse = {
            added: 0,
            updated: 0,
            series: { status: "finished", complete: true }
        };
        const deps = fakeDeps({ apply: async () => answer });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(result?.applied).toEqual(answer);
        const failed = await runLeagueRefresh({
            group: group(),
            deps: fakeDeps({
                apply: async () => {
                    throw new Error("API error: 500");
                }
            })
        });
        expect(failed?.applied).toBeNull();
    });

    it("stops polling and doesn't apply once the run is aborted (canvas left)", async () => {
        const controller = new AbortController();
        const deps = fakeDeps({ polls: ["running"] });
        let polls = 0;
        deps.fetchEsclubSync = vi.fn(async (): Promise<EsclubSyncResponse> => {
            polls += 1;
            if (polls === 2) controller.abort();
            return { sync: syncView("running") };
        });
        const result = await runLeagueRefresh({
            group: group(),
            deps,
            signal: controller.signal
        });
        expect(result).toBeNull();
        expect(deps.fetchEsclubSync).toHaveBeenCalledTimes(2);
        expect(deps.sleep).toHaveBeenCalledTimes(2);
        expect(deps.applyLeagueRefresh).not.toHaveBeenCalled();
    });

    it("doesn't poll again when aborted while waiting between polls", async () => {
        const controller = new AbortController();
        const deps = fakeDeps({ polls: ["running"] });
        let sleeps = 0;
        deps.sleep = vi.fn(async () => {
            sleeps += 1;
            if (sleeps === 2) controller.abort();
        });
        const result = await runLeagueRefresh({
            group: group(),
            deps,
            signal: controller.signal
        });
        expect(result).toBeNull();
        expect(deps.fetchEsclubSync).toHaveBeenCalledTimes(1);
        expect(deps.applyLeagueRefresh).not.toHaveBeenCalled();
    });

    it("doesn't poll or apply when aborted during the esclub call", async () => {
        const controller = new AbortController();
        const deps = fakeDeps({
            esclub: async () => {
                controller.abort();
                return { status: 202, body: { sync: syncView("running") } };
            }
        });
        const result = await runLeagueRefresh({
            group: group(),
            deps,
            signal: controller.signal
        });
        expect(result).toBeNull();
        expect(deps.fetchEsclubSync).not.toHaveBeenCalled();
        expect(deps.applyLeagueRefresh).not.toHaveBeenCalled();
    });

    it("does nothing when already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        const deps = fakeDeps({});
        const result = await runLeagueRefresh({
            group: group({ complete: true, status: "finished" }),
            deps,
            signal: controller.signal
        });
        expect(result).toBeNull();
        expect(deps.refreshEsclubSeries).not.toHaveBeenCalled();
        expect(deps.applyLeagueRefresh).not.toHaveBeenCalled();
    });

    it("treats a poll that throws as an error and stops polling", async () => {
        const deps = fakeDeps({ pollError: true });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.fetchEsclubSync).toHaveBeenCalledTimes(1);
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result?.message).toBe("Couldn't reach esclub refresh · Up to date");
    });

    it("applies the mirror on a cooldown", async () => {
        const deps = fakeDeps({
            esclub: async () => ({
                status: 200,
                body: { cooldown: { availableAt: "2026-11-14T12:01:30Z" } }
            })
        });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.fetchEsclubSync).not.toHaveBeenCalled();
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result?.message).toBe("Up to date · esclub refresh available in 2 min");
    });

    it.each([
        [
            "409",
            {
                status: 409,
                body: { retryAfter: 60 },
                retryAfter: null
            } satisfies EsclubActionResult,
            "Up to date · Another league is syncing · try again in 1 min"
        ],
        [
            "429",
            {
                status: 429,
                body: { retryAfter: 700 },
                retryAfter: "720"
            } satisfies EsclubActionResult,
            "Up to date · Too many refreshes · try in 12 min"
        ],
        [
            "503 disabled",
            {
                status: 503,
                body: { reason: "disabled", error: "off" }
            } satisfies EsclubActionResult,
            "Up to date · Sync is off"
        ],
        [
            "503 budget",
            {
                status: 503,
                body: { reason: "budget", error: "budget" }
            } satisfies EsclubActionResult,
            "Up to date · Paused until tomorrow"
        ],
        [
            "401 refreshed",
            { status: 401, sessionRefreshed: true } satisfies EsclubActionResult,
            "Up to date · Session refreshed · press again"
        ]
    ])("answers %s and still applies", async (_name, answer, message) => {
        const deps = fakeDeps({ esclub: async () => answer });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.fetchEsclubSync).not.toHaveBeenCalled();
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ message, ok: true });
    });

    it("asks to sign in when both steps are signed out", async () => {
        const deps = fakeDeps({
            esclub: async () => ({ status: 401, sessionRefreshed: false }),
            apply: async () => {
                throw new Error("API error: 401");
            }
        });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ message: "Sign in again", ok: false });
    });

    it("treats a thrown esclub call as an error and still applies", async () => {
        const deps = fakeDeps({
            esclub: async () => {
                throw new Error("API error: 404");
            },
            apply: async () => applied(1)
        });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            message: "Couldn't reach esclub refresh · 1 new game",
            ok: true
        });
    });

    it("treats an unusable 2xx body ({known}) as an error", async () => {
        const deps = fakeDeps({
            esclub: async () => ({
                status: 200,
                body: { known: { tournamentId: "tour-1", stageId: "stage-1" } }
            })
        });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.fetchEsclubSync).not.toHaveBeenCalled();
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result?.message).toBe("Couldn't reach esclub refresh · Up to date");
    });

    it("reports an apply that failed, without throwing", async () => {
        const deps = fakeDeps({
            esclub: async () => ({ status: 200, body: { sync: syncView("succeeded") } }),
            apply: async () => {
                throw new Error("API error: 500");
            }
        });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(result).toMatchObject({
            message: "Couldn't update the series",
            ok: false
        });
    });

    it("applies even when the esclub call and the apply both fail", async () => {
        const deps = fakeDeps({
            esclub: async () => {
                throw new Error("network");
            },
            apply: async () => {
                throw new Error("network");
            }
        });
        const result = await runLeagueRefresh({ group: group(), deps });
        expect(deps.applyLeagueRefresh).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            message: "Couldn't reach esclub refresh · Couldn't update the series",
            ok: false
        });
    });
});
