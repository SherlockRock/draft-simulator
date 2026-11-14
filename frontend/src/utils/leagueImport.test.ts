import { describe, expect, it } from "vitest";
import type { EsclubSeriesItem, EsclubSyncView } from "@draft-sim/shared-types";
import {
    focusGroupId,
    importedHeaderLabel,
    refreshToast,
    sendResultToast,
    seriesPickerRows,
    shouldCallEsclubRefresh,
    type LeagueImportView,
    type LeagueRefreshEsclubOutcome,
    type LeagueRefreshResult,
    type LeagueSendResult
} from "./leagueImport";

const NOW = Date.parse("2026-11-14T12:00:00Z");

const team = (id: string, name: string) => ({
    id,
    name,
    acronym: null,
    colors: null
});

const DOG = team("t-dog", "DOG");
const CAT = team("t-cat", "CAT");
const EEL = team("t-eel", "EEL");

function series(overrides: Partial<EsclubSeriesItem> & { id: string }): EsclubSeriesItem {
    return {
        externalId: `ext-${overrides.id}`,
        stageId: "stage-1",
        number: 1,
        startsAt: "2026-11-11T18:00:00Z",
        status: "finished",
        complete: true,
        bestOf: 3,
        draftType: "fearless",
        team1: DOG,
        team2: CAT,
        gameCount: 2,
        wins: { team1: 2, team2: 0 },
        ...overrides
    };
}

describe("seriesPickerRows", () => {
    it("labels a played series with the UTC date, team names and wins", () => {
        const [row] = seriesPickerRows([series({ id: "s1" })], new Set());
        expect(row).toEqual({
            id: "s1",
            label: "Nov 11 · DOG 2–0 CAT",
            stageId: "stage-1",
            checked: true,
            disabled: false,
            note: null
        });
    });

    it("reads the date in UTC, not local time", () => {
        const [row] = seriesPickerRows(
            [series({ id: "s1", startsAt: "2026-11-11T23:30:00-05:00" })],
            new Set()
        );
        expect(row?.label).toBe("Nov 12 · DOG 2–0 CAT");
    });

    it("says 'vs' when there are no games and drops a missing date", () => {
        const [row] = seriesPickerRows(
            [
                series({
                    id: "s1",
                    startsAt: null,
                    status: "upcoming",
                    complete: false,
                    team2: EEL,
                    gameCount: 0,
                    wins: { team1: 0, team2: 0 }
                })
            ],
            new Set()
        );
        expect(row?.label).toBe("DOG vs EEL");
    });

    it("pre-checks finished series with games and leaves in-progress ones unchecked", () => {
        const rows = seriesPickerRows(
            [
                series({ id: "done" }),
                series({
                    id: "live",
                    status: "in_progress",
                    complete: false,
                    gameCount: 1,
                    wins: { team1: 1, team2: 0 }
                })
            ],
            new Set()
        );
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get("done")).toMatchObject({
            checked: true,
            disabled: false,
            note: null
        });
        expect(byId.get("live")).toMatchObject({
            checked: false,
            disabled: false,
            note: "in progress"
        });
    });

    it("disables upcoming, team-less, game-less and already-sent series with the reason", () => {
        const rows = seriesPickerRows(
            [
                series({ id: "up", status: "upcoming", complete: false, gameCount: 0 }),
                series({ id: "noteam", team2: null }),
                series({
                    id: "nogames",
                    status: "in_progress",
                    complete: false,
                    gameCount: 0,
                    wins: { team1: 0, team2: 0 }
                }),
                series({ id: "sent" })
            ],
            new Set(["sent"])
        );
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(byId.get("up")).toMatchObject({
            checked: false,
            disabled: true,
            note: "upcoming"
        });
        expect(byId.get("noteam")).toMatchObject({
            checked: false,
            disabled: true,
            note: "teams not known yet"
        });
        expect(byId.get("nogames")).toMatchObject({
            checked: false,
            disabled: true,
            note: "no games yet"
        });
        expect(byId.get("sent")).toMatchObject({
            checked: false,
            disabled: true,
            note: "already on this canvas"
        });
    });

    it("shows a missing team as TBD in the label", () => {
        const [row] = seriesPickerRows(
            [
                series({
                    id: "s1",
                    team1: null,
                    gameCount: 0,
                    wins: { team1: 0, team2: 0 }
                })
            ],
            new Set()
        );
        expect(row?.label).toBe("Nov 11 · TBD vs CAT");
    });

    it("sorts newest first, undated last, then by series number descending", () => {
        const rows = seriesPickerRows(
            [
                series({ id: "old", startsAt: "2026-11-01T18:00:00Z", number: 9 }),
                series({ id: "undated-1", startsAt: null, number: 1 }),
                series({ id: "new-2", startsAt: "2026-11-11T18:00:00Z", number: 2 }),
                series({ id: "undated-5", startsAt: null, number: 5 }),
                series({ id: "new-7", startsAt: "2026-11-11T18:00:00Z", number: 7 }),
                series({ id: "mid", startsAt: "2026-11-05T18:00:00Z", number: 1 })
            ],
            new Set()
        );
        expect(rows.map((r) => r.id)).toEqual([
            "new-7",
            "new-2",
            "mid",
            "old",
            "undated-5",
            "undated-1"
        ]);
    });

    it("does not reorder the caller's array", () => {
        const input = [
            series({ id: "a", startsAt: "2026-11-01T00:00:00Z" }),
            series({ id: "b", startsAt: "2026-11-02T00:00:00Z" })
        ];
        seriesPickerRows(input, new Set());
        expect(input.map((s) => s.id)).toEqual(["a", "b"]);
    });
});

