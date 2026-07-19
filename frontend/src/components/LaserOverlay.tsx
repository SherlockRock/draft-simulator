import { Accessor, Component, createEffect, onCleanup } from "solid-js";
import { Viewport } from "../utils/schemas";
import { LASER_FADE_MS, presenceColor, worldToScreen } from "../utils/presence";
import { createLaserTrailTracker } from "../utils/laserTrails";

type LaserTrailTracker = ReturnType<typeof createLaserTrailTracker>;

// Laser-pointer trails as a canvas-2D rAF layer: per-segment alpha from
// point age is trivial here and would need a DOM node per point in SVG.
// The paint loop only runs while any trail has points — an effect on the
// tracker's key set starts it, and the loop stops itself once prune reports
// everything evaporated (the final paint leaves the canvas blank).
//
// Same placement contract as CursorOverlay: MUST be mounted `absolute
// inset-0` directly inside canvasContainerRef, because worldToScreen omits
// the container's bounding-rect offset that screenToWorld subtracts.
export const LaserOverlay: Component<{
    tracker: LaserTrailTracker;
    viewport: Accessor<Viewport>;
}> = (props) => {
    let canvasRef: HTMLCanvasElement | undefined;
    let frame: number | null = null;
    // True across the WHOLE loop, not just between frames: prune() inside
    // paint writes the store, which re-runs the starter effect synchronously
    // mid-paint — a frame-based "is it running" check would see the gap and
    // spawn a duplicate rAF chain.
    let running = false;

    const paint = () => {
        const canvas = canvasRef;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) {
            // Bail without wedging the loop: leaving `running` true here
            // would block every future start.
            running = false;
            frame = null;
            return;
        }

        const nowT = performance.now();
        const hasContent = props.tracker.prune(nowT);

        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const deviceWidth = Math.round(width * dpr);
        const deviceHeight = Math.round(height * dpr);
        if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
            canvas.width = deviceWidth;
            canvas.height = deviceHeight;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const viewport = props.viewport();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        for (const [userId, trail] of Object.entries(props.tracker.trails)) {
            ctx.strokeStyle = ctx.fillStyle = presenceColor(userId);
            for (const stroke of trail.strokes) {
                if (stroke.length === 1) {
                    // A stroke that is only its starting point: draw a dot so
                    // the press registers before the first segment arrives.
                    const p = stroke[0];
                    const alpha = 1 - (nowT - p.t) / LASER_FADE_MS;
                    if (alpha <= 0) continue;
                    const screen = worldToScreen(p.x, p.y, viewport);
                    ctx.globalAlpha = alpha;
                    ctx.beginPath();
                    ctx.arc(screen.x, screen.y, 2, 0, Math.PI * 2);
                    ctx.fill();
                    continue;
                }
                for (let i = 1; i < stroke.length; i++) {
                    // Segment alpha/width from the newer endpoint's age: the
                    // trail thins and dims towards its evaporating tail.
                    const alpha = 1 - (nowT - stroke[i].t) / LASER_FADE_MS;
                    if (alpha <= 0) continue;
                    const from = worldToScreen(
                        stroke[i - 1].x,
                        stroke[i - 1].y,
                        viewport
                    );
                    const to = worldToScreen(stroke[i].x, stroke[i].y, viewport);
                    ctx.globalAlpha = alpha;
                    ctx.lineWidth = 1.5 + 2.5 * alpha;
                    ctx.beginPath();
                    ctx.moveTo(from.x, from.y);
                    ctx.lineTo(to.x, to.y);
                    ctx.stroke();
                }
            }
        }
        ctx.globalAlpha = 1;

        if (hasContent) {
            frame = requestAnimationFrame(paint);
        } else {
            running = false;
            frame = null;
        }
    };

    createEffect(() => {
        // Tracks trail-key additions/removals; point appends inside an
        // existing trail don't retrigger, but then the loop is already
        // running (it only stops once every trail has evaporated away).
        const hasTrails = Object.keys(props.tracker.trails).length > 0;
        if (hasTrails && !running) {
            running = true;
            frame = requestAnimationFrame(paint);
        }
    });

    onCleanup(() => {
        running = false;
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
    });

    return (
        <canvas
            ref={canvasRef}
            class="pointer-events-none absolute inset-0 z-40 h-full w-full"
        />
    );
};
