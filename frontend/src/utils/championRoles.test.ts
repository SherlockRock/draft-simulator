import { describe, it, expect } from "vitest";
import { isRole, ROLES } from "./championRoles";

describe("isRole", () => {
    it("accepts every role the pool card renders rows for", () => {
        for (const role of ROLES) expect(isRole(role)).toBe(true);
    });

    it("rejects the absent-attribute values getAttribute can hand back", () => {
        // dispatchContextMenu narrows a DOM attribute with this guard, and
        // getAttribute returns null when the row markup is missing data-role.
        expect(isRole(null)).toBe(false);
        expect(isRole(undefined)).toBe(false);
    });

    it("rejects strings that are not roles", () => {
        expect(isRole("")).toBe(false);
        expect(isRole("Top")).toBe(false); // ROLE_LABELS value, not the key
        expect(isRole("bottom")).toBe(false); // champion-meta spells ADC "BOTTOM"
        expect(isRole("mid ")).toBe(false);
    });
});
