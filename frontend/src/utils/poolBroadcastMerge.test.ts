import { describe, it, expect } from "vitest";
import type { Pool, PoolChampionOp, RolePoolMap } from "@draft-sim/shared-types";
import { opReflected, pushPendingOp, mergePoolBroadcast } from "./poolBroadcastMerge";

const emptyMap = (): RolePoolMap => ({
    top: [],
    jungle: [],
    mid: [],
    adc: [],
    support: []
});

const makeMap = (partial: Partial<RolePoolMap>): RolePoolMap => ({
    ...emptyMap(),
    ...partial
});

const makePool = (champions: RolePoolMap, version = 1): Pool => ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Scrim pool",
    champions,
    version
});

const add = (role: PoolChampionOp["role"], championId: string): PoolChampionOp => ({
    type: "add",
    role,
    championId
});
const remove = (role: PoolChampionOp["role"], championId: string): PoolChampionOp => ({
    type: "remove",
    role,
    championId
});

describe("opReflected", () => {
    it("reports an add as reflected once the map contains the champion", () => {
        expect(opReflected(makeMap({ mid: ["Ahri"] }), add("mid", "Ahri"))).toBe(true);
        expect(opReflected(makeMap({ mid: [] }), add("mid", "Ahri"))).toBe(false);
    });

    it("reports a remove as reflected once the map lacks the champion", () => {
        expect(opReflected(makeMap({ mid: [] }), remove("mid", "Ahri"))).toBe(true);
        expect(opReflected(makeMap({ mid: ["Ahri"] }), remove("mid", "Ahri"))).toBe(
            false
        );
    });

    it("is role-scoped — the same champion in another role does not reflect", () => {
        expect(opReflected(makeMap({ top: ["Ahri"] }), add("mid", "Ahri"))).toBe(false);
    });
});

describe("pushPendingOp", () => {
    it("appends an op to an empty queue", () => {
        expect(pushPendingOp([], add("mid", "Ahri"))).toEqual([add("mid", "Ahri")]);
    });

    it("collapses a toggle — add then remove of the same slot keeps only the remove", () => {
        const pending = pushPendingOp([add("mid", "Ahri")], remove("mid", "Ahri"));
        expect(pending).toEqual([remove("mid", "Ahri")]);
    });

    it("collapses the mirror toggle — remove then add keeps only the add", () => {
        const pending = pushPendingOp([remove("mid", "Ahri")], add("mid", "Ahri"));
        expect(pending).toEqual([add("mid", "Ahri")]);
    });

    it("does not collapse ops on a different champion", () => {
        const pending = pushPendingOp([add("mid", "Ahri")], add("mid", "Zed"));
        expect(pending).toEqual([add("mid", "Ahri"), add("mid", "Zed")]);
    });

    it("does not collapse the same champion in a different role", () => {
        const pending = pushPendingOp([add("mid", "Ahri")], remove("top", "Ahri"));
        expect(pending).toEqual([add("mid", "Ahri"), remove("top", "Ahri")]);
    });

    it("does not mutate the queue it is given", () => {
        const pending = [add("mid", "Ahri")];
        pushPendingOp(pending, remove("mid", "Ahri"));
        expect(pending).toEqual([add("mid", "Ahri")]);
    });
});

