import { z } from "zod";

export const presenceUserSchema = z.object({
    userId: z.string(),
    displayName: z.string(),
    picture: z.string().nullable()
});

export type PresenceUser = z.infer<typeof presenceUserSchema>;

// World-space canvas viewport as broadcast on the presence channel.
export const viewportSchema = z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive()
});

export const presenceSnapshotSchema = z.object({
    canvasId: z.string(),
    users: z.array(
        presenceUserSchema.extend({
            // Last-known viewport, null until the user's client broadcasts
            // one. A single malformed viewport must not be able to drop
            // presence for everyone, so it degrades to null (no jump offered)
            // instead of failing the snapshot.
            viewport: viewportSchema.nullable().catch(null)
        })
    )
});

export const presenceJoinSchema = z.object({
    canvasId: z.string(),
    user: presenceUserSchema
});

export const presenceLeaveSchema = z.object({
    canvasId: z.string(),
    userId: z.string()
});

// Server-initiated ejection: the user's canvas access was revoked while
// they were connected, and their sockets were forced out of the room.
export const canvasAccessRevokedSchema = z.object({
    canvasId: z.string()
});

// Cursor positions travel in WORLD coordinates; each client transforms them
// through its own pan/zoom. userId is stamped by the server, never trusted
// from the sending client.
export const cursorMoveSchema = z.object({
    canvasId: z.string(),
    userId: z.string(),
    x: z.number().finite(),
    y: z.number().finite()
});

export type CursorMove = z.infer<typeof cursorMoveSchema>;

// Viewport broadcast (slice 4): same trust model and wire shape family as
// cursorMove — world-space values, server-stamped userId.
export const viewportMoveSchema = viewportSchema.extend({
    canvasId: z.string(),
    userId: z.string()
});

export type ViewportMove = z.infer<typeof viewportMoveSchema>;

// Fired when a sender's canvas viewport stops being live (draft drilldown,
// canvas-to-canvas nav); same payload shape as presenceLeave.
export const viewportLeaveSchema = presenceLeaveSchema;

// Laser pointer (slice 5): points travel in WORLD coordinates on the same
// throttled channel shape as cursors — server-stamped userId, quiet
// validation on receive. laserEnd closes the sender's current stroke
// (Tab release, or leaving the canvas view mid-stroke).
export const laserPointSchema = cursorMoveSchema;

export type LaserPointEvent = z.infer<typeof laserPointSchema>;

export const laserEndSchema = presenceLeaveSchema;

export const CURSOR_THROTTLE_MS = 35;
export const CURSOR_IDLE_MS = 5000;
// How long a laser point lives before it has fully evaporated: the trail
// continuously eats itself ~1s behind the cursor, and the same rule makes
// the remaining tail fade out after release.
export const LASER_FADE_MS = 1000;

type ViewportLike = { x: number; y: number; zoom: number };

// Inverse of Canvas.tsx screenToWorld (world = screen / zoom + viewport).
export function worldToScreen(
    worldX: number,
    worldY: number,
    viewport: ViewportLike
): { x: number; y: number } {
    return {
        x: (worldX - viewport.x) * viewport.zoom,
        y: (worldY - viewport.y) * viewport.zoom
    };
}

// Leading + trailing throttle for high-frequency emits: the first value goes
// out immediately, values inside the window coalesce into one trailing send
// with the latest value (so the receiver always lands on the final resting
// state), and cancel() drops any pending trailing send.
export function createTrailingThrottle<T>(
    fn: (value: T) => void,
    intervalMs: number = CURSOR_THROTTLE_MS
): { send: (value: T) => void; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { value: T } | null = null;

    const openWindow = () => {
        timer = setTimeout(() => {
            timer = null;
            if (pending) {
                const { value } = pending;
                pending = null;
                fn(value);
                openWindow();
            }
        }, intervalMs);
    };

    return {
        send(value: T) {
            if (timer) {
                pending = { value };
                return;
            }
            fn(value);
            openWindow();
        },
        cancel() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            pending = null;
        }
    };
}

export function createCursorThrottle(
    fn: (x: number, y: number) => void,
    intervalMs: number = CURSOR_THROTTLE_MS
): { send: (x: number, y: number) => void; cancel: () => void } {
    const throttle = createTrailingThrottle<{ x: number; y: number }>(
        ({ x, y }) => fn(x, y),
        intervalMs
    );
    return {
        send: (x: number, y: number) => throttle.send({ x, y }),
        cancel: throttle.cancel
    };
}

// Fixed palette hashed by userId so every client renders the same color for
// a given user (avatar ring now; cursors and laser trails in later slices).
export const PRESENCE_COLORS = [
    "#a78bfa", // violet
    "#f472b6", // pink
    "#fb923c", // orange
    "#34d399", // emerald
    "#38bdf8", // sky
    "#facc15", // yellow
    "#f87171", // red
    "#a3e635" // lime
];

export function presenceColor(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    }
    return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}
