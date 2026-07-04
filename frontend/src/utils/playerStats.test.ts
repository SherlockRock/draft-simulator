import { describe, it, expect } from "vitest";
import type { ChampionStatEntry, PlayerScoutResult } from "@draft-sim/shared-types";
import {
    aggregateChampRows,
    computeSharedChamps,
    computeFlexChamps,
    computeTotals,
    computeRoleDistribution,
    serializePlayersParam,
    parsePlayersParam,
    parsePlayersInput,
    formatPlayersInput,
    computeMainRole,
    autoAssignRoles,
    ROLE_ORDER,
    parseTeamParam,
    serializeTeamParam,
    canonicalPlayersKey
} from "./playerStats";
import type { AssignedPlayer } from "./playerStats";

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

describe("parsePlayersInput", () => {
    it("parses a plain comma-separated list (gameName may contain spaces)", () => {
        expect(
            parsePlayersInput(
                "city mouse#yum,khuromee#emate,White#KWAN,ZeroDomain#Kass,Yeongjae#KOR"
            )
        ).toEqual({
            region: null,
            players: [
                { gameName: "city mouse", tagLine: "yum" },
                { gameName: "khuromee", tagLine: "emate" },
                { gameName: "White", tagLine: "KWAN" },
                { gameName: "ZeroDomain", tagLine: "Kass" },
                { gameName: "Yeongjae", tagLine: "KOR" }
            ]
        });
    });

    it("trims whitespace around chunks and drops malformed ones", () => {
        expect(parsePlayersInput("  Aeon#NA3 , broken , Bob#NA1 ")).toEqual({
            region: null,
            players: [
                { gameName: "Aeon", tagLine: "NA3" },
                { gameName: "Bob", tagLine: "NA1" }
            ]
        });
    });

    it("parses an op.gg multisearch URL (region from path, players from query)", () => {
        expect(
            parsePlayersInput(
                "https://op.gg/lol/multisearch/na?summoners=city+mouse%23yum%2Ckhuromee%23emate%2CWhite%23KWAN%2CZeroDomain%23Kass%2CYeongjae%23KOR"
            )
        ).toEqual({
            region: "na1",
            players: [
                { gameName: "city mouse", tagLine: "yum" },
                { gameName: "khuromee", tagLine: "emate" },
                { gameName: "White", tagLine: "KWAN" },
                { gameName: "ZeroDomain", tagLine: "Kass" },
                { gameName: "Yeongjae", tagLine: "KOR" }
            ]
        });
    });

    it("maps a KR op.gg URL region", () => {
        const r = parsePlayersInput(
            "https://www.op.gg/multisearch/kr?summoners=Hide+on+bush%23KR1"
        );
        expect(r.region).toBe("kr");
        expect(r.players).toEqual([{ gameName: "Hide on bush", tagLine: "KR1" }]);
    });

    it("empty input → no players", () => {
        expect(parsePlayersInput("")).toEqual({ region: null, players: [] });
    });
});

describe("computeMainRole", () => {
    it("returns the role with the most games", () => {
        expect(
            computeMainRole([
                entry("Ahri", "mid", 10, 6),
                entry("Sylas", "mid", 5, 3),
                entry("Jinx", "adc", 4, 2)
            ])
        ).toBe("mid");
    });

    it("returns null for no entries", () => {
        expect(computeMainRole([])).toBeNull();
    });

    it("breaks ties toward the earlier role (top→...→support)", () => {
        expect(
            computeMainRole([entry("Jinx", "adc", 5, 3), entry("Garen", "top", 5, 2)])
        ).toBe("top");
    });
});

describe("formatPlayersInput", () => {
    it("round-trips with parsePlayersInput for a plain list", () => {
        const players = [
            { gameName: "city mouse", tagLine: "yum" },
            { gameName: "Bob", tagLine: "NA1" }
        ];
        expect(parsePlayersInput(formatPlayersInput(players)).players).toEqual(players);
    });
});