const view = (overrides: Partial<LeagueImportView> = {}): LeagueImportView => ({
    leagueSeriesId: "ls-1",
    tournamentId: "tour-1",
    stageName: "Regular Season",
    startsAt: "2026-11-11T18:00:00Z",
    status: "finished",
    complete: true,
    esclubUrl: "https://esclub.gg/multimedia/serie/00000000-0000-0000-0000-000000000001",
    ...overrides
});

describe("importedHeaderLabel", () => {
    it("names the stage and the UTC date", () => {
        expect(importedHeaderLabel(view())).toBe("esclub · Regular Season · Nov 11");
    });

    it("drops missing parts", () => {
        expect(importedHeaderLabel(view({ stageName: null }))).toBe("esclub · Nov 11");
        expect(importedHeaderLabel(view({ startsAt: null }))).toBe(
            "esclub · Regular Season"
        );
        expect(importedHeaderLabel(view({ stageName: null, startsAt: null }))).toBe(
            "esclub"
        );
    });

    it("says in progress while the mirror does", () => {
        expect(
            importedHeaderLabel(view({ status: "in_progress", complete: false }))
        ).toBe("esclub · Regular Season · Nov 11 · in progress");
    });
});

describe("shouldCallEsclubRefresh", () => {
    it("skips esclub for a complete series", () => {
        expect(shouldCallEsclubRefresh(view({ complete: true }))).toBe(false);
    });

    it("calls esclub while the series is not complete", () => {
        expect(
            shouldCallEsclubRefresh(view({ status: "in_progress", complete: false }))
        ).toBe(true);
        expect(
            shouldCallEsclubRefresh(view({ status: "finished", complete: false }))
        ).toBe(true);
    });
});

const applied = (added: number, updated: number): LeagueRefreshResult => ({
    added,
    updated,
    series: { status: "in_progress", complete: false }
});

const sync = (status: EsclubSyncView["status"]): EsclubSyncView => ({
    id: "sync-1",
    kind: "serie",
    status,
    tournamentId: "tour-1",
    stageId: "stage-1",
    seriesId: "ls-1",
    startedAt: "2026-11-14T11:59:00Z",
    finishedAt: status === "running" ? null : "2026-11-14T11:59:30Z",
    requestCount: 2,
    errorClass: status === "failed" ? "EsclubTransportError" : null,
    summary: null
});

