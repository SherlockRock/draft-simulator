import { describe, expect, test } from "vitest";
import type { NavigatorEventData } from "../contexts/NavigatorContext";
import { draftEventsToState, isChampionAvailable } from "./draftEventsToState";

function event(overrides: Partial<NavigatorEventData> = {}): NavigatorEventData {
    return {
        id: overrides.id ?? "evt-1",
        navigator_draft_id: "draft-1",
        event_type: overrides.event_type ?? "ban",
        slot: overrides.slot ?? 0,
        side: overrides.side ?? "blue",
        champion_id: overrides.champion_id ?? "Ahri",
        user_injected: overrides.user_injected ?? false,
        createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z"
    };
}

describe("draftEventsToState", () => {
    test("returns empty state for an empty event list", () => {
        const state = draftEventsToState([]);
        expect(state).toEqual({
            blueBans: [],
            redBans: [],
            bluePicks: [],
            redPicks: [],
            turnIndex: 0
        });
    });

    test("partitions bans and picks by side", () => {
        const state = draftEventsToState([
            event({ event_type: "ban", side: "blue", champion_id: "B1", slot: 0 }),
            event({
                id: "evt-2",
                event_type: "ban",
                side: "red",
                champion_id: "R1",
                slot: 1,
                createdAt: "2026-01-01T00:00:01.000Z"
            }),
            event({
                id: "evt-3",
                event_type: "pick",
                side: "blue",
                champion_id: "B2",
                slot: 6,
                createdAt: "2026-01-01T00:00:02.000Z"
            }),
            event({
                id: "evt-4",
                event_type: "pick",
                side: "red",
                champion_id: "R2",
                slot: 7,
                createdAt: "2026-01-01T00:00:03.000Z"
            })
        ]);

        expect(state.blueBans).toEqual(["B1"]);
        expect(state.redBans).toEqual(["R1"]);
        expect(state.bluePicks).toEqual(["B2"]);
        expect(state.redPicks).toEqual(["R2"]);
        expect(state.turnIndex).toBe(4);
    });

    test("sorts by createdAt timestamp, breaking ties on slot", () => {
        const state = draftEventsToState([
            // Same timestamp; lower slot must come first.
            event({
                id: "evt-late",
                event_type: "pick",
                side: "blue",
                champion_id: "Late",
                slot: 9,
                createdAt: "2026-01-01T00:00:00.000Z"
            }),
            event({
                id: "evt-early",
                event_type: "pick",
                side: "blue",
                champion_id: "Early",
                slot: 6,
                createdAt: "2026-01-01T00:00:00.000Z"
            })
        ]);

        expect(state.bluePicks).toEqual(["Early", "Late"]);
    });

    test("does NOT mutate the caller's events array", () => {
        const events: NavigatorEventData[] = [
            event({
                id: "a",
                createdAt: "2026-01-01T00:00:02.000Z",
                champion_id: "A"
            }),
            event({
                id: "b",
                createdAt: "2026-01-01T00:00:01.000Z",
                champion_id: "B"
            })
        ];
        const snapshot = [...events];

        draftEventsToState(events);

        expect(events).toEqual(snapshot);
    });

    test("ignores non-actionable event types and does not advance turnIndex for them", () => {
        const state = draftEventsToState([
            event({
                event_type: "ban",
                side: "blue",
                champion_id: "Real",
                slot: 0
            }),
            event({
                id: "wi-1",
                event_type: "what_if_pick",
                side: "blue",
                champion_id: "WI",
                slot: 6,
                createdAt: "2026-01-01T00:00:01.000Z"
            }),
            event({
                id: "wi-2",
                event_type: "what_if_ban",
                side: "red",
                champion_id: "WIB",
                slot: 1,
                createdAt: "2026-01-01T00:00:02.000Z"
            }),
            event({
                id: "er-1",
                event_type: "engine_result",
                side: "blue",
                champion_id: "ER",
                slot: 0,
                createdAt: "2026-01-01T00:00:03.000Z"
            })
        ]);

        expect(state.blueBans).toEqual(["Real"]);
        expect(state.bluePicks).toEqual([]);
        expect(state.redBans).toEqual([]);
        expect(state.turnIndex).toBe(1);
    });
});

describe("isChampionAvailable", () => {
    const state = draftEventsToState([
        event({ event_type: "ban", side: "blue", champion_id: "BBan", slot: 0 }),
        event({
            id: "2",
            event_type: "ban",
            side: "red",
            champion_id: "RBan",
            slot: 1,
            createdAt: "2026-01-01T00:00:01.000Z"
        }),
        event({
            id: "3",
            event_type: "pick",
            side: "blue",
            champion_id: "BPick",
            slot: 6,
            createdAt: "2026-01-01T00:00:02.000Z"
        }),
        event({
            id: "4",
            event_type: "pick",
            side: "red",
            champion_id: "RPick",
            slot: 7,
            createdAt: "2026-01-01T00:00:03.000Z"
        })
    ]);

    test("returns false for champions present in any pool", () => {
        expect(isChampionAvailable("BBan", state)).toBe(false);
        expect(isChampionAvailable("RBan", state)).toBe(false);
        expect(isChampionAvailable("BPick", state)).toBe(false);
        expect(isChampionAvailable("RPick", state)).toBe(false);
    });

    test("returns true for champions absent from all pools", () => {
        expect(isChampionAvailable("Untouched", state)).toBe(true);
    });
});