const okResult = (
    gameName: string,
    entries: ChampionStatEntry[]
): PlayerScoutResult => ({
    status: "ok",
    input: { region: "na1", gameName, tagLine: "TAG" },
    envelope: {
        provider: "ugg",
        schemaVersion: 1,
        fetchedAt: "2026-07-03T00:00:00Z",
        season: "S2026",
        queue: "ranked_solo",
        entries
    }
});

const errResult = (gameName: string): PlayerScoutResult => ({
    status: "error",
    input: { region: "na1", gameName, tagLine: "TAG" },
    error: "not found"
});

const nameAt = (slots: (PlayerScoutResult | null)[], role: ChampionStatEntry["role"]) =>
    slots[ROLE_ORDER.indexOf(role)]?.input.gameName ?? null;

describe("autoAssignRoles", () => {
    it("resolves a role collision by total games (1:1 assignment, not naive)", () => {
        // A: mid 40 / jungle 10. B: mid 30 / top 20.
        // Optimal is A→mid + B→top (60), not B→mid + A→jungle (40).
        const slots = autoAssignRoles([
            okResult("A", [entry("Sylas", "mid", 40, 20), entry("LeeSin", "jungle", 10, 5)]),
            okResult("B", [entry("Ahri", "mid", 30, 15), entry("Gnar", "top", 20, 10)])
        ]);
        expect(nameAt(slots, "mid")).toBe("A");
        expect(nameAt(slots, "top")).toBe("B");
        expect(nameAt(slots, "jungle")).toBeNull();
    });

    it("assigns five distinct mains to their mains", () => {
        const slots = autoAssignRoles([
            okResult("Sup", [entry("Thresh", "support", 30, 15)]),
            okResult("Top", [entry("Gnar", "top", 30, 15)]),
            okResult("Mid", [entry("Ahri", "mid", 30, 15)]),
            okResult("Adc", [entry("Jinx", "adc", 30, 15)]),
            okResult("Jg", [entry("LeeSin", "jungle", 30, 15)])
        ]);
        expect(ROLE_ORDER.map((r) => nameAt(slots, r))).toEqual([
            "Top", "Jg", "Mid", "Adc", "Sup"
        ]);
    });

    it("gives errored players leftover slots, data-backed players their best roles", () => {
        const slots = autoAssignRoles([
            errResult("Err"),
            okResult("Mid", [entry("Ahri", "mid", 30, 15)]),
            okResult("Top", [entry("Gnar", "top", 30, 15)])
        ]);
        expect(nameAt(slots, "mid")).toBe("Mid");
        expect(nameAt(slots, "top")).toBe("Top");
        // Err lands in the earliest remaining role (jungle) deterministically.
        expect(nameAt(slots, "jungle")).toBe("Err");
        expect(nameAt(slots, "adc")).toBeNull();
        expect(nameAt(slots, "support")).toBeNull();
    });

    it("leaves empty slots for partial teams", () => {
        const slots = autoAssignRoles([okResult("Adc", [entry("Jinx", "adc", 10, 5)])]);
        expect(nameAt(slots, "adc")).toBe("Adc");
        expect(slots.filter((s) => s === null)).toHaveLength(4);
    });

    it("returns all-null for an empty team", () => {
        expect(autoAssignRoles([])).toEqual([null, null, null, null, null]);
    });
});

describe("computeSharedChamps", () => {
    it("intersects champion-level across roles, preserving per-side role detail", () => {
        const shared = computeSharedChamps(
            [entry("Sylas", "mid", 40, 24), entry("Ahri", "mid", 10, 5)],
            [entry("Sylas", "jungle", 12, 6), entry("Gnar", "top", 30, 15)]
        );
        expect(shared).toHaveLength(1);
        expect(shared[0].championId).toBe("Sylas");
        expect(shared[0].you).toEqual({
            games: 40,
            wins: 24,
            roles: [{ role: "mid", games: 40, wins: 24 }]
        });
        expect(shared[0].enemy.roles).toEqual([{ role: "jungle", games: 12, wins: 6 }]);
    });

    it("returns [] when pools are disjoint or a side is empty", () => {
        expect(computeSharedChamps([entry("Ahri", "mid", 5, 3)], [])).toEqual([]);
        expect(
            computeSharedChamps([entry("Ahri", "mid", 5, 3)], [entry("Gnar", "top", 5, 3)])
        ).toEqual([]);
    });

    it("sorts by combined games descending", () => {
        const shared = computeSharedChamps(
            [entry("Ahri", "mid", 5, 3), entry("Sylas", "mid", 30, 15)],
            [entry("Ahri", "mid", 6, 3), entry("Sylas", "jungle", 10, 5)]
        );
        expect(shared.map((s) => s.championId)).toEqual(["Sylas", "Ahri"]);
    });
});

