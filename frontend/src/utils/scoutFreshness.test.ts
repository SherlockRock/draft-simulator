import { describe, it, expect } from "vitest";
import { formatFetchedAgo } from "./scoutFreshness";

const at = (iso: string) => Date.parse(iso);
const BASE = "2026-07-27T12:00:00.000Z";

describe("formatFetchedAgo", () => {
    it("reads as 'just now' under a minute", () => {
        expect(formatFetchedAgo(BASE, at("2026-07-27T12:00:59.000Z"))).toBe("just now");
    });

    it("counts whole minutes under an hour", () => {
        expect(formatFetchedAgo(BASE, at("2026-07-27T12:12:30.000Z"))).toBe("12m ago");
        expect(formatFetchedAgo(BASE, at("2026-07-27T12:59:59.000Z"))).toBe("59m ago");
    });

    it("counts whole hours under a day", () => {
        expect(formatFetchedAgo(BASE, at("2026-07-27T13:00:00.000Z"))).toBe("1h ago");
        expect(formatFetchedAgo(BASE, at("2026-07-28T11:59:00.000Z"))).toBe("23h ago");
    });

    it("counts whole days beyond that", () => {
        expect(formatFetchedAgo(BASE, at("2026-07-29T12:00:00.000Z"))).toBe("2d ago");
    });

    // Clock skew between the u.gg fetch and this browser is normal and must not
    // surface as "-3m ago".
    it("clamps a timestamp in the future to 'just now'", () => {
        expect(formatFetchedAgo(BASE, at("2026-07-27T11:55:00.000Z"))).toBe("just now");
    });

    it("returns an empty string for an unparseable timestamp", () => {
        expect(formatFetchedAgo("not a date", at(BASE))).toBe("");
    });
});
