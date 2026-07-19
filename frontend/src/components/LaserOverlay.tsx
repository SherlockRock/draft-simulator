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
                // One stroke = ONE path and ONE stroke() call, with a uniform
                // alpha from the newest point's age. Per-segment stroking
                // double-paints the shared joints (overlapping round caps
                // compound their translucency) into bright dots at every
                // vertex; a single stroke operation paints each pixel at most
                // once. Evaporation still shows: prune shortens the tail
                // point by point, and after laserEnd the whole remaining
                // tail fades out together.
                const newest = stroke[stroke.length - 1];
                const alpha = 1 - (nowT - newest.t) / LASER_FADE_MS;
                if (alpha <= 0) continue;
                ctx.globalAlpha = alpha;
                if (stroke.length === 1) {
                    // A stroke that is only its starting point: draw a dot so
                    // the press registers before the first segment arrives.
                    const screen = worldToScreen(newest.x, newest.y, viewport);
                    ctx.beginPath();
                    ctx.arc(screen.x, screen.y, 2, 0, Math.PI * 2);
                    ctx.fill();
                    continue;
                }
                ctx.lineWidth = 1.5 + 2.5 * alpha;
                ctx.beginPath();
                const start = worldToScreen(stroke[0].x, stroke[0].y, viewport);
                ctx.moveTo(start.x, start.y);
                for (let i = 1; i < stroke.length; i++) {
                    const screen = worldToScreen(stroke[i].x, stroke[i].y, viewport);
                    ctx.lineTo(screen.x, screen.y);
                }
                ctx.stroke();
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
