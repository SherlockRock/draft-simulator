import { describe, expect, it } from "vitest";
import { CANVAS_WORLD_SURFACE_SELECTOR, isCanvasWorldElement } from "./canvasWorldTarget";

describe("isCanvasWorldElement", () => {
    it("recognizes connection targets inside the canvas world layer", () => {
        const connectionPath = {
            closest: (selector: string) =>
                selector.split(", ").includes(".canvas-world") ? {} : null
        };

        expect(isCanvasWorldElement(connectionPath)).toBe(true);
        expect(CANVAS_WORLD_SURFACE_SELECTOR).toContain(".canvas-world");
    });

    it("rejects UI chrome outside the canvas world", () => {
        const sidebarButton = { closest: () => null };

        expect(isCanvasWorldElement(sidebarButton)).toBe(false);
    });
});
