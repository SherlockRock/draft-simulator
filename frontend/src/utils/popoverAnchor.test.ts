import { describe, expect, it } from "vitest";
import {
    EDGE_GAP,
    PICKER_WIDTH,
    chooseAnchorScreenPoint,
    clampToPane,
    screenPointToWorld,
    worldPointToScreen
} from "./popoverAnchor";

const pane = { left: 200, top: 60, right: 1800, bottom: 1000 };
const paneOrigin = { x: pane.left, y: pane.top };

describe("screen/world conversion", () => {
    it("round-trips through world coordinates at arbitrary pan and zoom", () => {
        const viewport = { x: -350.5, y: 1200.25, zoom: 0.65 };
        const screen = { x: 777, y: 431 };
        const world = screenPointToWorld(screen, paneOrigin, viewport);
        const back = worldPointToScreen(world, paneOrigin, viewport);
        expect(back.x).toBeCloseTo(screen.x);
        expect(back.y).toBeCloseTo(screen.y);
    });

    it("accounts for the pane origin (window-relative rect vs pane-relative transform)", () => {
        const viewport = { x: 0, y: 0, zoom: 2 };
        // Screen point at the pane origin is world (viewport.x, viewport.y).
        expect(screenPointToWorld({ x: 200, y: 60 }, paneOrigin, viewport)).toEqual({
            x: 0,
            y: 0
        });
        // One world unit is `zoom` screen pixels from the pane origin.
        expect(worldPointToScreen({ x: 10, y: 10 }, paneOrigin, viewport)).toEqual({
            x: 220,
            y: 80
        });
    });
});

describe("clampToPane", () => {
    it("keeps in-bounds positions unchanged", () => {
        expect(clampToPane(600, 200, pane)).toEqual({ x: 600, y: 200 });
    });

    it("clamps to pane edges with the edge gap", () => {
        expect(clampToPane(-50, -50, pane)).toEqual({
            x: pane.left + EDGE_GAP,
            y: pane.top + EDGE_GAP
        });
        const clamped = clampToPane(99999, 99999, pane);
        expect(clamped.x).toBe(pane.right - PICKER_WIDTH - EDGE_GAP);
        expect(clamped.y).toBeLessThan(pane.bottom);
    });
});

describe("chooseAnchorScreenPoint", () => {
    it("places the popover to the right of the card when it fits", () => {
        const card = { left: 400, top: 200, right: 700, bottom: 500 };
        const point = chooseAnchorScreenPoint(card, pane);
        expect(point.x).toBe(card.right + EDGE_GAP);
        expect(point.y).toBe(card.top);
    });

    it("falls back to the left side when the right does not fit", () => {
        const card = { left: 1300, top: 200, right: 1600, bottom: 500 };
        const point = chooseAnchorScreenPoint(card, pane);
        expect(point.x).toBe(card.left - EDGE_GAP - PICKER_WIDTH);
    });

    it("clamps into the pane when neither side has room", () => {
        const card = { left: 210, top: 200, right: 1790, bottom: 500 };
        const point = chooseAnchorScreenPoint(card, pane);
        expect(point.x).toBe(pane.left + EDGE_GAP);
    });
});
