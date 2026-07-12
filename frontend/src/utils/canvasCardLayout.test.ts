import { describe, expect, it } from "vitest";
import { getEnterAdvanceSlotIndex, type CardLayout } from "./canvasCardLayout";

describe("getEnterAdvanceSlotIndex", () => {
    it("walks the vertical column order on wide/vertical layouts", () => {
        // verticalColumnOrder: [0,1,2,3,4,10,11,12,13,14,5,6,7,8,9,15,16,17,18,19]
        expect(getEnterAdvanceSlotIndex("wide", 0, "forward")).toBe(1);
        expect(getEnterAdvanceSlotIndex("wide", 4, "forward")).toBe(10);
        expect(getEnterAdvanceSlotIndex("vertical", 14, "forward")).toBe(5);
    });

    it("returns null past the last slot and before the first (terminal, not circular)", () => {
        expect(getEnterAdvanceSlotIndex("wide", 19, "forward")).toBeNull();
        expect(getEnterAdvanceSlotIndex("wide", 0, "backward")).toBeNull();
        // horizontalColumnOrder ends at 9
        expect(getEnterAdvanceSlotIndex("horizontal", 9, "forward")).toBeNull();
        // draftOrderColumnOrder ends at 19
        expect(getEnterAdvanceSlotIndex("draft-order", 19, "forward")).toBeNull();
        expect(getEnterAdvanceSlotIndex("wide-draft-order", 0, "backward")).toBeNull();
    });

    it("follows draft-order sequencing", () => {
        // draftOrderColumnOrder: [0,1,2,10,11,12,3,4,13,14,5,6,7,15,16,17,8,9,18,19]
        expect(getEnterAdvanceSlotIndex("draft-order", 2, "forward")).toBe(10);
        expect(getEnterAdvanceSlotIndex("draft-order", 12, "forward")).toBe(3);
        expect(getEnterAdvanceSlotIndex("wide-draft-order", 14, "forward")).toBe(5);
    });

    it("uses compact ban lanes for ban indices on compact layout", () => {
        // compactBanTeam1Order: [0,1,2,3,4,10]; compactBanTeam2Order: [5,6,7,8,9,15]
        expect(getEnterAdvanceSlotIndex("compact", 4, "forward")).toBe(10);
        expect(getEnterAdvanceSlotIndex("compact", 9, "forward")).toBe(15);
        expect(getEnterAdvanceSlotIndex("compact", 0, "backward")).toBeNull();
        expect(getEnterAdvanceSlotIndex("compact", 5, "backward")).toBeNull();
    });

    it("visits all 20 slots exactly once walking forward from 0 on non-compact layouts", () => {
        const layouts: CardLayout[] = ["wide", "vertical", "horizontal", "draft-order", "wide-draft-order"];
        for (const layout of layouts) {
            const visited: number[] = [0];
            let current: number | null = 0;
            while (current !== null) {
                current = getEnterAdvanceSlotIndex(layout, current, "forward");
                if (current !== null) visited.push(current);
            }
            expect(new Set(visited).size).toBe(20);
            expect(visited.length).toBe(20);
        }
    });
});
