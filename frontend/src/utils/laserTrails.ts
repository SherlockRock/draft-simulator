import { createStore, produce } from "solid-js/store";
import {
    LASER_FADE_MS,
    LASER_MAX_POINTS,
    laserEndSchema,
    laserPointSchema
} from "./presence";

export type LaserPoint = {
    // World coordinates; transformed through the viewer's viewport on paint.
    x: number;
    y: number;
    // Receiver-clock timestamp; drives the ~1s evaporation. Remote points are
    // stamped on arrival, so no cross-client clock sync is needed.
    t: number;
};

export type LaserTrail = {
    // Strokes in arrival order; the last one is open (receiving points)
    // unless a laserEnd closed it. Closed strokes only ever evaporate.
    strokes: LaserPoint[][];
    open: boolean;
};

// Laser-trail state machine, extracted from Canvas.tsx so the listener logic
// is unit-testable: per-user keying, stroke open/close, evaporation pruning,
// own-event filtering, per-canvas scoping, and the reset that must run when
// the active canvas changes without a remount. Payloads are validated
// quietly (safeParse) — they arrive at mousemove frequency, where a toast
// per malformed event would be worse than a dropped frame. Removals go
// through produce/delete or functional filters, never keyed reconcile, which
// solid's server build (resolved by vitest's node environment) mis-shrinks.
export function createLaserTrailTracker(
    selfId: () => string | undefined,
    now: () => number = () => performance.now()
) {
    const [trails, setTrails] = createStore<Record<string, LaserTrail>>({});

    const addPoint = (userId: string, x: number, y: number) => {
        const laserPoint = { x, y, t: now() };
        const trail = trails[userId];
        if (!trail) {
            setTrails(userId, { strokes: [[laserPoint]], open: true });
        } else if (!trail.open) {
            setTrails(userId, "strokes", trail.strokes.length, [laserPoint]);
            setTrails(userId, "open", true);
        } else {
            const strokeIndex = trail.strokes.length - 1;
            setTrails(
                userId,
                "strokes",
                strokeIndex,
                trail.strokes[strokeIndex].length,
                laserPoint
            );
        }

        const total = trails[userId].strokes.reduce(
            (sum, stroke) => sum + stroke.length,
            0
        );
        if (total > LASER_MAX_POINTS) {
            setTrails(
                userId,
                "strokes",
                produce((strokes) => {
                    let excess = total - LASER_MAX_POINTS;
                    while (excess > 0 && strokes.length > 0) {
                        const oldest = strokes[0];
                        if (oldest.length <= excess) {
                            excess -= oldest.length;
                            strokes.shift();
                        } else {
                            oldest.splice(0, excess);
                            excess = 0;
                        }
                    }
                })
            );
        }
    };

    const closeStroke = (userId: string) => {
        if (trails[userId]) {
            setTrails(userId, "open", false);
        }
    };

    const removeUser = (userId: string) => {
        setTrails(
            produce((draft) => {
                delete draft[userId];
            })
        );
    };

    return {
        trails,

        handleLaserPoint(rawData: unknown, canvasId: string) {
            const result = laserPointSchema.safeParse(rawData);
            if (!result.success) return;
            const event = result.data;
            if (event.canvasId !== canvasId) return;
            // Own laser from another tab — the local stroke is fed through
            // addLocalPoint, never through the socket echo.
            if (event.userId === selfId()) return;

            addPoint(event.userId, event.x, event.y);
        },

        handleLaserEnd(rawData: unknown, canvasId: string) {
            const result = laserEndSchema.safeParse(rawData);
            if (!result.success || result.data.canvasId !== canvasId) return;
            if (result.data.userId === selfId()) return;

            closeStroke(result.data.userId);
        },

        handlePresenceLeave(rawData: unknown, canvasId: string) {
            const result = laserEndSchema.safeParse(rawData);
            if (!result.success || result.data.canvasId !== canvasId) return;

            removeUser(result.data.userId);
        },

        // Local echo: the drawer sees their own trail immediately and
        // unthrottled; only the network emits are throttled.
        addLocalPoint(x: number, y: number) {
            const userId = selfId();
            if (!userId) return;
            addPoint(userId, x, y);
        },

        endLocalStroke() {
            const userId = selfId();
            if (!userId) return;
            closeStroke(userId);
        },

        // Drops points older than LASER_FADE_MS, strokes that emptied, and
        // users left with no points at all (an open trail whose points all
        // evaporated has nothing left to connect to, so it goes too — the
        // next point simply starts a fresh stroke). Returns whether any
        // points remain, so the paint loop knows when to stop. State is only
        // rewritten when something actually expired.
        prune(nowT: number): boolean {
            const cutoff = nowT - LASER_FADE_MS;
            let anyExpired = false;
            let anyRemaining = false;
            for (const trail of Object.values(trails)) {
                for (const stroke of trail.strokes) {
                    for (const laserPoint of stroke) {
                        if (laserPoint.t <= cutoff) anyExpired = true;
                        else anyRemaining = true;
                    }
                }
            }
            if (!anyExpired) return anyRemaining;

            setTrails(
                produce((draft) => {
                    for (const userId of Object.keys(draft)) {
                        const trail = draft[userId];
                        trail.strokes = trail.strokes
                            .map((stroke) =>
                                stroke.filter((laserPoint) => laserPoint.t > cutoff)
                            )
                            .filter((stroke) => stroke.length > 0);
                        if (trail.strokes.length === 0) {
                            delete draft[userId];
                        }
                    }
                })
            );
            return anyRemaining;
        },

        reset() {
            setTrails(
                produce((draft) => {
                    for (const userId of Object.keys(draft)) {
                        delete draft[userId];
                    }
                })
            );
        }
    };
}
