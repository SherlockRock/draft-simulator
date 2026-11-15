import { describe, expect, it } from "vitest";
import type { CardLayout } from "./canvasCardLayout";
import { getSeriesGroupDimensions } from "./helpers";
import { LEAGUE_SEND_ROW_GAP, rowStepFor } from "./leagueSendLayout";

const LAYOUTS: CardLayout[] = [
    "vertical",
    "horizontal",
    "wide",
    "wide-draft-order",
    "compact",
    "draft-order"
];

describe("rowStepFor", () => {
    it("uses a 48 px gap", () => {
        expect(LEAGUE_SEND_ROW_GAP).toBe(48);
    });

    it.each(LAYOUTS)(
        "is the %s series frame height plus the gap, rounded up",
        (layout) => {
            const frame = getSeriesGroupDimensions(1, layout).height;
            const step = rowStepFor(layout);
            expect(step).toBe(Math.ceil(frame + 48));
            expect(Number.isInteger(step)).toBe(true);
            // A column of groups never overlaps: one step clears one frame.
            expect(step - frame).toBeGreaterThanOrEqual(48);
        }
    );

    it("pins the six values (card height + 194.5 frame chrome + 48, rounded up)", () => {
        expect(Object.fromEntries(LAYOUTS.map((l) => [l, rowStepFor(l)]))).toEqual({
            vertical: 843,
            horizontal: 627,
            wide: 1103,
            "wide-draft-order": 1203,
            compact: 675,
            "draft-order": 971
        });
    });

    it("stays inside the server's 200-2000 clamp for every layout", () => {
        for (const layout of LAYOUTS) {
            expect(rowStepFor(layout)).toBeGreaterThanOrEqual(200);
            expect(rowStepFor(layout)).toBeLessThanOrEqual(2000);
        }
    });
});
