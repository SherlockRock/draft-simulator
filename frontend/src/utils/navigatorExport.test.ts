import { describe, expect, test } from "vitest";
import type { NavigatorEventData, NavigatorTreeNode } from "../contexts/NavigatorContext";
import { getPicksArrayIndex } from "./versusPickOrder";
import {
    exportDraftDescription,
    exportDraftName,
    lineToCanvasPicks
} from "./navigatorExport";

const ev = (
    slot: number,
    side: "blue" | "red",
    event_type: NavigatorEventData["event_type"],
    champion_id: string
): NavigatorEventData => ({
    id: `e${slot}`,
    navigator_draft_id: "d",
    event_type,
    slot,
    side,
    champion_id,
    user_injected: false,
    createdAt: "2026-09-06T00:00:00.000Z"
});
const scores = (composite: number) => ({
    composite,
    compStrength: 0,
    informationValue: 0,
    flexRetention: 0,
    revealCost: 0
});
const node = (
    championIds: string[],
    slots: number[],
    side: "blue" | "red",
    composite: number
): NavigatorTreeNode => ({
    championIds,
    actionType: "pick",
    phase: "pick2",
    scores: scores(composite),
    assignmentDistribution: [],
    side,
    slots,
    userInjected: false,
    children: []
});

describe("canvas picks index (design § 8 table, via getPicksArrayIndex)", () => {
    test("every draft-sequence slot lands on the documented index", () => {
        const expected = [
            0, 5, 1, 6, 2, 7, 10, 15, 16, 11, 12, 17, 8, 3, 9, 4, 18, 13, 14, 19
        ];
        expect(expected.map((_, slot) => getPicksArrayIndex(slot))).toEqual(expected);
        expect(new Set(expected).size).toBe(20);
    });
});

describe("lineToCanvasPicks", () => {
    test("confirmed events fill first, selected nodes fill their slots, the rest stay empty; what-if events are ignored", () => {
        const events = [
            ev(0, "blue", "ban", "Ashe"),
            ev(1, "red", "ban", "Twitch"),
            ev(6, "blue", "pick", "Gragas"),
            ev(7, "red", "pick", "Sejuani"),
            ev(8, "red", "what_if_pick", "Nope")
        ];
        const picks = lineToCanvasPicks(events, [
            node(["Sylas"], [8], "red", 3),
            node(["Hecarim", "Akali"], [9, 10], "blue", 2.9)
        ]);
        expect(picks).toHaveLength(20);
        expect(picks[0]).toBe("Ashe");
        expect(picks[5]).toBe("Twitch");
        expect(picks[10]).toBe("Gragas");
        expect(picks[15]).toBe("Sejuani");
        expect(picks[16]).toBe("Sylas");
        expect(picks[11]).toBe("Hecarim");
        expect(picks[12]).toBe("Akali");
        expect(picks.filter((p) => p === "")).toHaveLength(13);
        expect(picks).not.toContain("Nope");
    });
    test("a pair node whose first half is confirmed agrees with the event", () => {
        const events = [ev(7, "red", "pick", "Sejuani")];
        const picks = lineToCanvasPicks(events, [
            {
                ...node(["Sejuani", "Sylas"], [7, 8], "red", 3),
                confirmedChampionIds: ["Sejuani"]
            }
        ]);
        expect(picks[15]).toBe("Sejuani");
        expect(picks[16]).toBe("Sylas");
    });
});

describe("name and description", () => {
    test("name", () => {
        expect(exportDraftName(2, "red", "Tristana")).toBe(
            "Navigator G2 — red line Tristana"
        );
    });
    test("description names the session, the confirmed frontier and every projected node with its score", () => {
        const text = exportDraftDescription({
            sessionLabel: "Scrim block A",
            gameNumber: 1,
            confirmedCount: 16,
            nodes: [
                node(["Tristana"], [16], "red", 3.08),
                node(["Xayah", "Shen"], [17, 18], "blue", 2.9)
            ],
            nameOf: (id) => id
        });
        expect(text).toBe(
            "Exported from Navigator session Scrim block A, game 1. Confirmed through Blue Ban 5. Projected: Red Pick 4: Tristana (3.08) · Blue Pick 4 + Blue Pick 5: Xayah + Shen (2.90)"
        );
    });
    test("nothing confirmed", () => {
        expect(
            exportDraftDescription({
                sessionLabel: "x",
                gameNumber: 1,
                confirmedCount: 0,
                nodes: [],
                nameOf: (id) => id
            })
        ).toBe(
            "Exported from Navigator session x, game 1. Nothing confirmed. Projected: none"
        );
    });
});
