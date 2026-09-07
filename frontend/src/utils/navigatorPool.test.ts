import { describe, expect, test } from "vitest";
import type { TeamPool } from "@draft-sim/shared-types";
import { detectStaleBuckets, rebucketDisplay, staleBucketSummary } from "./navigatorPool";

const pool = (
    display: Partial<TeamPool["display"]>,
    search: string[] = []
): TeamPool => ({
    display: { top: [], jungle: [], mid: [], adc: [], support: [], ...display },
    search
});

describe("detectStaleBuckets (design § 7)", () => {
    test("Meraki-era buckets: Vayne adc-only is stale-out (top); Sylas mid/top is stale-in (top) and stale-out (jungle, support)", () => {
        const entries = detectStaleBuckets(
            pool({ adc: ["Vayne"], mid: ["Sylas"], top: ["Sylas"] })
        );
        expect(entries).toContainEqual({
            championId: "Vayne",
            role: "top",
            kind: "stale-out"
        });
        expect(entries).toContainEqual({
            championId: "Sylas",
            role: "top",
            kind: "stale-in"
        });
        expect(entries).toContainEqual({
            championId: "Sylas",
            role: "jungle",
            kind: "stale-out"
        });
        expect(entries).toContainEqual({
            championId: "Sylas",
            role: "support",
            kind: "stale-out"
        });
        expect(entries.filter((e) => e.championId === "Vayne")).toHaveLength(1);
    });
    test("a champion only in search that lists roles is stale-out for each", () => {
        const entries = detectStaleBuckets(pool({}, ["Poppy"]));
        expect(entries.map((e) => `${e.kind}:${e.role}`).sort()).toEqual([
            "stale-out:jungle",
            "stale-out:support",
            "stale-out:top"
        ]);
    });
    test("current buckets are clean; the empty pool is clean", () => {
        expect(
            detectStaleBuckets(
                pool({ top: ["Vayne"], adc: ["Vayne", "Xayah"], jungle: ["Hecarim"] })
            )
        ).toEqual([]);
        expect(detectStaleBuckets(pool({}))).toEqual([]);
    });
});

describe("rebucketDisplay", () => {
    test("keeps the champion set, re-derives the buckets, preserves existing order, leaves search alone", () => {
        const before = pool({ adc: ["Xayah", "Vayne"], mid: ["Sylas"], top: ["Sylas"] }, [
            "Xayah",
            "Vayne",
            "Sylas"
        ]);
        const after = rebucketDisplay(before);
        expect(after.display.adc).toEqual(["Xayah", "Vayne"]);
        expect(after.display.top).toEqual(["Vayne"]);
        expect(after.display.mid).toEqual(["Sylas"]);
        expect(after.display.jungle).toEqual(["Sylas"]);
        expect(after.display.support).toEqual(["Sylas"]);
        expect(after.search).toBe(before.search);
        expect(detectStaleBuckets(after)).toEqual([]);
    });
    test("is NOT Load defaults: an empty pool stays empty", () => {
        expect(rebucketDisplay(pool({}))).toEqual(pool({}));
    });
    test("idempotent", () => {
        const once = rebucketDisplay(pool({ adc: ["Vayne"] }));
        expect(rebucketDisplay(once)).toEqual(once);
    });
});

describe("staleBucketSummary", () => {
    test("one line per stale champion: current buckets → listed roles", () => {
        expect(
            staleBucketSummary(
                pool({ adc: ["Vayne"], mid: ["Sylas"], top: ["Sylas"] }),
                (id) => id
            )
        ).toEqual(["Sylas: top, mid → mid, jungle, support", "Vayne: adc → top, adc"]);
    });
});
