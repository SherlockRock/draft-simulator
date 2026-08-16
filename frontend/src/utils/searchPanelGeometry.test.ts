import { describe, expect, it } from "vitest";
import {
    SEARCH_PANEL_DEFAULT_WIDTH,
    SEARCH_PANEL_MIN_HEIGHT,
    SEARCH_PANEL_MIN_WIDTH,
    clampPanelGeometry,
    defaultPanelGeometry
} from "./searchPanelGeometry";

describe("clampPanelGeometry", () => {
    it("enforces the minimum size (R8: one uncompromised row + header)", () => {
        const clamped = clampPanelGeometry({ x: 10, y: 10, width: 50, height: 50 }, 1200, 800);
        expect(clamped.width).toBe(SEARCH_PANEL_MIN_WIDTH);
        expect(clamped.height).toBe(SEARCH_PANEL_MIN_HEIGHT);
    });

    it("pulls an off-screen panel back inside the container", () => {
        const clamped = clampPanelGeometry(
            { x: 5000, y: -300, width: SEARCH_PANEL_MIN_WIDTH, height: SEARCH_PANEL_MIN_HEIGHT },
            1200,
            800
        );
        expect(clamped.x + clamped.width).toBeLessThanOrEqual(1200);
        expect(clamped.x).toBeGreaterThanOrEqual(0);
        expect(clamped.y).toBeGreaterThanOrEqual(0);
    });

    it("shrinks an oversized panel to fit", () => {
        const clamped = clampPanelGeometry({ x: 0, y: 0, width: 4000, height: 4000 }, 1200, 800);
        expect(clamped.width).toBeLessThanOrEqual(1200);
        expect(clamped.height).toBeLessThanOrEqual(800);
    });

    it("keeps the minimum even when the container is smaller than it", () => {
        const clamped = clampPanelGeometry({ x: 0, y: 0, width: 500, height: 500 }, 300, 200);
        expect(clamped.width).toBe(SEARCH_PANEL_MIN_WIDTH);
        expect(clamped.height).toBe(SEARCH_PANEL_MIN_HEIGHT);
    });
});

describe("defaultPanelGeometry", () => {
    it("lands top-right at the DEFAULT width, inside the container", () => {
        const geometry = defaultPanelGeometry(1600, 900);
        expect(geometry.x + geometry.width).toBeLessThanOrEqual(1600);
        expect(geometry.y).toBeGreaterThanOrEqual(0);
        // Exact, not >= MIN: opening at MIN width is precisely the state that
        // clipped the opponent select out of the header on first-ever open.
        expect(geometry.width).toBe(SEARCH_PANEL_DEFAULT_WIDTH);
    });
});
