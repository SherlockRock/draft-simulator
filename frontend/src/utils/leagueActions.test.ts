import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, resetAuthExpired, setAuthExpiredHandler } from "./apiClient";
import {
    applyLeagueRefresh,
    fetchEsclubTournamentSeries,
    sendLeagueSeriesToCanvas
} from "./actions";

// S3 Task 8: the league canvas POSTs are sent once (no replay after a 401,
// unlike apiPost) and parsed with the shared schemas. Fetch is stubbed.

afterEach(() => {
    resetAuthExpired();
    setAuthExpiredHandler(() => {});
    vi.unstubAllGlobals();
});

const SEND_BODY = {
    created: [{ leagueSeriesId: "ls-1", groupId: "g-1" }],
    existing: [],
    skipped: [{ leagueSeriesId: "ls-2", reason: "not-linkable" }]
};

const send = () =>
    sendLeagueSeriesToCanvas({
        canvasId: "canvas-1",
        leagueSeriesIds: ["ls-1", "ls-2"],
        positionX: 100,
        positionY: 200,
        rowStep: 700
    });

describe("league canvas actions", () => {
    it("posts a send once with the body and parses a 201", async () => {
        const fetch = vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify(SEND_BODY), { status: 201 }));
        vi.stubGlobal("fetch", fetch);
        expect(await send()).toEqual(SEND_BODY);
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
            "/api/canvas/canvas-1/import/league-series",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    leagueSeriesIds: ["ls-1", "ls-2"],
                    positionX: 100,
                    positionY: 200,
                    rowStep: 700
                })
            }
        );
    });

    it.each([
        { name: "send", run: send },
        {
            name: "refresh apply",
            run: () => applyLeagueRefresh({ canvasId: "canvas-1", groupId: "g-1" })
        }
    ])(
        "refreshes the session after a 401 without replaying the $name",
        async ({ run }) => {
            let posts = 0;
            let refreshes = 0;
            const fetch = vi.fn((url: string, options?: RequestInit) => {
                if (url === "/api/auth/refresh-token") {
                    refreshes += 1;
                    return Promise.resolve(new Response("{}", { status: 200 }));
                }
                if (options?.method === "POST") {
                    posts += 1;
                    return Promise.resolve(new Response("Sign in", { status: 401 }));
                }
                throw new Error(`Unexpected fetch: ${url}`);
            });
            vi.stubGlobal("fetch", fetch);

            await expect(run()).rejects.toEqual(new ApiError(401));
            expect(posts).toBe(1);
            expect(refreshes).toBe(1);
        }
    );

    it.each([
        { name: "send", run: send },
        {
            name: "refresh apply",
            run: () => applyLeagueRefresh({ canvasId: "canvas-1", groupId: "g-1" })
        }
    ])(
        "marks the session expired when the refresh after a 401 fails ($name)",
        async ({ run }) => {
            const expired = vi.fn();
            setAuthExpiredHandler(expired);
            vi.stubGlobal(
                "fetch",
                vi.fn((url: string) =>
                    Promise.resolve(
                        new Response("Sign in", {
                            status: url === "/api/auth/refresh-token" ? 403 : 401
                        })
                    )
                )
            );
            await expect(run()).rejects.toEqual(new ApiError(401));
            expect(expired).toHaveBeenCalledTimes(1);
        }
    );

    it("doesn't mark the session expired when the refresh after a 401 works", async () => {
        const expired = vi.fn();
        setAuthExpiredHandler(expired);
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) =>
                Promise.resolve(
                    new Response("{}", {
                        status: url === "/api/auth/refresh-token" ? 200 : 401
                    })
                )
            )
        );
        await expect(send()).rejects.toEqual(new ApiError(401));
        expect(expired).not.toHaveBeenCalled();
    });

    it("throws ApiError with the status on a refusal", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response("{}", { status: 403 }))
        );
        const error = await send().catch((e: Error) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect(error instanceof ApiError ? error.status : null).toBe(403);
    });

    it("posts the refresh apply to the group's route and parses it", async () => {
        const body = {
            added: 1,
            updated: 0,
            series: { status: "finished", complete: true }
        };
        const fetch = vi
            .fn()
            .mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
        vi.stubGlobal("fetch", fetch);
        expect(
            await applyLeagueRefresh({ canvasId: "canvas-1", groupId: "g-1" })
        ).toEqual(body);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]?.[0]).toBe(
            "/api/canvas/canvas-1/group/g-1/league-refresh"
        );
    });

    it("reads a league's series, filtered by team when one is given", async () => {
        const fetch = vi
            .fn()
            .mockImplementation(() =>
                Promise.resolve(
                    new Response(JSON.stringify({ series: [] }), { status: 200 })
                )
            );
        vi.stubGlobal("fetch", fetch);
        expect(await fetchEsclubTournamentSeries("tour-1", "team-1")).toEqual({
            series: []
        });
        expect(await fetchEsclubTournamentSeries("tour-1", null)).toEqual({ series: [] });
        expect(fetch.mock.calls[0]?.[0]).toBe(
            "/api/esclub/tournaments/tour-1/series?team=team-1"
        );
        expect(fetch.mock.calls[1]?.[0]).toBe("/api/esclub/tournaments/tour-1/series");
    });
});
