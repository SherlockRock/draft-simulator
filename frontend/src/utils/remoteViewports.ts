import { createStore, produce } from "solid-js/store";
import { z } from "zod";
import { viewportLeaveSchema, viewportMoveSchema, viewportSchema } from "./presence";

export type RemoteViewport = z.infer<typeof viewportSchema>;

// Last-known remote viewports keyed by userId, extracted from the provider so
// the event handling is unit-testable: own-viewport filtering, per-canvas
// scoping, snapshot seeding for late joiners, and clears on viewportLeave and
// presenceLeave. A user with no entry has no live canvas viewport (never
// broadcast, in a draft view, or cleared) and gets no jump button. Move and
// leave payloads are validated quietly (safeParse) — they arrive at pan/zoom
// frequency, where a toast per malformed event would be worse than a dropped
// frame. Removals go through produce/delete, not keyed reconcile, which
// solid's server build (resolved by vitest's node environment) mis-shrinks.
export function createRemoteViewportTracker(selfId: () => string | undefined) {
    const [viewports, setViewports] = createStore<Record<string, RemoteViewport>>({});

    return {
        viewportOf(userId: string): RemoteViewport | undefined {
            return viewports[userId];
        },

        handleViewportMove(rawData: unknown, canvasId: string) {
            const result = viewportMoveSchema.safeParse(rawData);
            if (!result.success) return;
            const move = result.data;
            if (move.canvasId !== canvasId) return;
            // Own viewport from another tab — jump-to-self is never offered.
            if (move.userId === selfId()) return;

            setViewports(move.userId, { x: move.x, y: move.y, zoom: move.zoom });
        },

        handleViewportLeave(rawData: unknown, canvasId: string) {
            const result = viewportLeaveSchema.safeParse(rawData);
            if (!result.success || result.data.canvasId !== canvasId) return;
            const departedId = result.data.userId;
            setViewports(
                produce((draft) => {
                    delete draft[departedId];
                })
            );
        },

        // Seeds last-known viewports from an already-validated presence
        // snapshot (the provider owns the loud validation), replacing any
        // previous state wholesale.
        handleSnapshot(
            users: { userId: string; viewport: RemoteViewport | null }[]
        ) {
            setViewports(
                produce((draft) => {
                    for (const key of Object.keys(draft)) {
                        delete draft[key];
                    }
                    for (const user of users) {
                        if (user.viewport && user.userId !== selfId()) {
                            draft[user.userId] = user.viewport;
                        }
                    }
                })
            );
        },

        reset() {
            setViewports(
                produce((draft) => {
                    for (const key of Object.keys(draft)) {
                        delete draft[key];
                    }
                })
            );
        }
    };
}
