import { describe, expect, it } from "vitest";
import {
    applyLineupMove,
    dragPayload,
    parseDragPayload,
    positionOf,
    type Lineup
} from "./lineupMove";
import type { PlayerId } from "./playerStats";

const p = (gameName: string): PlayerId => ({ gameName, tagLine: "NA1" });

const slot = (index: number) => ({ kind: "slot", index }) as const;
const bench = (index: number) => ({ kind: "bench", index }) as const;

// top, jungle, mid, adc, support + two subs.
const lineup = (): Lineup => ({
    slots: [p("Top"), p("Jgl"), p("Mid"), p("Adc"), p("Sup")],
    bench: [p("Sub1"), p("Sub2")]
});

describe("applyLineupMove", () => {
    describe("promotion", () => {
        it("moves a sub into an empty slot and compacts the bench", () => {
            const before: Lineup = {
                slots: [p("Top"), null, p("Mid"), p("Adc"), p("Sup")],
                bench: [p("Sub1"), p("Sub2")]
            };
            expect(applyLineupMove(before, bench(0), slot(1))).toEqual({
                slots: [p("Top"), p("Sub1"), p("Mid"), p("Adc"), p("Sup")],
                bench: [p("Sub2")]
            });
        });

        // Bench order is ordinal, so the displaced starter takes the sub's own
        // position rather than being appended: the second sub stays second.
        it("swaps a sub with the starter they displace", () => {
            expect(applyLineupMove(lineup(), bench(1), slot(2))).toEqual({
                slots: [p("Top"), p("Jgl"), p("Sub2"), p("Adc"), p("Sup")],
                bench: [p("Sub1"), p("Mid")]
            });
        });
    });

    describe("demotion", () => {
        it("swaps a starter with the bench chip they are dropped onto", () => {
            expect(applyLineupMove(lineup(), slot(0), bench(1))).toEqual({
                slots: [p("Sub2"), p("Jgl"), p("Mid"), p("Adc"), p("Sup")],
                bench: [p("Sub1"), p("Top")]
            });
        });

        it("appends a starter dropped on the bench's empty area", () => {
            expect(applyLineupMove(lineup(), slot(3), bench(2))).toEqual({
                slots: [p("Top"), p("Jgl"), p("Mid"), null, p("Sup")],
                bench: [p("Sub1"), p("Sub2"), p("Adc")]
            });
        });

        // Without the append target this transition is unrepresentable — and it
        // is the whole reason an empty bench still has to render.
        it("demotes a starter to a completely empty bench", () => {
            const before: Lineup = {
                slots: [p("Top"), p("Jgl"), p("Mid"), p("Adc"), p("Sup")],
                bench: []
            };
            expect(applyLineupMove(before, slot(4), bench(0))).toEqual({
                slots: [p("Top"), p("Jgl"), p("Mid"), p("Adc"), null],
                bench: [p("Sup")]
            });
        });

        it("treats any out-of-range bench index as the append target", () => {
            expect(applyLineupMove(lineup(), slot(0), bench(99))).toEqual({
                slots: [null, p("Jgl"), p("Mid"), p("Adc"), p("Sup")],
                bench: [p("Sub1"), p("Sub2"), p("Top")]
            });
        });
    });

    describe("within a surface", () => {
        it("trades two bench positions", () => {
            expect(applyLineupMove(lineup(), bench(0), bench(1))).toEqual({
                slots: [p("Top"), p("Jgl"), p("Mid"), p("Adc"), p("Sup")],
                bench: [p("Sub2"), p("Sub1")]
            });
        });

        it("moves a bench player to the end when dropped past the last chip", () => {
            const before: Lineup = {
                slots: [null, null, null, null, null],
                bench: [p("A"), p("B"), p("C")]
            };
            expect(applyLineupMove(before, bench(0), bench(3))).toEqual({
                slots: [null, null, null, null, null],
                bench: [p("B"), p("C"), p("A")]
            });
        });

        it("swaps two role slots", () => {
            expect(applyLineupMove(lineup(), slot(0), slot(4))).toEqual({
                slots: [p("Sup"), p("Jgl"), p("Mid"), p("Adc"), p("Top")],
                bench: [p("Sub1"), p("Sub2")]
            });
        });

        // The shipped My Teams editor left the source empty here; both surfaces
        // now swap, which is why the transform is shared.
        it("swaps a starter into an empty slot, emptying the source", () => {
            const before: Lineup = {
                slots: [p("Top"), null, null, null, null],
                bench: []
            };
            expect(applyLineupMove(before, slot(0), slot(2))).toEqual({
                slots: [null, null, p("Top"), null, null],
                bench: []
            });
        });
    });

    describe("no-ops", () => {
        it("ignores a drop on the source itself", () => {
            const before = lineup();
            expect(applyLineupMove(before, slot(2), slot(2))).toBe(before);
            expect(applyLineupMove(before, bench(0), bench(0))).toBe(before);
        });

        it("ignores a drag from an empty slot", () => {
            const before: Lineup = {
                slots: [null, p("Jgl"), null, null, null],
                bench: []
            };
            expect(applyLineupMove(before, slot(0), slot(1))).toBe(before);
        });

        it("ignores a drag from a bench index that holds nobody", () => {
            const before = lineup();
            expect(applyLineupMove(before, bench(7), slot(0))).toBe(before);
        });

        it("ignores a drop on a slot index that does not exist", () => {
            const before = lineup();
            expect(applyLineupMove(before, slot(0), slot(9))).toBe(before);
        });
    });
});

describe("drag payload codec", () => {
    it("round-trips a slot origin", () => {
        const raw = dragPayload("you", { kind: "slot", role: "mid" });
        expect(raw).toBe("you:slot:mid");
        expect(parseDragPayload(raw)).toEqual({
            side: "you",
            origin: { kind: "slot", role: "mid" }
        });
    });

    it("round-trips a bench origin", () => {
        const raw = dragPayload("enemy", { kind: "bench", index: 3 });
        expect(raw).toBe("enemy:bench:3");
        expect(parseDragPayload(raw)).toEqual({
            side: "enemy",
            origin: { kind: "bench", index: 3 }
        });
    });

    it("rejects anything that is not a lineup payload", () => {
        for (const raw of [
            "",
            "you:mid", // the pre-bench two-part form
            "you:slot:goalkeeper",
            "them:slot:mid",
            "you:pocket:2",
            "you:bench:-1",
            "you:bench:1.5",
            "you:bench:x",
            "roster-player",
            "you:slot:mid:extra"
        ]) {
            expect(parseDragPayload(raw)).toBeNull();
        }
    });

    it("maps a role origin to its slot index", () => {
        expect(positionOf({ kind: "slot", role: "support" })).toEqual({
            kind: "slot",
            index: 4
        });
        expect(positionOf({ kind: "bench", index: 2 })).toEqual({
            kind: "bench",
            index: 2
        });
    });
});
