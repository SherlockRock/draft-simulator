import { describe, expect, test } from "vitest";
import {
    TURN_SEQUENCE,
    getPairPartnerSlot,
    isPairEndSlot,
    isPairStartSlot,
    phaseForSlot
} from "./turnSequence";

describe("TURN_SEQUENCE data integrity", () => {
    test("describes exactly 20 turns (6 bans + 6 picks + 4 bans + 4 picks)", () => {
        expect(TURN_SEQUENCE).toHaveLength(20);
    });

    test("first 6 slots are ban1 phase", () => {
        for (let i = 0; i < 6; i++) {
            expect(TURN_SEQUENCE[i].phase).toBe("ban1");
            expect(TURN_SEQUENCE[i].type).toBe("ban");
        }
    });

    test("slots 6-11 are pick1 phase", () => {
        for (let i = 6; i < 12; i++) {
            expect(TURN_SEQUENCE[i].phase).toBe("pick1");
            expect(TURN_SEQUENCE[i].type).toBe("pick");
        }
    });

    test("slots 12-15 are ban2 phase", () => {
        for (let i = 12; i < 16; i++) {
            expect(TURN_SEQUENCE[i].phase).toBe("ban2");
            expect(TURN_SEQUENCE[i].type).toBe("ban");
        }
    });

    test("slots 16-19 are pick2 phase", () => {
        for (let i = 16; i < 20; i++) {
            expect(TURN_SEQUENCE[i].phase).toBe("pick2");
            expect(TURN_SEQUENCE[i].type).toBe("pick");
        }
    });

    test("each pairStart is followed by exactly one pairEnd on the same side", () => {
        for (let i = 0; i < TURN_SEQUENCE.length; i++) {
            const turn = TURN_SEQUENCE[i];
            if (!turn.pairStart) continue;
            const partner = TURN_SEQUENCE[i + 1];
            expect(partner).toBeDefined();
            expect(partner.pairEnd).toBe(true);
            expect(partner.side).toBe(turn.side);
            expect(partner.type).toBe(turn.type);
        }
    });
});

describe("isPairStartSlot", () => {
    test("returns true for documented pair-start slots", () => {
        expect(isPairStartSlot(7)).toBe(true);
        expect(isPairStartSlot(9)).toBe(true);
        expect(isPairStartSlot(17)).toBe(true);
    });

    test("returns false for non-pair slots", () => {
        expect(isPairStartSlot(0)).toBe(false);
        expect(isPairStartSlot(6)).toBe(false);
        expect(isPairStartSlot(8)).toBe(false);
    });

    test("returns false for slot indices outside the sequence", () => {
        expect(isPairStartSlot(-1)).toBe(false);
        expect(isPairStartSlot(20)).toBe(false);
        expect(isPairStartSlot(100)).toBe(false);
    });
});

describe("isPairEndSlot", () => {
    test("returns true for documented pair-end slots", () => {
        expect(isPairEndSlot(8)).toBe(true);
        expect(isPairEndSlot(10)).toBe(true);
        expect(isPairEndSlot(18)).toBe(true);
    });

    test("returns false for non-pair slots", () => {
        expect(isPairEndSlot(7)).toBe(false);
        expect(isPairEndSlot(0)).toBe(false);
    });

    test("returns false for slot indices outside the sequence", () => {
        expect(isPairEndSlot(20)).toBe(false);
    });
});

describe("getPairPartnerSlot", () => {
    test("returns next slot for a pairStart", () => {
        expect(getPairPartnerSlot(7)).toBe(8);
        expect(getPairPartnerSlot(9)).toBe(10);
        expect(getPairPartnerSlot(17)).toBe(18);
    });

    test("returns previous slot for a pairEnd", () => {
        expect(getPairPartnerSlot(8)).toBe(7);
        expect(getPairPartnerSlot(10)).toBe(9);
        expect(getPairPartnerSlot(18)).toBe(17);
    });

    test("returns null for solo (non-pair) slots", () => {
        expect(getPairPartnerSlot(0)).toBeNull();
        expect(getPairPartnerSlot(6)).toBeNull();
        expect(getPairPartnerSlot(11)).toBeNull();
    });

    test("returns null for invalid slot indices", () => {
        expect(getPairPartnerSlot(-1)).toBeNull();
        expect(getPairPartnerSlot(20)).toBeNull();
    });
});

describe("phaseForSlot", () => {
    test("returns the phase for every valid slot", () => {
        expect(phaseForSlot(0)).toBe("ban1");
        expect(phaseForSlot(6)).toBe("pick1");
        expect(phaseForSlot(12)).toBe("ban2");
        expect(phaseForSlot(16)).toBe("pick2");
    });

    test("throws for invalid slot indices", () => {
        expect(() => phaseForSlot(-1)).toThrow(/invalid slot/);
        expect(() => phaseForSlot(20)).toThrow(/invalid slot/);
    });
});
