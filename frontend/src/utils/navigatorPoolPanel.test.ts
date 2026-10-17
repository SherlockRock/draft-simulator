import { describe, expect, test, vi } from "vitest";
import type { RolePoolMap } from "@draft-sim/shared-types";
import type { NavigatorTreeNode } from "../contexts/NavigatorContext";

vi.mock("../data/champions.json", async () => ({
    default: (await import("./__fixtures__/champions-2026-10-10-shares.json")).default
}));
import { resolveChampion } from "./constants";
import {
    defaultPoolView,
    highlightedId,
    initialHighlight,
    matchQuery,
    moveHighlight,
    poolColumns,
    poolSideFor,
    singleMatchLabel,
    visibleTiles
} from "./navigatorPoolPanel";

const nameOf = (id: string): string => resolveChampion(id)?.name ?? id;
const scores = (composite: number) => ({
    composite,
    compStrength: 0,
    informationValue: 0,
    flexRetention: 0,
    revealCost: 0
});
const pick = (id: string, composite: number): NavigatorTreeNode => ({
    championIds: [id],
    actionType: "pick",
    phase: "pick1",
    scores: scores(composite),
    assignmentDistribution: [],
    side: "red",
    slots: [11],
    userInjected: false,
    children: []
});
// The lobby mockup's red pool, hand-sized; Brand and Swain sit in two buckets each (allowed, design § 5).
const RED: RolePoolMap = {
    top: ["Pantheon", "Poppy", "Gragas"],
    jungle: ["Sylas", "Poppy"],
    mid: ["Brand", "Swain", "Akali", "Sylas"],
    adc: ["Jinx", "Ashe", "Xayah", "Caitlyn"],
    support: ["Brand", "Swain", "Ashe", "TahmKench"]
};
const FAN = [
    pick("Pantheon", 2.69),
    pick("Sylas", 2.46),
    pick("Brand", 2.42),
    pick("Poppy", 2.28)
];
const USED = new Set(["Jinx", "Ashe", "Gragas", "Hecarim", "Akali", "Caitlyn"]);
const columns = () =>
    poolColumns({
        display: RED,
        picks: ["Jinx", "Ashe"],
        fan: FAN,
        partnerOf: null,
        unavailable: USED,
        nameOf
    });

describe("defaultPoolView / poolSideFor (U11)", () => {
    test("yours on our pick turn; enemy on any ban turn and on the opponent's pick turn; yours when no turn", () => {
        expect(defaultPoolView({ type: "pick", side: "red" }, "red")).toBe("yours");
        expect(defaultPoolView({ type: "pick", side: "blue" }, "red")).toBe("enemy");
        expect(defaultPoolView({ type: "ban", side: "red" }, "red")).toBe("enemy");
        expect(defaultPoolView({ type: "ban", side: "blue" }, "red")).toBe("enemy");
        expect(defaultPoolView(null, "red")).toBe("yours");
        expect(poolSideFor("yours", "red")).toBe("red");
        expect(poolSideFor("enemy", "red")).toBe("blue");
        expect(poolSideFor("all", "red")).toBeNull();
    });
});

describe("poolColumns (design § 5 five role columns)", () => {
    test("ROLES order; lit/dim and status follow topSeating of the pool side's picks", () => {
        const cols = columns();
        expect(cols.map((c) => c.role)).toEqual([
            "top",
            "jungle",
            "mid",
            "adc",
            "support"
        ]);
        expect(cols[0].status).toEqual({ kind: "open" });
        expect(cols[0].lit).toBe(true);
        expect(cols[3].status).toEqual({ kind: "taken", occupant: "Jinx", pct: 95 });
        expect(cols[3].lit).toBe(false);
        expect(cols[4].status).toEqual({ kind: "taken", occupant: "Ashe", pct: 72 });
    });
    test("tiles: engine candidates first in engine order with score and rank, then the rest alphabetically; used tiles disabled; a champion in two buckets appears in both", () => {
        const cols = columns();
        expect(
            cols[0].tiles.map(
                (t) =>
                    `${t.championId}:${t.rank ?? "-"}:${t.score ?? "-"}:${t.disabled ? "x" : ""}`
            )
        ).toEqual(["Pantheon:1:2.69:", "Poppy:4:2.28:", "Gragas:-:-:x"]);
        expect(cols[2].tiles.map((t) => t.championId)).toEqual([
            "Sylas",
            "Brand",
            "Akali",
            "Swain"
        ]);
        expect(cols[4].tiles.map((t) => t.championId)).toEqual([
            "Brand",
            "Ashe",
            "Swain",
            "TahmKench"
        ]);
        expect(cols[4].tiles[0]).toMatchObject({ rank: 3, score: 2.42, disabled: false });
    });
    test("the all view (display null) buckets championsInRole; lit follows the given picks", () => {
        const cols = poolColumns({
            display: null,
            picks: ["Jinx", "Ashe"],
            fan: [],
            partnerOf: null,
            unavailable: new Set(),
            nameOf
        });
        expect(cols[3].tiles.length).toBeGreaterThan(10);
        expect(cols[3].tiles.some((t) => t.championId === "Caitlyn")).toBe(true);
        expect(cols[3].lit).toBe(false);
        expect(cols[0].lit).toBe(true);
    });
    test("pair-pending: ranked tiles are the partners of the confirmed half, which is itself disabled", () => {
        const pair = (a: string, b: string, composite: number): NavigatorTreeNode => ({
            ...pick(a, composite),
            championIds: [a, b],
            side: "blue",
            slots: [9, 10]
        });
        const BLUE: RolePoolMap = {
            top: ["Shen"],
            jungle: [],
            mid: [],
            adc: ["Xayah", "Jinx"],
            support: ["Shen", "Braum"]
        };
        const cols = poolColumns({
            display: BLUE,
            picks: ["Gragas", "Xayah"],
            fan: [
                pair("Xayah", "Shen", 2.9),
                pair("Xayah", "Braum", 2.8),
                pair("Jinx", "Shen", 2.7)
            ],
            partnerOf: "Xayah",
            unavailable: new Set(["Gragas"]),
            nameOf
        });
        expect(cols[4].tiles.map((t) => `${t.championId}:${t.rank ?? "-"}`)).toEqual([
            "Shen:1",
            "Braum:2"
        ]);
        expect(cols[3].tiles.find((t) => t.championId === "Xayah")?.disabled).toBe(true);
        expect(cols[3].tiles.find((t) => t.championId === "Jinx")?.rank).toBeNull();
    });
});

