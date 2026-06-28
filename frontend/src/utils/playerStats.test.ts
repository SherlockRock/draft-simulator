import { describe, it, expect } from "vitest";
import type { ChampionStatEntry } from "@draft-sim/shared-types";
import {
    aggregateChampRows,
    computeTotals,
    computeRoleDistribution,
    serializePlayersParam,
    parsePlayersParam
} from "./playerStats";

const entry = (
    championId: string,
    role: ChampionStatEntry["role"],
    games: number,
    wins: number
): ChampionStatEntry => ({
    championId,
    role,
    games,
    wins,
    lastPlayed: null,
    recentWindowGames: null
});

describe("aggregateChampRows", () => {
    it("merges entries per champion and sorts by games desc", () => {
        const rows = aggregateChampRows([
            entry("Ahri", "mid", 10, 6),
            entry("Sylas", "mid", 20, 9),
            entry("Ahri", "top", 5, 4)
        ]);
        expect(rows).toEqual([
            { championId: "Sylas", games: 20, wins: 9 },
            { championId: "Ahri", games: 15, wins: 10 }
        ]);
    });

    it("returns [] for no entries", () => {
        expect(aggregateChampRows([])).toEqual([]);
    });
});

describe("computeTotals", () => {
    it("sums games/wins and rounds winrate", () => {
        expect(
            computeTotals([
                { championId: "A", games: 20, wins: 9 },
                { championId: "B", games: 10, wins: 6 }
            ])
        ).toEqual({ games: 30, wins: 15, losses: 15, winrate: 50 });
    });

    it("winrate 0 when no games (no divide-by-zero)", () => {
        expect(computeTotals([])).toEqual({ games: 0, wins: 0, losses: 0, winrate: 0 });
    });
});

describe("computeRoleDistribution", () => {
    it("counts games per role with all roles present", () => {
        expect(
            computeRoleDistribution([
                entry("Ahri", "mid", 10, 6),
                entry("Sylas", "mid", 5, 3),
                entry("Jinx", "adc", 4, 2)
            ])
        ).toEqual({ top: 0, jungle: 0, mid: 15, adc: 4, support: 0 });
    });
});

describe("players param round-trip", () => {
    it("serializes and parses back, preserving spaces and special chars", () => {
        const players = [
            { gameName: "Aeon", tagLine: "NA3" },
            { gameName: "Two Words", tagLine: "EUW" },
            { gameName: "weird#name", tagLine: "k,r" }
        ];
        const raw = serializePlayersParam(players);
        expect(parsePlayersParam(raw)).toEqual(players);
    });

    it("parses empty string to []", () => {
        expect(parsePlayersParam("")).toEqual([]);
    });

    it("drops malformed chunks (no tag)", () => {
        expect(parsePlayersParam("NoTagHere")).toEqual([]);
    });

    it("serialize skips incomplete rows", () => {
        expect(
            serializePlayersParam([
                { gameName: "Aeon", tagLine: "NA3" },
                { gameName: "", tagLine: "NA1" },
                { gameName: "Bob", tagLine: "" }
            ])
        ).toBe(`${encodeURIComponent("Aeon")}#${encodeURIComponent("NA3")}`);
    });
});
