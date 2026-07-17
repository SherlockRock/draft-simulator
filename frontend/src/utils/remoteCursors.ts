import { createStore } from "solid-js/store";
import { CURSOR_IDLE_MS, cursorMoveSchema, presenceLeaveSchema } from "./presence";

export type RemoteCursor = {
    userId: string;
    // World coordinates; transformed through the viewer's viewport on render.
    x: number;
    y: number;
    idle: boolean;
};

// Remote-cursor state machine, extracted from Canvas.tsx so the listener
// logic is unit-testable: own-cursor filtering, per-canvas scoping, in-place
// upserts (stable <For> item refs at mousemove frequency), idle timers, and
// the reset that must run when the active canvas changes without a remount.
// Payloads are validated quietly — validateSocketEvent toasts, and a toast
// storm at mousemove frequency would be worse than a dropped frame.
export function createRemoteCursorTracker(selfId: () => string | undefined) {
    const [cursors, setCursors] = createStore<RemoteCursor[]>([]);
    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const clearIdleTimer = (userId: string) => {
        const pending = idleTimers.get(userId);
        if (pending) {
            clearTimeout(pending);
            idleTimers.delete(userId);
        }
    };

    return {
        cursors,

        handleCursorMove(rawData: unknown, canvasId: string) {
            const result = cursorMoveSchema.safeParse(rawData);
            if (!result.success) return;
            const move = result.data;
            if (move.canvasId !== canvasId) return;
            // Own cursor from another tab — never render yourself.
            if (move.userId === selfId()) return;

            const index = cursors.findIndex((c) => c.userId === move.userId);
            if (index === -1) {
                setCursors(cursors.length, {
                    userId: move.userId,
                    x: move.x,
                    y: move.y,
                    idle: false
                });
            } else {
                setCursors(index, { x: move.x, y: move.y, idle: false });
            }

            clearIdleTimer(move.userId);
            idleTimers.set(
                move.userId,
                setTimeout(() => {
                    idleTimers.delete(move.userId);
                    setCursors((c) => c.userId === move.userId, "idle", true);
                }, CURSOR_IDLE_MS)
            );
        },

        handlePresenceLeave(rawData: unknown, canvasId: string) {
            const result = presenceLeaveSchema.safeParse(rawData);
            if (!result.success || result.data.canvasId !== canvasId) return;
            const departedId = result.data.userId;
            clearIdleTimer(departedId);
            // Functional filter, not reconcile: retained items keep their
            // proxy refs (stable <For> DOM), and solid's SERVER build —
            // which vitest's node environment resolves — mis-shrinks keyed
            // reconcile arrays (null tails). The browser build is fine, but
            // the filter is equivalent and build-agnostic.
            setCursors((prev) => prev.filter((c) => c.userId !== departedId));
        },

        reset() {
            for (const timer of idleTimers.values()) clearTimeout(timer);
            idleTimers.clear();
            setCursors([]);
        }
    };
}
