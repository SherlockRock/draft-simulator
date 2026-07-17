import { z } from "zod";

export const presenceUserSchema = z.object({
    userId: z.string(),
    displayName: z.string(),
    picture: z.string().nullable()
});

export type PresenceUser = z.infer<typeof presenceUserSchema>;

export const presenceSnapshotSchema = z.object({
    canvasId: z.string(),
    users: z.array(presenceUserSchema)
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

export const CURSOR_THROTTLE_MS = 35;
export const CURSOR_IDLE_MS = 5000;

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

// Leading + trailing throttle for cursor emits: the first move goes out
// immediately, moves inside the window coalesce into one trailing send with
// the latest coordinates (so the remote cursor always lands on the final
// resting position), and cancel() drops any pending trailing send.
export function createCursorThrottle(
    fn: (x: number, y: number) => void,
    intervalMs: number = CURSOR_THROTTLE_MS
): { send: (x: number, y: number) => void; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { x: number; y: number } | null = null;

    const openWindow = () => {
        timer = setTimeout(() => {
            timer = null;
            if (pending) {
                const { x, y } = pending;
                pending = null;
                fn(x, y);
                openWindow();
            }
        }, intervalMs);
    };

    return {
        send(x: number, y: number) {
            if (timer) {
                pending = { x, y };
                return;
            }
            fn(x, y);
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
