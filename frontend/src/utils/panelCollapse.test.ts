import { describe, expect, it } from "vitest";
import {
    NO_COLLAPSE_CHOICES,
    isCollapsedAtDepth,
    toggledCollapse
} from "./panelCollapse";

describe("panel collapse defaults", () => {
    it("starts a top-level Group expanded", () => {
        expect(isCollapsedAtDepth(NO_COLLAPSE_CHOICES, "g", 0)).toBe(false);
    });

    it("starts a nested Group collapsed", () => {
        expect(isCollapsedAtDepth(NO_COLLAPSE_CHOICES, "g", 1)).toBe(true);
        expect(isCollapsedAtDepth(NO_COLLAPSE_CHOICES, "g", 4)).toBe(true);
    });

    it("lets an explicit choice win over the depth default in BOTH directions", () => {
        const collapsedTop = toggledCollapse(NO_COLLAPSE_CHOICES, "top", 0);
        expect(isCollapsedAtDepth(collapsedTop, "top", 0)).toBe(true);

        const expandedNested = toggledCollapse(NO_COLLAPSE_CHOICES, "nested", 2);
        expect(isCollapsedAtDepth(expandedNested, "nested", 2)).toBe(false);
    });

    it("toggles back to the default value", () => {
        const once = toggledCollapse(NO_COLLAPSE_CHOICES, "g", 1);
        const twice = toggledCollapse(once, "g", 1);

        expect(isCollapsedAtDepth(twice, "g", 1)).toBe(true);
    });

    it("returns a new map so a signal actually re-renders", () => {
        const next = toggledCollapse(NO_COLLAPSE_CHOICES, "g", 0);

        expect(next).not.toBe(NO_COLLAPSE_CHOICES);
        expect(NO_COLLAPSE_CHOICES.size).toBe(0);
    });

    it("keeps other Groups' choices when one is toggled", () => {
        const first = toggledCollapse(NO_COLLAPSE_CHOICES, "a", 0);
        const second = toggledCollapse(first, "b", 0);

        expect(isCollapsedAtDepth(second, "a", 0)).toBe(true);
        expect(isCollapsedAtDepth(second, "b", 0)).toBe(true);
    });
});
