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
    serializeSubmitParam,
    canonicalPlayersKey
} from "./playerStats";
import type { AssignedPlayer, PlayerId, TeamParam } from "./playerStats";

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

const okResult = (gameName: string, entries: ChampionStatEntry[]): PlayerScoutResult => ({
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
            okResult("A", [
                entry("Sylas", "mid", 40, 20),
                entry("LeeSin", "jungle", 10, 5)
            ]),
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
            "Top",
            "Jg",
            "Mid",
            "Adc",
            "Sup"
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
            computeSharedChamps(
                [entry("Ahri", "mid", 5, 3)],
                [entry("Gnar", "top", 5, 3)]
            )
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
            player("A#1", "top", [
                entry("Sylas", "top", 20, 10),
                entry("Gnar", "top", 9, 4)
            ]),
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
            player("A#1", "top", [
                entry("Sylas", "top", 5, 2),
                entry("Ahri", "mid", 50, 25)
            ]),
            player("B#2", "mid", [
                entry("Sylas", "mid", 5, 2),
                entry("Ahri", "mid", 1, 1)
            ]),
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
    const p = (gameName: string, tagLine: string): PlayerId => ({ gameName, tagLine });

    it("round-trips 5 slots including empties", () => {
        const slots = [
            { gameName: "city mouse", tagLine: "yum" },
            null,
            { gameName: "White", tagLine: "KWAN" },
            null,
            null
        ];
        const parsed = parseTeamParam(serializeTeamParam(slots));
        expect(parsed).toEqual({ kind: "slots", slots, bench: [] });
    });

    it("treats unprefixed chunks as list-form and prefixed chunks as slot-form", () => {
        expect(parseTeamParam("a#1,b#2,c#3").kind).toBe("list");
        expect(parseTeamParam("a#1,b#2,c#3,d#4,e#5")).toEqual({
            kind: "list",
            players: [
                { gameName: "a", tagLine: "1" },
                { gameName: "b", tagLine: "2" },
                { gameName: "c", tagLine: "3" },
                { gameName: "d", tagLine: "4" },
                { gameName: "e", tagLine: "5" }
            ]
        });
        expect(parseTeamParam("s:a#1,b#2,c#3,d#4,e#5").kind).toBe("slots");
    });

    it("pads short prefixed slot params to five slots", () => {
        expect(parseTeamParam("s:a#1,b#2")).toEqual({
            kind: "slots",
            slots: [
                { gameName: "a", tagLine: "1" },
                { gameName: "b", tagLine: "2" },
                null,
                null,
                null
            ],
            bench: []
        });
    });

    it("reads chunks past the five role slots as the bench, in order", () => {
        expect(parseTeamParam("s:a#1,b#2,c#3,d#4,e#5,f#6,g#7")).toEqual({
            kind: "slots",
            slots: [p("a", "1"), p("b", "2"), p("c", "3"), p("d", "4"), p("e", "5")],
            bench: [p("f", "6"), p("g", "7")]
        });
    });

    it("keeps unfilled roles while still benching later chunks", () => {
        expect(parseTeamParam("s:a#1,,c#3,,e#5,f#6")).toEqual({
            kind: "slots",
            slots: [p("a", "1"), null, p("c", "3"), null, p("e", "5")],
            bench: [p("f", "6")]
        });
    });

    it("drops empty chunks at bench positions", () => {
        expect(parseTeamParam("s:a#1,b#2,c#3,d#4,e#5,,g#7")).toEqual({
            kind: "slots",
            slots: [p("a", "1"), p("b", "2"), p("c", "3"), p("d", "4"), p("e", "5")],
            bench: [p("g", "7")]
        });
    });

    it("round-trips slots plus a bench", () => {
        const slots = [p("a", "1"), null, p("c", "3"), null, null];
        const bench = [p("f", "6"), p("g", "7")];
        expect(parseTeamParam(serializeTeamParam(slots, bench))).toEqual({
            kind: "slots",
            slots,
            bench
        });
    });

    it("is byte-identical to the bench-free form when the bench is empty", () => {
        const slots = [p("a", "1"), p("b", "2"), p("c", "3"), p("d", "4"), p("e", "5")];
        expect(serializeTeamParam(slots, [])).toBe("s:a#1,b#2,c#3,d#4,e#5");
        expect(serializeTeamParam(slots)).toBe("s:a#1,b#2,c#3,d#4,e#5");
    });

    it("re-serializes a legacy five-slot link to the identical string", () => {
        const raw = "s:a#1,b#2,c#3,d#4,e#5";
        const parsed = parseTeamParam(raw);
        expect(parsed).toEqual({
            kind: "slots",
            slots: [p("a", "1"), p("b", "2"), p("c", "3"), p("d", "4"), p("e", "5")],
            bench: []
        });
        if (parsed.kind !== "slots") throw new Error("expected slot form");
        expect(serializeTeamParam(parsed.slots, parsed.bench)).toBe(raw);
    });

    it("pads a short legacy link out to five slot chunks", () => {
        const parsed = parseTeamParam("s:a#1,b#2,c#3");
        if (parsed.kind !== "slots") throw new Error("expected slot form");
        expect(serializeTeamParam(parsed.slots, parsed.bench)).toBe("s:a#1,b#2,c#3,,");
    });

    // The cap is on PLAYERS, not chunks: ten players need 15 - filledSlots
    // chunks when roles are unfilled, so capping chunks at ten loses players.
    it("caps the bench at MAX_ROSTER minus the filled slots", () => {
        const fullSlots = "a#1,b#2,c#3,d#4,e#5";
        const sevenBench = ["f#6", "g#7", "h#8", "i#9", "j#10", "k#11", "l#12"];
        const capped = parseTeamParam(`s:${fullSlots},${sevenBench.join(",")}`);
        if (capped.kind !== "slots") throw new Error("expected slot form");
        expect(capped.slots.filter((s) => s !== null)).toHaveLength(5);
        expect(capped.bench).toHaveLength(5);
        expect(capped.bench).toEqual([
            p("f", "6"),
            p("g", "7"),
            p("h", "8"),
            p("i", "9"),
            p("j", "10")
        ]);

        const twelveBench = Array.from({ length: 12 }, (_, i) => `b${i}#${i}`);
        const oneSlot = parseTeamParam(
            `s:${["a#1", "", "", "", ""].join(",")},${twelveBench.join(",")}`
        );
        if (oneSlot.kind !== "slots") throw new Error("expected slot form");
        expect(oneSlot.slots.filter((s) => s !== null)).toHaveLength(1);
        expect(oneSlot.bench).toHaveLength(9);
    });

    it("parses empty string to an empty list", () => {
        expect(parseTeamParam("")).toEqual({ kind: "list", players: [] });
    });

    it("returns null for a chunk whose decoded fields are blank", () => {
        // encodeChunk trims, so a " " gameName would serialize to a chunk that
        // re-parses to null; decodeChunk must trim too or normalization is lossy.
        const parsed = parseTeamParam("s:%20#1,b#2,c#3,d#4,e#5");
        if (parsed.kind !== "slots") throw new Error("expected slot form");
        expect(parsed.slots[0]).toBeNull();
    });

    it("degrades an invalid percent-escape to an empty slot instead of throwing", () => {
        // parseTeamParam runs inside a render-time memo, so a hand-edited or
        // truncated URL must not blank the page.
        expect(() => parseTeamParam("s:a%ZZ#1,b#2,c#3,d#4,e#5")).not.toThrow();
        const parsed = parseTeamParam("s:a%ZZ#1,b#2,c#3,d#4,e#5");
        if (parsed.kind !== "slots") throw new Error("expected slot form");
        expect(parsed.slots[0]).toBeNull();
        expect(parsed.slots[1]).toEqual(p("b", "2"));
    });

    // parse is lossy for malformed input, so serialize(parse(x)) === x is NOT
    // true in general. What must hold — or the normalization effect's `changed`
    // guard re-fires forever — is that parsing is idempotent through a
    // serialize round-trip.
    it("is idempotent under parse -> serialize -> parse", () => {
        const twelveBench = Array.from({ length: 12 }, (_, i) => `b${i}#${i}`);
        const literals = [
            "s:a#1,b#2,c#3,d#4,e#5",
            "s:a#1,b#2,c#3,d#4,e#5,f#6,g#7",
            "s:a#1,,c#3,,e#5,f#6",
            "s:a#1,b#2,c#3",
            "s:a#1,b#2,c#3,d#4,e#5,,g#7",
            "s:%20#1,b#2,c#3,d#4,e#5",
            "s:a%ZZ#1,b#2,c#3,d#4,e#5",
            `s:${["a#1", "", "", "", ""].join(",")},${twelveBench.join(",")}`
        ];
        for (const raw of literals) {
            const once = parseTeamParam(raw);
            if (once.kind !== "slots") throw new Error(`expected slot form for ${raw}`);
            const twice = parseTeamParam(serializeTeamParam(once.slots, once.bench));
            expect(twice).toEqual(once);
        }
    });

    it("percent-encodes # and , inside names", () => {
        const slots = [{ gameName: "a#b", tagLine: "c,d" }, null, null, null, null];
        const s = serializeTeamParam(slots);
        expect(s.split(",")).toHaveLength(5);
        expect(parseTeamParam(s)).toEqual({ kind: "slots", slots, bench: [] });
    });

    // URLSearchParams.get performs the OUTER decode; decodeChunk performs the
    // inner field decode. A second decodeURIComponent here would turn an
    // encoded comma inside a name into a structural delimiter.
    it("survives the real URLSearchParams pipeline for special characters", () => {
        const slots = [
            p("a,b", "x#y"),
            p("colon:name", "semi;tag"),
            p("city mouse", "yum"),
            null,
            null
        ];
        const bench = [p("bench,name", "t#1")];
        const search = new URLSearchParams();
        search.set("players", serializeTeamParam(slots, bench));
        const readBack = new URLSearchParams(search.toString()).get("players");
        expect(parseTeamParam(readBack ?? "")).toEqual({ kind: "slots", slots, bench });
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

describe("serializeSubmitParam", () => {
    const slots = [
        { gameName: "a", tagLine: "1" },
        { gameName: "b", tagLine: "2" },
        null,
        { gameName: "c", tagLine: "3" },
        null
    ];
    const slotParam: TeamParam = { kind: "slots", slots, bench: [] };

    it("keeps the slot assignment when the roster is unchanged", () => {
        const ids = [
            { gameName: "a", tagLine: "1" },
            { gameName: "b", tagLine: "2" },
            { gameName: "c", tagLine: "3" }
        ];
        expect(serializeSubmitParam(slotParam, ids)).toBe(serializeTeamParam(slots));
    });

    it("keeps the slot assignment regardless of input order and case", () => {
        const ids = [
            { gameName: "C", tagLine: "3" },
            { gameName: "A", tagLine: "1" },
            { gameName: "B", tagLine: "2" }
        ];
        expect(serializeSubmitParam(slotParam, ids)).toBe(serializeTeamParam(slots));
    });

    it("falls back to list form when a player was replaced", () => {
        const ids = [
            { gameName: "a", tagLine: "1" },
            { gameName: "b", tagLine: "2" },
            { gameName: "z", tagLine: "9" }
        ];
        expect(serializeSubmitParam(slotParam, ids)).toBe(serializePlayersParam(ids));
    });

    it("falls back to list form when a player was removed", () => {
        const ids = [
            { gameName: "a", tagLine: "1" },
            { gameName: "b", tagLine: "2" }
        ];
        expect(serializeSubmitParam(slotParam, ids)).toBe(serializePlayersParam(ids));
    });

    it("serializes as list form when the current param is a list", () => {
        const ids = [{ gameName: "a", tagLine: "1" }];
        const listParam: TeamParam = { kind: "list", players: ids };
        expect(serializeSubmitParam(listParam, ids)).toBe(serializePlayersParam(ids));
    });

    // The comparison is against the FULL roster (slots + bench), so re-scouting
    // an unchanged lineup keeps the bench as well as the manual role fixes.
    it("keeps slots AND bench when the full roster is unchanged", () => {
        const bench = [{ gameName: "f", tagLine: "6" }];
        const withBench: TeamParam = { kind: "slots", slots, bench };
        const ids = [
            { gameName: "f", tagLine: "6" },
            { gameName: "a", tagLine: "1" },
            { gameName: "b", tagLine: "2" },
            { gameName: "c", tagLine: "3" }
        ];
        expect(serializeSubmitParam(withBench, ids)).toBe(
            serializeTeamParam(slots, bench)
        );
    });

    it("falls back to list form when only the bench changed", () => {
        const withBench: TeamParam = {
            kind: "slots",
            slots,
            bench: [{ gameName: "f", tagLine: "6" }]
        };
        const ids = [
            { gameName: "a", tagLine: "1" },
            { gameName: "b", tagLine: "2" },
            { gameName: "c", tagLine: "3" }
        ];
        expect(serializeSubmitParam(withBench, ids)).toBe(serializePlayersParam(ids));
    });
});
