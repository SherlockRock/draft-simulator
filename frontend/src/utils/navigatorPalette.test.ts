import { describe, expect, test } from "vitest";
import type { NavigatorTreeNode } from "../contexts/NavigatorContext";
import {
    buildPaletteCommands,
    cycleIndex,
    filterPaletteCommands,
    rankedTiles,
    type PaletteContext
} from "./navigatorPalette";

const ctx: PaletteContext = {
    turn: { slot: 16, type: "pick" },
    slotLabel: "Red Pick 4",
    isOurTurn: true,
    hasFan: true,
    lastEventChampionName: "Lissandra",
    hasSelection: true,
    canEditPools: false,
    stale: false
};
const ids = (cmds: { id: string }[]) => cmds.map((c) => c.id);

describe("buildPaletteCommands (design § 6 table)", () => {
    test("full table mid-game with a selection", () => {
        const cmds = buildPaletteCommands(ctx);
        expect(ids(cmds)).toEqual([
            "pick",
            "explore",
            "top-line",
            "undo",
            "clear",
            "pools",
            "export"
        ]);
        expect(cmds[0]).toMatchObject({
            label: "Pick for Red Pick 4",
            hint: "our turn",
            opensPane: "champions",
            disabledReason: null
        });
        expect(cmds[3]).toMatchObject({ label: "Undo last", hint: "Lissandra" });
        expect(cmds[5]).toMatchObject({
            label: "Edit pools",
            disabledReason: "between games"
        });
        expect(cmds[6]).toMatchObject({
            label: "Export selected line to canvas",
            opensPane: "canvas",
            disabledReason: null
        });
    });
    test("ban turn labels Ban; opponent's turn hint", () => {
        const cmds = buildPaletteCommands({
            ...ctx,
            turn: { slot: 12, type: "ban" },
            slotLabel: "Red Ban 4",
            isOurTurn: false
        });
        expect(cmds[0]).toMatchObject({
            label: "Ban for Red Ban 4",
            hint: "opponent's turn"
        });
    });
    test("rebucket appears only when stale; pools/rebucket enabled between games", () => {
        const cmds = buildPaletteCommands({ ...ctx, stale: true, canEditPools: true });
        expect(ids(cmds)).toContain("rebucket");
        expect(cmds.find((c) => c.id === "pools")?.disabledReason).toBeNull();
        expect(cmds.find((c) => c.id === "rebucket")?.disabledReason).toBeNull();
    });
    test("no selection disables export and clear; empty fan disables explore/top-line; no events disables undo", () => {
        const cmds = buildPaletteCommands({
            ...ctx,
            hasSelection: false,
            hasFan: false,
            lastEventChampionName: null
        });
        expect(cmds.find((c) => c.id === "export")?.disabledReason).toBe(
            "select a line first"
        );
        expect(cmds.find((c) => c.id === "clear")?.disabledReason).toBe(
            "nothing selected"
        );
        expect(cmds.find((c) => c.id === "explore")?.disabledReason).toBe(
            "no candidates"
        );
        expect(cmds.find((c) => c.id === "top-line")?.disabledReason).toBe(
            "no candidates"
        );
        expect(cmds.find((c) => c.id === "undo")).toMatchObject({
            hint: "nothing to undo",
            disabledReason: "nothing to undo"
        });
    });
    test("no turn (draft complete): no pick/explore/top-line", () => {
        expect(ids(buildPaletteCommands({ ...ctx, turn: null }))).toEqual([
            "undo",
            "clear",
            "pools",
            "export"
        ]);
    });
});

describe("filterPaletteCommands / cycleIndex", () => {
    test("case-insensitive label match; empty query keeps all", () => {
        const cmds = buildPaletteCommands(ctx);
        expect(filterPaletteCommands(cmds, "")).toHaveLength(7);
        expect(ids(filterPaletteCommands(cmds, "POOL"))).toEqual(["pools"]);
        expect(ids(filterPaletteCommands(cmds, "line"))).toEqual([
            "explore",
            "top-line",
            "export"
        ]);
    });
    test("cycleIndex wraps both ways and tolerates empty lists", () => {
        expect(cycleIndex(0, 1, 3)).toBe(1);
        expect(cycleIndex(2, 1, 3)).toBe(0);
        expect(cycleIndex(0, -1, 3)).toBe(2);
        expect(cycleIndex(0, 1, 0)).toBe(0);
    });
});

describe("rankedTiles", () => {
    const scores = (composite: number) => ({
        composite,
        compStrength: 0,
        informationValue: 0,
        flexRetention: 0,
        revealCost: 0
    });
    const n = (championIds: string[], composite: number): NavigatorTreeNode => ({
        championIds,
        actionType: "pick",
        phase: "pick1",
        scores: scores(composite),
        assignmentDistribution: [],
        side: "blue",
        slots: [9, 10],
        userInjected: false,
        children: []
    });
    test("single nodes: one tile each, ranked in engine order", () => {
        expect(rankedTiles([n(["Pantheon"], 3), n(["Taric"], 2.8)], null)).toEqual([
            { championId: "Pantheon", score: 3, rank: 1 },
            { championId: "Taric", score: 2.8, rank: 2 }
        ]);
    });
    test("pair nodes: one tile per champion, first occurrence keeps rank and score", () => {
        const fan = [
            n(["Xayah", "Shen"], 2.9),
            n(["Xayah", "Braum"], 2.8),
            n(["Jinx", "Shen"], 2.7)
        ];
        expect(rankedTiles(fan, null).map((t) => `${t.championId}:${t.rank}`)).toEqual([
            "Xayah:1",
            "Shen:1",
            "Braum:2",
            "Jinx:3"
        ]);
    });
    test("partnerOf: only pairs containing it, and it is excluded", () => {
        const fan = [
            n(["Xayah", "Shen"], 2.9),
            n(["Xayah", "Braum"], 2.8),
            n(["Jinx", "Shen"], 2.7)
        ];
        expect(rankedTiles(fan, "Xayah").map((t) => t.championId)).toEqual([
            "Shen",
            "Braum"
        ]);
        expect(rankedTiles(fan, "Nobody")).toEqual([]);
    });
});
