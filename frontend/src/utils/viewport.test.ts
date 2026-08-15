import { describe, expect, it } from "vitest";
import {
    LEGIBILITY_EXIT_RATIO,
    LEGIBILITY_FLOOR_PX,
    LOD_ENTER_ZOOM,
    LOD_EXIT_ZOOM,
    MAX_ZOOM,
    MIN_VISIBLE_STROKE_PX,
    MIN_ZOOM,
    clampZoom,
    nextLegibleState,
    nextLodState,
    scaledStrokePx,
    screenConstantPx,
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

describe("nextLodState", () => {
    it("enters the LOD below the enter threshold", () => {
        expect(nextLodState(false, LOD_ENTER_ZOOM - 0.001)).toBe(true);
        expect(nextLodState(false, MIN_ZOOM)).toBe(true);
    });

    it("does not enter at or above the enter threshold", () => {
        expect(nextLodState(false, LOD_ENTER_ZOOM)).toBe(false);
        expect(nextLodState(false, 1)).toBe(false);
    });

    it("only exits above the higher exit threshold", () => {
        expect(nextLodState(true, LOD_EXIT_ZOOM + 0.001)).toBe(false);
        expect(nextLodState(true, MAX_ZOOM)).toBe(false);
    });

    // The whole point of the band. Without it, sitting between the two thresholds
    // flips every card interior and the grid on alternate frames.
    it("holds state inside the hysteresis band, from either direction", () => {
        const mid = (LOD_ENTER_ZOOM + LOD_EXIT_ZOOM) / 2;
        expect(nextLodState(true, mid)).toBe(true);
        expect(nextLodState(false, mid)).toBe(false);
        // exactly on each boundary, the band still holds whatever it had
        expect(nextLodState(true, LOD_ENTER_ZOOM)).toBe(true);
        expect(nextLodState(true, LOD_EXIT_ZOOM)).toBe(true);
    });

    it("exits only after crossing the full band, never at the enter threshold", () => {
        // walk up out of the LOD one step at a time
        let lod = nextLodState(false, 0.15);
        expect(lod).toBe(true);
        for (const zoom of [0.2, 0.29, LOD_ENTER_ZOOM, 0.32, LOD_EXIT_ZOOM]) {
            lod = nextLodState(lod, zoom);
            expect(lod).toBe(true);
        }
        expect(nextLodState(lod, 0.35)).toBe(false);
    });

    it("holds state for an unusable zoom rather than swapping every card", () => {
        expect(nextLodState(true, Number.NaN)).toBe(true);
        expect(nextLodState(false, Number.NaN)).toBe(false);
        expect(nextLodState(true, 0)).toBe(true);
        expect(nextLodState(true, -1)).toBe(true);
        expect(nextLodState(true, Number.POSITIVE_INFINITY)).toBe(true);
    });

    it("keeps the exit threshold above the enter threshold", () => {
        expect(LOD_EXIT_ZOOM).toBeGreaterThan(LOD_ENTER_ZOOM);
    });
});

describe("screenConstantPx", () => {
    it("is a no-op at zoom 1", () => {
        expect(screenConstantPx(4, 1)).toBe(4);
    });

    it("keeps a stroke at a constant DEVICE size across the zoom range", () => {
        // The whole point: everything inside .canvas-world is multiplied by
        // scale(zoom), so a stroke authored at N css px paints at N * zoom
        // device px. Below ~1 device px it rasterises inconsistently and edges
        // round away entirely — which is why a ring-4 highlight vanishes at low
        // zoom while the card it surrounds stays visible.
        for (const zoom of [MIN_ZOOM, 0.25, 0.3, 0.5, 1, 2, MAX_ZOOM]) {
            expect(screenConstantPx(4, zoom) * zoom).toBeCloseTo(4, 10);
        }
    });

    it("would otherwise go sub-pixel at the low end", () => {
        // Guards the premise rather than the fix: 4 * 0.1 is 0.4 device px.
        expect(4 * MIN_ZOOM).toBeLessThan(1);
        expect(screenConstantPx(4, MIN_ZOOM)).toBe(40);
    });

    it("falls back to the authored width for an unusable zoom", () => {
        // A transient NaN must not blow the ring up to Infinity px.
        expect(screenConstantPx(4, 0)).toBe(4);
        expect(screenConstantPx(4, -1)).toBe(4);
        expect(screenConstantPx(4, Number.NaN)).toBe(4);
        expect(screenConstantPx(4, Number.POSITIVE_INFINITY)).toBe(4);
    });
});

describe("scaledStrokePx", () => {
    const deviceWidth = (base: number, zoom: number) => scaledStrokePx(base, zoom) * zoom;

    it("scales naturally with zoom while the stroke is comfortably visible", () => {
        // Above the floor it must behave EXACTLY like the plain css width would
        // have, so a highlight keeps its familiar weight when zoomed in.
        for (const zoom of [0.5, 1, 2, MAX_ZOOM]) {
            expect(deviceWidth(4, zoom)).toBeCloseTo(4 * zoom, 10);
        }
    });

    it("stops thinning once it would drop below the floor", () => {
        // The band where a ring-4 used to vanish edge-by-edge: 1.2 device px at
        // the LOD threshold, 0.4 at MIN_ZOOM.
        for (const zoom of [MIN_ZOOM, 0.2, LOD_ENTER_ZOOM, 0.4]) {
            expect(deviceWidth(4, zoom)).toBeCloseTo(MIN_VISIBLE_STROKE_PX, 10);
        }
    });

    it("never renders thinner than the floor anywhere in the zoom range", () => {
        for (const base of [1, 2, 4]) {
            for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom += 0.05) {
                expect(deviceWidth(base, zoom)).toBeGreaterThanOrEqual(
                    Math.min(MIN_VISIBLE_STROKE_PX, base * zoom) - 1e-9
                );
                expect(deviceWidth(base, zoom)).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it("is far thinner at low zoom than a constant-screen-size stroke", () => {
        // The complaint about the first fix: screenConstantPx held it at the full
        // 4px on a card only 34px wide at MIN_ZOOM.
        expect(deviceWidth(4, MIN_ZOOM)).toBeLessThan(
            screenConstantPx(4, MIN_ZOOM) * MIN_ZOOM
        );
    });

    it("crosses over exactly where the natural width meets the floor", () => {
        const crossover = MIN_VISIBLE_STROKE_PX / 4;
        expect(deviceWidth(4, crossover)).toBeCloseTo(MIN_VISIBLE_STROKE_PX, 10);
        expect(deviceWidth(4, crossover * 2)).toBeCloseTo(MIN_VISIBLE_STROKE_PX * 2, 10);
    });

    it("falls back to the authored width for an unusable zoom", () => {
        expect(scaledStrokePx(4, 0)).toBe(4);
        expect(scaledStrokePx(4, -1)).toBe(4);
        expect(scaledStrokePx(4, Number.NaN)).toBe(4);
        expect(scaledStrokePx(4, Number.POSITIVE_INFINITY)).toBe(4);
    });
});

describe("nextLegibleState", () => {
    // Zoom at which a 20px font sits exactly on the floor, and the zoom at
    // which it clears the exit band. Derived, never hard-coded: the whole
    // point of this helper is that the thresholds MOVE with the font size.
    const enterZoom = (fontPx: number) => LEGIBILITY_FLOOR_PX / fontPx;
    const exitZoom = (fontPx: number) =>
        (LEGIBILITY_FLOOR_PX * LEGIBILITY_EXIT_RATIO) / fontPx;

    // The whole reason nextLodState cannot be reused: it takes (previous, zoom)
    // against fixed zoom thresholds, so every font preset would share one
    // cutoff — and the large region labels fontSize exists for would collapse
    // at exactly the zoom where they are most useful.
    it("collapses a small font before a large one at the same zoom", () => {
        expect(nextLegibleState(false, 14, 0.3)).toBe(true);
        expect(nextLegibleState(false, 56, 0.3)).toBe(false);
    });

    it("collapses below the floor", () => {
        expect(nextLegibleState(false, 20, enterZoom(20) - 0.01)).toBe(true);
    });

    // Hysteresis, for the same reason nextLodState has it: without a band,
    // hovering on the threshold swaps every note's interior on alternate frames.
    it("does not un-collapse the instant the floor is crossed back", () => {
        expect(nextLegibleState(true, 20, enterZoom(20) + 0.0001)).toBe(true);
    });

    it("un-collapses once clear of the exit band", () => {
        expect(nextLegibleState(true, 20, 1)).toBe(false);
    });

    // A transient NaN must not swap every note's interior.
    it("holds state on an unusable zoom or font size", () => {
        expect(nextLegibleState(true, 20, Number.NaN)).toBe(true);
        expect(nextLegibleState(false, Number.NaN, 1)).toBe(false);
        expect(nextLegibleState(true, 20, 0)).toBe(true);
    });

    // ⚠️ Each of these probes from the state the guard would NOT return anyway.
    // A NaN needs no guard at all — every comparison against it is false, so the
    // band's `return previous` already catches it, and asserting `(true, …, NaN)`
    // is true proves nothing. Zero, negative and Infinity are the inputs that
    // genuinely reach a branch, and only from the opposite inbound state.
    it("holds state on a non-positive zoom, from the state a guard would change", () => {
        // Ungated, `0 * 20 = 0` is below the floor and would COLLAPSE.
        expect(nextLegibleState(false, 20, 0)).toBe(false);
        expect(nextLegibleState(false, 20, -1)).toBe(false);
    });

    it("holds state on a non-positive font size", () => {
        // Ungated, these are below the floor and would COLLAPSE.
        expect(nextLegibleState(false, 0, 1)).toBe(false);
        expect(nextLegibleState(false, -20, 1)).toBe(false);
    });

    it("holds state on an infinite zoom or font size", () => {
        // Ungated, Infinity is above the exit band and would UN-collapse.
        expect(nextLegibleState(true, 20, Number.POSITIVE_INFINITY)).toBe(true);
        expect(nextLegibleState(true, Number.POSITIVE_INFINITY, 1)).toBe(true);
    });

    // The three zones, each pinned from BOTH inbound states. Without these the
    // two outer zones look state-dependent, and a reader "restoring" a
    // `!previous` guard to the collapse branch would break nothing visible.
    // Only the BAND is allowed to consult the previous state.
    it("collapses below the floor from either state", () => {
        const below = enterZoom(20) - 0.05;
        expect(nextLegibleState(false, 20, below)).toBe(true);
        expect(nextLegibleState(true, 20, below)).toBe(true);
    });

    it("un-collapses above the exit band from either state", () => {
        const above = exitZoom(20) + 0.05;
        expect(nextLegibleState(false, 20, above)).toBe(false);
        expect(nextLegibleState(true, 20, above)).toBe(false);
    });

    it("holds whatever it was given inside the band", () => {
        // Strictly between the floor and the exit — the only zone where the
        // previous state is allowed to decide the answer.
        const inBand = (enterZoom(20) + exitZoom(20)) / 2;
        expect(nextLegibleState(true, 20, inBand)).toBe(true);
        expect(nextLegibleState(false, 20, inBand)).toBe(false);
    });

    // Every shipped preset must have its band strictly inside the usable zoom
    // range, or the collapse is either unreachable or permanent for that font.
    it("gives all four font presets a band inside the zoom range", () => {
        for (const fontPx of [14, 20, 32, 56]) {
            expect(enterZoom(fontPx)).toBeGreaterThan(MIN_ZOOM);
            expect(exitZoom(fontPx)).toBeLessThan(MAX_ZOOM);
        }
    });
});