describe("mergePoolBroadcast", () => {
    it("passes an incoming payload through untouched when nothing is pending", () => {
        const incoming = makePool(makeMap({ mid: ["Ahri"] }), 4);
        const { pool, remaining } = mergePoolBroadcast(incoming, []);
        expect(pool.champions).toEqual(makeMap({ mid: ["Ahri"] }));
        expect(pool.version).toBe(4);
        expect(pool.name).toBe("Scrim pool");
        expect(remaining).toEqual([]);
    });

    it("acknowledges a reflected add — dropped from remaining, payload unchanged", () => {
        const incoming = makePool(makeMap({ mid: ["Ahri"] }), 5);
        const { pool, remaining } = mergePoolBroadcast(incoming, [add("mid", "Ahri")]);
        expect(remaining).toEqual([]);
        expect(pool.champions).toEqual(makeMap({ mid: ["Ahri"] }));
    });

    it("acknowledges a reflected remove — dropped from remaining, payload unchanged", () => {
        const incoming = makePool(makeMap({ mid: [] }), 5);
        const { pool, remaining } = mergePoolBroadcast(incoming, [remove("mid", "Ahri")]);
        expect(remaining).toEqual([]);
        expect(pool.champions).toEqual(makeMap({ mid: [] }));
    });

    it("replays an unreflected pending add over a foreign payload (the lost-op case)", () => {
        // Another editor's full payload lands before this client's add commits.
        const incoming = makePool(makeMap({ mid: ["Zed"] }), 6);
        const { pool, remaining } = mergePoolBroadcast(incoming, [add("mid", "Ahri")]);
        expect(pool.champions.mid).toEqual(["Zed", "Ahri"]);
        expect(remaining).toEqual([add("mid", "Ahri")]);
    });

    it("replays an unreflected pending remove over a foreign payload", () => {
        const incoming = makePool(makeMap({ mid: ["Zed", "Ahri"] }), 6);
        const { pool, remaining } = mergePoolBroadcast(incoming, [remove("mid", "Ahri")]);
        expect(pool.champions.mid).toEqual(["Zed"]);
        expect(remaining).toEqual([remove("mid", "Ahri")]);
    });

    it("returns a payload that already contains everything unchanged", () => {
        const incoming = makePool(makeMap({ mid: ["Zed", "Ahri"], top: ["Sett"] }), 9);
        const { pool, remaining } = mergePoolBroadcast(incoming, [
            add("mid", "Ahri"),
            add("top", "Sett")
        ]);
        expect(pool.champions).toEqual(makeMap({ mid: ["Zed", "Ahri"], top: ["Sett"] }));
        expect(remaining).toEqual([]);
    });

    it("does not resurrect a champion the user just removed after a toggle collapse", () => {
        // [add X, remove X] collapsed to [remove X]; a payload lacking X acks it.
        const pending = pushPendingOp([add("mid", "Ahri")], remove("mid", "Ahri"));
        const incoming = makePool(makeMap({ mid: [] }), 7);
        const { pool, remaining } = mergePoolBroadcast(incoming, pending);
        expect(pool.champions.mid).toEqual([]);
        expect(remaining).toEqual([]);
    });

    it("does not drop a champion the user just re-added after the mirror collapse", () => {
        const pending = pushPendingOp([remove("mid", "Ahri")], add("mid", "Ahri"));
        const incoming = makePool(makeMap({ mid: ["Ahri"] }), 7);
        const { pool, remaining } = mergePoolBroadcast(incoming, pending);
        expect(pool.champions.mid).toEqual(["Ahri"]);
        expect(remaining).toEqual([]);
    });

    it("partially acknowledges — reflected ops drop, unreflected ones replay", () => {
        const incoming = makePool(makeMap({ mid: ["Ahri"], top: [] }), 8);
        const { pool, remaining } = mergePoolBroadcast(incoming, [
            add("mid", "Ahri"),
            add("top", "Sett")
        ]);
        expect(pool.champions.mid).toEqual(["Ahri"]);
        expect(pool.champions.top).toEqual(["Sett"]);
        expect(remaining).toEqual([add("top", "Sett")]);
    });

    it("does not mutate the incoming pool or its champion map", () => {
        const champions = makeMap({ mid: ["Zed"] });
        const incoming = makePool(champions, 3);
        mergePoolBroadcast(incoming, [add("mid", "Ahri")]);
        expect(champions.mid).toEqual(["Zed"]);
        expect(incoming.champions).toBe(champions);
    });
});
