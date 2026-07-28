import { describe, expect, it } from "vitest";
import {
    MAX_ZOOM,
    MIN_ZOOM,
    clampZoom,
    worldAt,
    worldTransform,
    zoomAt
} from "./viewport";

// The exact per-element formula the world layer replaces, copied from
// CanvasCard.tsx:90-95 before the refactor. If these two ever disagree, the
// world layer is no longer geometrically equivalent to what it replaced.
const legacyScreenPos = (
    vp: { x: number; y: number; zoom: number },
    worldX: number,
    worldY: number
) => ({ x: (worldX - vp.x) * vp.zoom, y: (worldY - vp.y) * vp.zoom });

// Apply the CSS string worldTransform() actually produces to a world point.
const applyWorldTransform = (css: string, worldX: number, worldY: number) => {
    const match = /^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) scale\(([\d.]+)\)$/.exec(
        css
    );
    if (!match) throw new Error(`unparseable transform: ${css}`);
    const translateX = Number(match[1]);
    const translateY = Number(match[2]);
    const scale = Number(match[3]);
    return { x: worldX * scale + translateX, y: worldY * scale + translateY };
};

describe("worldTransform", () => {
    const viewports = [
        { x: 0, y: 0, zoom: 1 },
        { x: 250, y: -80, zoom: 1 },
        { x: -1200, y: 640, zoom: 0.5 },
        { x: 37.5, y: 12.25, zoom: 2 }
    ];
    const points: Array<[number, number]> = [
        [0, 0],
        [100, 200],
        [-450, 900],
        [1600, -75]
    ];

    it("reproduces the per-element formula it replaces", () => {
        for (const vp of viewports) {
            const css = worldTransform(vp);
            for (const [worldX, worldY] of points) {
                const expected = legacyScreenPos(vp, worldX, worldY);
                const actual = applyWorldTransform(css, worldX, worldY);
                expect(actual.x).toBeCloseTo(expected.x, 9);
                expect(actual.y).toBeCloseTo(expected.y, 9);
            }
        }
    });
});

describe("worldAt", () => {
    it("returns the world point rendered under a container-relative point", () => {
        expect(worldAt({ x: 100, y: 50, zoom: 2 }, { x: 40, y: 10 })).toEqual({
            x: 120,
            y: 55
        });
    });
});

describe("zoomAt", () => {
    it("keeps the world point under the anchor pinned to the anchor", () => {
        const vp = { x: 300, y: -120, zoom: 1.25 };
        const anchor = { x: 640, y: 360 };
        const before = worldAt(vp, anchor);

        const next = zoomAt(vp, 2.5, anchor);

        const after = worldAt(next, anchor);
        expect(after.x).toBeCloseTo(before.x, 9);
        expect(after.y).toBeCloseTo(before.y, 9);
        expect(next.zoom).toBe(2.5);
    });

    it("pins the anchor when zooming out as well", () => {
        const vp = { x: -40, y: 900, zoom: 3 };
        const anchor = { x: 15, y: 720 };
        const before = worldAt(vp, anchor);

        const after = worldAt(zoomAt(vp, 0.4, anchor), anchor);

        expect(after.x).toBeCloseTo(before.x, 9);
        expect(after.y).toBeCloseTo(before.y, 9);
    });

    it("returns the input unchanged when the zoom does not change", () => {
        const vp = { x: 10, y: 20, zoom: 1.5 };

        expect(zoomAt(vp, 1.5, { x: 100, y: 100 })).toBe(vp);
    });

    it("pins the anchor at the zoom clamps", () => {
        const vp = { x: 55, y: 66, zoom: 1 };
        const anchor = { x: 200, y: 150 };
        const before = worldAt(vp, anchor);

        for (const zoom of [MIN_ZOOM, MAX_ZOOM]) {
            const after = worldAt(zoomAt(vp, zoom, anchor), anchor);
            expect(after.x).toBeCloseTo(before.x, 9);
            expect(after.y).toBeCloseTo(before.y, 9);
        }
    });
});

describe("clampZoom", () => {
    it("bounds zoom to the supported range", () => {
        expect(clampZoom(0.001)).toBe(MIN_ZOOM);
        expect(clampZoom(50)).toBe(MAX_ZOOM);
        expect(clampZoom(1.5)).toBe(1.5);
    });
});