describe("matchQuery / highlight (design § 6 search)", () => {
    const all = () => columns().flatMap((c) => c.tiles);
    test("prefix beats contains; case- and punctuation-insensitive via normalizeName; empty query matches nothing", () => {
        const m = matchQuery("sw", all());
        expect(m.get("Swain")).toBe(0);
        expect(m.has("Pantheon")).toBe(false);
        expect(matchQuery("AI", all()).get("Swain")).toBe(1);
        expect(matchQuery("tahm kench", all()).get("TahmKench")).toBe(0);
        expect(matchQuery("", all()).size).toBe(0);
        expect(matchQuery("zzz", all()).size).toBe(0);
    });
    test("initialHighlight: the first match in the first LIT column (Swain in mid, not support); null without a query", () => {
        const cols = columns();
        expect(initialHighlight(cols, matchQuery("sw", all()))).toEqual({
            col: 2,
            idx: 0
        }); // the index counts VISIBLE (matching) tiles
        expect(highlightedId(cols, matchQuery("sw", all()), { col: 2, idx: 0 })).toBe(
            "Swain"
        );
        expect(initialHighlight(cols, new Map())).toBeNull();
    });
    test("visibleTiles drops disabled tiles and, with a query, the non-matches", () => {
        const cols = columns();
        expect(visibleTiles(cols[0], new Map()).map((t) => t.championId)).toEqual([
            "Pantheon",
            "Poppy"
        ]);
        expect(
            visibleTiles(cols[2], matchQuery("s", all())).map((t) => t.championId)
        ).toEqual(["Sylas", "Swain"]);
    });
    test("moveHighlight: right at a row's end crosses into the next column's same row; down stops at the bottom; from null the first visible tile", () => {
        const cols = columns();
        const none = new Map<string, 0 | 1>();
        expect(moveHighlight(cols, none, null, "down")).toEqual({ col: 0, idx: 0 });
        expect(moveHighlight(cols, none, { col: 0, idx: 1 }, "right")).toEqual({
            col: 1,
            idx: 0
        }); // top has 2 visible tiles → jungle
        expect(moveHighlight(cols, none, { col: 1, idx: 0 }, "left")).toEqual({
            col: 0,
            idx: 1
        });
        expect(moveHighlight(cols, none, { col: 2, idx: 0 }, "down")).toEqual({
            col: 2,
            idx: 0
        }); // mid has 3 visible (Akali used)
        expect(moveHighlight(cols, none, { col: 2, idx: 0 }, "up")).toEqual({
            col: 2,
            idx: 0
        });
        expect(moveHighlight(cols, none, { col: 4, idx: 2 }, "right")).toEqual({
            col: 4,
            idx: 2
        }); // last column, last tile: stays
    });
    test("singleMatchLabel", () => {
        expect(singleMatchLabel(matchQuery("sw", all()), "picks", nameOf)).toBe(
            "Swain · ↵ picks"
        );
        expect(singleMatchLabel(matchQuery("p", all()), "picks", nameOf)).toBeNull();
        expect(singleMatchLabel(new Map(), "bans", nameOf)).toBeNull();
    });
});
