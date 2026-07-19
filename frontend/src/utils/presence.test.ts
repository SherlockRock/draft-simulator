import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    PRESENCE_COLORS,
    createCursorThrottle,
    cursorMoveSchema,
    presenceColor,
    presenceJoinSchema,
    presenceLeaveSchema,
    presenceSnapshotSchema,
    viewportMoveSchema,
    worldToScreen
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

    it("carries a snapshot user's last-known viewport through", () => {
        const viewport = { x: 10, y: -20, zoom: 1.5 };
        const result = presenceSnapshotSchema.safeParse({
            canvasId: "c-1",
            users: [{ ...user, viewport }]
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.users[0].viewport).toEqual(viewport);
        }
    });

    it("degrades a malformed or missing viewport to null without dropping the snapshot", () => {
        const result = presenceSnapshotSchema.safeParse({
            canvasId: "c-1",
            users: [
                { ...user, viewport: { x: 1, y: 2, zoom: 0 } },
                { ...user, userId: "u-2", viewport: { x: 1 } },
                { ...user, userId: "u-3" }
            ]
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.users.map((u) => u.viewport)).toEqual([null, null, null]);
        }
    });
});

describe("viewportMoveSchema", () => {
    const valid = { canvasId: "c-1", userId: "u-1", x: 10.5, y: -20, zoom: 0.75 };

    it("accepts a valid viewport move", () => {
        expect(viewportMoveSchema.safeParse(valid).success).toBe(true);
    });

    it("rejects missing or non-finite fields", () => {
        expect(viewportMoveSchema.safeParse({ ...valid, zoom: undefined }).success).toBe(
            false
        );
        expect(viewportMoveSchema.safeParse({ ...valid, x: Infinity }).success).toBe(
            false
        );
        expect(viewportMoveSchema.safeParse({ ...valid, y: "12" }).success).toBe(false);
    });

    it("rejects a non-positive zoom", () => {
        expect(viewportMoveSchema.safeParse({ ...valid, zoom: 0 }).success).toBe(false);
        expect(viewportMoveSchema.safeParse({ ...valid, zoom: -1 }).success).toBe(false);
    });

    it("rejects a payload without a userId", () => {
        expect(
            viewportMoveSchema.safeParse({ ...valid, userId: undefined }).success
        ).toBe(false);
    });
});

describe("cursorMoveSchema", () => {
    it("accepts a valid cursor event with fractional world coordinates", () => {
        const result = cursorMoveSchema.safeParse({
            canvasId: "c-1",
            userId: "u-1",
            x: 120.5,
            y: -44.25
        });
        expect(result.success).toBe(true);
    });

    it("rejects missing coordinates and non-numeric coordinates", () => {
        expect(
            cursorMoveSchema.safeParse({ canvasId: "c-1", userId: "u-1", x: 1 }).success
        ).toBe(false);
        expect(
            cursorMoveSchema.safeParse({
                canvasId: "c-1",
                userId: "u-1",
                x: "12",
                y: 2
            }).success
        ).toBe(false);
    });

    it("rejects non-finite coordinates", () => {
        expect(
            cursorMoveSchema.safeParse({
                canvasId: "c-1",
                userId: "u-1",
                x: Infinity,
                y: 0
            }).success
        ).toBe(false);
    });

    it("rejects a payload without a userId", () => {
        expect(cursorMoveSchema.safeParse({ canvasId: "c-1", x: 1, y: 2 }).success).toBe(
            false
        );
    });
});

describe("worldToScreen", () => {
    it("maps the viewport origin to screen (0, 0)", () => {
        expect(worldToScreen(50, -20, { x: 50, y: -20, zoom: 2 })).toEqual({
            x: 0,
            y: 0
        });
    });

    it("scales offsets from the viewport origin by zoom", () => {
        expect(worldToScreen(110, 40, { x: 100, y: 20, zoom: 2 })).toEqual({
            x: 20,
            y: 40
        });
    });

    it("inverts the screenToWorld transform used by Canvas", () => {
        // Canvas.tsx screenToWorld: world = screen / zoom + viewport
        const viewport = { x: -35.5, y: 210, zoom: 0.75 };
        const world = {
            x: 640 / viewport.zoom + viewport.x,
            y: 480 / viewport.zoom + viewport.y
        };
        expect(worldToScreen(world.x, world.y, viewport)).toEqual({ x: 640, y: 480 });
    });
});

describe("createCursorThrottle", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("fires the first call immediately", () => {
        const fn = vi.fn();
        const throttled = createCursorThrottle(fn, 35);

        throttled.send(1, 2);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(1, 2);
    });

    it("coalesces calls inside the interval into one trailing call with the latest args", () => {
        const fn = vi.fn();
        const throttled = createCursorThrottle(fn, 35);

        throttled.send(1, 1);
        throttled.send(2, 2);
        throttled.send(3, 3);
        expect(fn).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(35);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenLastCalledWith(3, 3);
    });

    it("does not fire a trailing call when nothing arrived during the interval", () => {
        const fn = vi.fn();
        const throttled = createCursorThrottle(fn, 35);

        throttled.send(1, 1);
        vi.advanceTimersByTime(100);

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("fires immediately again once the interval has elapsed", () => {
        const fn = vi.fn();
        const throttled = createCursorThrottle(fn, 35);

        throttled.send(1, 1);
        vi.advanceTimersByTime(35);
        throttled.send(2, 2);

        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenLastCalledWith(2, 2);
    });

    it("cancel drops the pending trailing call", () => {
        const fn = vi.fn();
        const throttled = createCursorThrottle(fn, 35);

        throttled.send(1, 1);
        throttled.send(2, 2);
        throttled.cancel();
        vi.advanceTimersByTime(100);

        expect(fn).toHaveBeenCalledTimes(1);
    });
});
