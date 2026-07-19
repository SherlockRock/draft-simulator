import { describe, expect, it, vi } from "vitest";
import { createLaserKeyTracker } from "./laserKey";

type KeyEventLike = {
    key: string;
    repeat: boolean;
    preventDefault: () => void;
};

const keyEvent = (key: string, repeat = false): KeyEventLike & {
    preventDefault: ReturnType<typeof vi.fn>;
} => ({
    key,
    repeat,
    preventDefault: vi.fn()
});

function build(canActivate = () => true) {
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();
    const tracker = createLaserKeyTracker({ canActivate, onActivate, onDeactivate });
    return { tracker, onActivate, onDeactivate };
}

describe("createLaserKeyTracker", () => {
    it("Tab keydown activates, prevents default and fires onActivate", () => {
        const { tracker, onActivate } = build();
        const e = keyEvent("Tab");

        tracker.handleKeyDown(e);

        expect(tracker.active()).toBe(true);
        expect(e.preventDefault).toHaveBeenCalledOnce();
        expect(onActivate).toHaveBeenCalledOnce();
    });

    it("non-Tab keydown is ignored", () => {
        const { tracker, onActivate } = build();
        const e = keyEvent("Enter");

        tracker.handleKeyDown(e);

        expect(tracker.active()).toBe(false);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(onActivate).not.toHaveBeenCalled();
    });

    it("key-repeat while active is swallowed without re-activating", () => {
        const { tracker, onActivate } = build();
        tracker.handleKeyDown(keyEvent("Tab"));
        const repeat = keyEvent("Tab", true);

        tracker.handleKeyDown(repeat);

        expect(tracker.active()).toBe(true);
        // Repeats must still be prevented: an unhandled repeat would move
        // focus mid-stroke.
        expect(repeat.preventDefault).toHaveBeenCalledOnce();
        expect(onActivate).toHaveBeenCalledOnce();
    });

    it("key-repeat while inactive does not activate", () => {
        const { tracker, onActivate } = build();
        const repeat = keyEvent("Tab", true);

        tracker.handleKeyDown(repeat);

        expect(tracker.active()).toBe(false);
        expect(repeat.preventDefault).not.toHaveBeenCalled();
        expect(onActivate).not.toHaveBeenCalled();
    });

    it("does not hijack Tab when the guard says no (interactive element focused)", () => {
        const { tracker, onActivate } = build(() => false);
        const e = keyEvent("Tab");

        tracker.handleKeyDown(e);

        expect(tracker.active()).toBe(false);
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(onActivate).not.toHaveBeenCalled();
    });

    it("Tab keyup deactivates and fires onDeactivate", () => {
        const { tracker, onDeactivate } = build();
        tracker.handleKeyDown(keyEvent("Tab"));

        tracker.handleKeyUp({ key: "Tab" });

        expect(tracker.active()).toBe(false);
        expect(onDeactivate).toHaveBeenCalledOnce();
    });

    it("non-Tab keyup keeps the hold active", () => {
        const { tracker, onDeactivate } = build();
        tracker.handleKeyDown(keyEvent("Tab"));

        tracker.handleKeyUp({ key: "Shift" });

        expect(tracker.active()).toBe(true);
        expect(onDeactivate).not.toHaveBeenCalled();
    });

    it("Tab keyup while inactive is a no-op", () => {
        const { tracker, onDeactivate } = build();

        tracker.handleKeyUp({ key: "Tab" });

        expect(onDeactivate).not.toHaveBeenCalled();
    });

    it("deactivate (blur/hidden) ends an active hold and is idempotent", () => {
        const { tracker, onDeactivate } = build();
        tracker.handleKeyDown(keyEvent("Tab"));

        tracker.deactivate();
        tracker.deactivate();

        expect(tracker.active()).toBe(false);
        expect(onDeactivate).toHaveBeenCalledOnce();
    });

    it("deactivate while inactive fires nothing", () => {
        const { tracker, onDeactivate } = build();

        tracker.deactivate();

        expect(onDeactivate).not.toHaveBeenCalled();
    });

    it("a fresh press after release activates again", () => {
        const { tracker, onActivate, onDeactivate } = build();

        tracker.handleKeyDown(keyEvent("Tab"));
        tracker.handleKeyUp({ key: "Tab" });
        tracker.handleKeyDown(keyEvent("Tab"));

        expect(tracker.active()).toBe(true);
        expect(onActivate).toHaveBeenCalledTimes(2);
        expect(onDeactivate).toHaveBeenCalledOnce();
    });
});