describe("refreshToast", () => {
    const synced: LeagueRefreshEsclubOutcome = {
        kind: "synced",
        sync: sync("succeeded")
    };

    it("counts new and updated games", () => {
        expect(refreshToast(synced, applied(2, 0), NOW)).toBe("2 new games");
        expect(refreshToast(synced, applied(1, 0), NOW)).toBe("1 new game");
        expect(refreshToast(synced, applied(0, 1), NOW)).toBe("1 game updated");
        expect(refreshToast(synced, applied(0, 3), NOW)).toBe("3 games updated");
        expect(refreshToast(synced, applied(1, 2), NOW)).toBe(
            "1 new game · 2 games updated"
        );
    });

    it("says up to date when nothing changed", () => {
        expect(refreshToast(synced, applied(0, 0), NOW)).toBe("Up to date");
    });

    it("notes a finished series that skipped esclub", () => {
        expect(refreshToast({ kind: "skipped-complete" }, applied(0, 0), NOW)).toBe(
            "Up to date · series finished"
        );
    });

    it("notes a failed or still-running sync", () => {
        expect(
            refreshToast({ kind: "synced", sync: sync("failed") }, applied(0, 0), NOW)
        ).toBe("Up to date · esclub refresh failed");
        expect(
            refreshToast({ kind: "synced", sync: sync("running") }, applied(1, 0), NOW)
        ).toBe("1 new game · esclub refresh still running");
    });

    it("gives the cooldown in minutes, at least 1", () => {
        expect(
            refreshToast(
                { kind: "cooldown", availableAt: "2026-11-14T12:00:40Z" },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · esclub refresh available in 1 min");
        expect(
            refreshToast(
                { kind: "cooldown", availableAt: "2026-11-14T12:01:30Z" },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · esclub refresh available in 2 min");
        expect(
            refreshToast(
                { kind: "cooldown", availableAt: "2026-11-14T11:00:00Z" },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · esclub refresh available in 1 min");
    });

    it("says sync is off or paused on 503", () => {
        expect(
            refreshToast(
                {
                    kind: "refused",
                    result: { status: 503, body: { reason: "disabled", error: "off" } }
                },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · Sync is off");
        expect(
            refreshToast(
                {
                    kind: "refused",
                    result: { status: 503, body: { reason: "budget", error: "budget" } }
                },
                applied(1, 0),
                NOW
            )
        ).toBe("1 new game · Paused until tomorrow");
    });

    it("gives 429 and 409 waits in minutes from Retry-After, else the body", () => {
        expect(
            refreshToast(
                {
                    kind: "refused",
                    result: { status: 429, body: { retryAfter: 700 }, retryAfter: "720" }
                },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · Too many refreshes · try in 12 min");
        expect(
            refreshToast(
                {
                    kind: "refused",
                    result: { status: 429, body: { retryAfter: 125 }, retryAfter: null }
                },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · Too many refreshes · try in 3 min");
        expect(
            refreshToast(
                {
                    kind: "refused",
                    result: {
                        status: 409,
                        body: { retryAfter: 5 },
                        retryAfter: new Date(NOW + 90_000).toUTCString()
                    }
                },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · Another league is syncing · try again in 2 min");
        expect(
            refreshToast(
                {
                    kind: "refused",
                    result: { status: 409, body: { retryAfter: 5 }, retryAfter: null }
                },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · Another league is syncing · try again in 1 min");
    });

    it("asks to press again or sign in on 401", () => {
        expect(
            refreshToast(
                { kind: "refused", result: { status: 401, sessionRefreshed: true } },
                applied(0, 0),
                NOW
            )
        ).toBe("Up to date · Session refreshed · press again");
        expect(
            refreshToast(
                { kind: "refused", result: { status: 401, sessionRefreshed: false } },
                null,
                NOW
            )
        ).toBe("Sign in again");
    });

    it("says the series could not be updated when the apply step failed", () => {
        expect(refreshToast(synced, null, NOW)).toBe("Couldn't update the series");
        expect(
            refreshToast(
                { kind: "cooldown", availableAt: "2026-11-14T12:01:00Z" },
                null,
                NOW
            )
        ).toBe("Couldn't update the series · esclub refresh available in 1 min");
    });
});

const sendResult = (
    created: number,
    existing: number,
    skipped: LeagueSendResult["skipped"]
): LeagueSendResult => ({
    created: Array.from({ length: created }, (_, i) => ({
        leagueSeriesId: `c${i}`,
        groupId: `gc${i}`
    })),
    existing: Array.from({ length: existing }, (_, i) => ({
        leagueSeriesId: `e${i}`,
        groupId: `ge${i}`
    })),
    skipped
});

describe("sendResultToast", () => {
    it("counts sent, existing and skipped series", () => {
        expect(
            sendResultToast(
                sendResult(3, 1, [
                    { leagueSeriesId: "x", reason: "upcoming" },
                    { leagueSeriesId: "y", reason: "no-games" }
                ])
            )
        ).toBe("Sent 3 series · 1 already on this canvas · 2 skipped");
    });

    it("names the reason when one series was skipped", () => {
        expect(
            sendResultToast(
                sendResult(1, 0, [{ leagueSeriesId: "x", reason: "no-teams" }])
            )
        ).toBe("Sent 1 series · 1 skipped: teams not known yet");
        expect(
            sendResultToast(
                sendResult(0, 0, [{ leagueSeriesId: "x", reason: "upcoming" }])
            )
        ).toBe("1 skipped: upcoming");
        expect(
            sendResultToast(
                sendResult(0, 0, [{ leagueSeriesId: "x", reason: "no-games" }])
            )
        ).toBe("1 skipped: no games yet");
        expect(
            sendResultToast(
                sendResult(0, 0, [{ leagueSeriesId: "x", reason: "not-found" }])
            )
        ).toBe("1 skipped: not found");
    });

    it("handles existing-only and empty results", () => {
        expect(sendResultToast(sendResult(0, 1, []))).toBe("1 already on this canvas");
        expect(sendResultToast(sendResult(0, 0, []))).toBe("Nothing sent");
    });
});

describe("focusGroupId", () => {
    it("prefers the first created group, then the first existing one", () => {
        expect(focusGroupId(sendResult(2, 1, []))).toBe("gc0");
        expect(focusGroupId(sendResult(0, 2, []))).toBe("ge0");
        expect(
            focusGroupId(sendResult(0, 0, [{ leagueSeriesId: "x", reason: "upcoming" }]))
        ).toBeNull();
    });
});
