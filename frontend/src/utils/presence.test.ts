import { describe, expect, it } from "vitest";
import {
    PRESENCE_COLORS,
    presenceColor,
    presenceJoinSchema,
    presenceLeaveSchema,
    presenceSnapshotSchema
} from "./presence";

describe("presenceColor", () => {
    it("is deterministic for the same userId", () => {
        expect(presenceColor("u-alice")).toBe(presenceColor("u-alice"));
    });

    it("always returns a palette color", () => {
        const ids = ["u-1", "u-2", "", "4b9380c3-53a4-4e06-9b86-8220a6dc624d"];
        for (const id of ids) {
            expect(PRESENCE_COLORS).toContain(presenceColor(id));
        }
    });

    it("spreads distinct users across more than one color", () => {
        const colors = new Set(
            Array.from({ length: 32 }, (_, i) => presenceColor(`user-${i}`))
        );
        expect(colors.size).toBeGreaterThan(1);
    });
});

describe("presence event schemas", () => {
    const user = { userId: "u-1", displayName: "Alice", picture: null };

    it("accepts a valid snapshot with nullable pictures", () => {
        const result = presenceSnapshotSchema.safeParse({
            canvasId: "c-1",
            users: [user, { ...user, userId: "u-2", picture: "p.png" }]
        });
        expect(result.success).toBe(true);
    });

    it("rejects a snapshot user without a displayName", () => {
        const result = presenceSnapshotSchema.safeParse({
            canvasId: "c-1",
            users: [{ userId: "u-1", picture: null }]
        });
        expect(result.success).toBe(false);
    });

    it("accepts join and leave payloads", () => {
        expect(presenceJoinSchema.safeParse({ canvasId: "c-1", user }).success).toBe(
            true
        );
        expect(
            presenceLeaveSchema.safeParse({ canvasId: "c-1", userId: "u-1" }).success
        ).toBe(true);
    });

    it("rejects a join without a user payload", () => {
        expect(presenceJoinSchema.safeParse({ canvasId: "c-1" }).success).toBe(false);
    });
});
