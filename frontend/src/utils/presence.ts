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