describe("computeFlexChamps", () => {
    const player = (
        riotId: string,
        assignedRole: ChampionStatEntry["role"],
        entries: ChampionStatEntry[]
    ): AssignedPlayer => ({ riotId, assignedRole, entries });

    it("includes only champs in 2+ teammates' pools, skipping null slots", () => {
        const flex = computeFlexChamps([
            player("A#1", "top", [entry("Sylas", "top", 20, 10), entry("Gnar", "top", 9, 4)]),
            null,
            player("B#2", "mid", [entry("Sylas", "mid", 15, 9)]),
            null,
            null
        ]);
        expect(flex).toHaveLength(1);
        expect(flex[0].championId).toBe("Sylas");
        expect(flex[0].players.map((p) => p.riotId)).toEqual(["A#1", "B#2"]);
        expect(flex[0].players[0].roles).toEqual([{ role: "top", games: 20, wins: 10 }]);
    });

    it("sorts by teammate count desc, then total games desc", () => {
        const flex = computeFlexChamps([
            player("A#1", "top", [entry("Sylas", "top", 5, 2), entry("Ahri", "mid", 50, 25)]),
            player("B#2", "mid", [entry("Sylas", "mid", 5, 2), entry("Ahri", "mid", 1, 1)]),
            player("C#3", "adc", [entry("Sylas", "adc", 5, 2)]),
            null,
            null
        ]);
        // Sylas: 3 players / 15 games. Ahri: 2 players / 51 games. Count wins.
        expect(flex.map((f) => f.championId)).toEqual(["Sylas", "Ahri"]);
        // Within a champ, players sorted by games desc.
        expect(flex[1].players[0].riotId).toBe("A#1");
    });
});

describe("team param codec", () => {
    it("round-trips 5 slots including empties", () => {
        const slots = [
            { gameName: "city mouse", tagLine: "yum" },
            null,
            { gameName: "White", tagLine: "KWAN" },
            null,
            null
        ];
        const parsed = parseTeamParam(serializeTeamParam(slots));
        expect(parsed).toEqual({ kind: "slots", slots });
    });

    it("treats exactly 5 chunks as slot-form, fewer as list-form", () => {
        expect(parseTeamParam("a%231,b%232,c%233").kind).toBe("list");
        expect(parseTeamParam("a%231,b%232,c%233,d%234,e%235").kind).toBe("slots");
    });

    it("parses empty string to an empty list", () => {
        expect(parseTeamParam("")).toEqual({ kind: "list", players: [] });
    });

    it("percent-encodes # and , inside names", () => {
        const slots = [{ gameName: "a#b", tagLine: "c,d" }, null, null, null, null];
        const s = serializeTeamParam(slots);
        expect(s.split(",")).toHaveLength(5);
        expect(parseTeamParam(s)).toEqual({ kind: "slots", slots });
    });
});

describe("canonicalPlayersKey", () => {
    it("is order- and case-insensitive", () => {
        const a = canonicalPlayersKey([
            { gameName: "Bb", tagLine: "Y" },
            { gameName: "aA", tagLine: "X" }
        ]);
        const b = canonicalPlayersKey([
            { gameName: "aa", tagLine: "x" },
            { gameName: "bb", tagLine: "y" }
        ]);
        expect(a).toBe(b);
    });
});
