import { describe, expect, it, beforeEach } from "vitest";
import {
    createEmptyLocalCanvas,
    getLocalCanvas,
    localCanvasResource,
    saveLocalCanvas
} from "./localCanvasStore";
import type { LocalCanvas } from "./localCanvasStore";
import type {
    CanvasAnnotation,
    CanvasDraft,
    CanvasGroup,
    CanvasPoolPlacement
} from "./schemas";

class MemoryStorage {
    private store = new Map<string, string>();
    getItem(key: string): string | null {
        return this.store.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.store.set(key, value);
    }
    removeItem(key: string): void {
        this.store.delete(key);
    }
    clear(): void {
        this.store.clear();
    }
}

Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    writable: true
});

beforeEach(() => {
    localStorage.clear();
});

const note = (id: string): CanvasAnnotation => ({
    id,
    canvas_id: "local",
    group_id: null,
    positionX: 10,
    positionY: 20,
    width: 380,
    height: 120,
    text: `note ${id}`,
    color: "slate",
    fontSize: "md",
    manualWidth: null,
    manualHeight: null
});

const card = (id: string): CanvasDraft => ({
    draft_id: id,
    group_id: null,
    positionX: 0,
    positionY: 0,
    Draft: { id, name: id, type: "canvas", picks: [] }
});

const group = (id: string): CanvasGroup => ({
    id,
    canvas_id: "local",
    name: id,
    type: "custom",
    positionX: 0,
    positionY: 0,
    parent_group_id: null,
    width: 400,
    height: 300,
    metadata: {}
});

const pool = (id: string): CanvasPoolPlacement => ({
    id,
    canvas_id: "local",
    pool_id: `${id}-pool`,
    positionX: 100,
    positionY: 200,
    Pool: {
        id: `${id}-pool`,
        name: `Pool ${id}`,
        champions: { top: [], jungle: [], mid: [], adc: [], support: [] },
        version: 0
    }
});

const populated = (): LocalCanvas => ({
    ...createEmptyLocalCanvas("Fixture", "desc", "icon", "wide"),
    drafts: [card("d1")],
    groups: [group("g1")],
    annotations: [note("a1"), note("a2")],
    pools: [pool("p1")],
    viewport: { x: 5, y: 6, zoom: 0.5 }
});

describe("localCanvasResource", () => {
    // The regression this exists for: the anonymous canvas resource carried a
    // hardcoded `annotations: []` beside siblings that all read from the store,
    // so a local canvas rendered NO notes until some later mutation happened to
    // refresh it. The write path was never at fault.
    it("carries the stored annotations, not an empty list", () => {
        const local = populated();

        expect(localCanvasResource(local).annotations).toEqual(local.annotations);
    });

    it("carries every other stored collection through unchanged", () => {
        const local = populated();
        const resource = localCanvasResource(local);

        expect(resource.drafts).toEqual(local.drafts);
        expect(resource.groups).toEqual(local.groups);
        expect(resource.connections).toEqual(local.connections);
        expect(resource.lastViewport).toEqual(local.viewport);
        expect(resource.cardLayout).toBe("wide");
    });

    // The one-mapper-one-test contract (design note above): `pools` is the
    // field this task adds to `LocalCanvas`. This test exists specifically to
    // force it into the enumeration below the moment it's added — the same
    // shape as the annotations bug this mapper was already extracted to fix.
    it("carries the stored pools, not a hardcoded empty list", () => {
        const local = populated();

        expect(localCanvasResource(local).pools).toEqual(local.pools);
    });

    // A LocalCanvas key that the mapper forgets renders as absent/empty rather
    // than failing anything, which is exactly how the annotations bug survived.
    // Enumerating the keys makes the next omission fail here instead.
    it("maps every collection key LocalCanvas defines", () => {
        const local = populated();
        const resource = localCanvasResource(local);
        const carried: Record<string, unknown[]> = {
            drafts: resource.drafts,
            groups: resource.groups,
            connections: resource.connections,
            annotations: resource.annotations,
            pools: resource.pools
        };

        for (const key of ["drafts", "groups", "connections", "annotations", "pools"]) {
            expect(carried[key], `${key} is missing from the resource mapping`).toEqual(
                local[
                    key as "drafts" | "groups" | "connections" | "annotations" | "pools"
                ]
            );
        }
    });

    it("keeps an empty canvas empty rather than undefined", () => {
        const resource = localCanvasResource(createEmptyLocalCanvas("Empty"));

        expect(resource.annotations).toEqual([]);
        expect(resource.pools).toEqual([]);
        expect(resource.userPermissions).toBe("admin");
        expect(resource.id).toBe("local");
    });
});

// The legacy (pre-Task-12) stored shape, typed via its own Omit<> rather
// than produced by casting a modern LocalCanvas and deleting the field —
// the field is genuinely absent in real pre-Task-12 localStorage, so the
// fixture's type should say so directly.
type LegacyLocalCanvas = Omit<LocalCanvas, "pools">;

// The legacy (pre-Task-12, or a canvas saved by an earlier build of THIS
// feature) stored pool shape: `version` genuinely absent, not deleted off a
// fully-typed modern `Pool`.
type LegacyPool = Omit<CanvasPoolPlacement["Pool"], "version">;
type LegacyPoolPlacement = Omit<CanvasPoolPlacement, "Pool"> & { Pool: LegacyPool };

describe("getLocalCanvas pools backfill", () => {
    it("backfills pools: [] on a canvas saved before the field existed", () => {
        // Simulate a pre-Task-12 stored canvas: write raw JSON with no `pools`
        // key at all, mirroring what a real anonymous user's localStorage would
        // hold after this ships.
        const legacy: LegacyLocalCanvas = {
            name: "Legacy",
            description: "",
            icon: "",
            cardLayout: "vertical",
            drafts: [],
            connections: [],
            groups: [],
            annotations: [],
            viewport: { x: 0, y: 0, zoom: 1 },
            createdAt: new Date().toISOString()
        };
        localStorage.setItem("draft-sim:local-canvas", JSON.stringify(legacy));

        expect(getLocalCanvas()?.pools).toEqual([]);
    });

    it("backfills a stored pool's missing version to 0 rather than dropping it", () => {
        const legacyPool: LegacyPoolPlacement = {
            id: "p1",
            canvas_id: "local",
            pool_id: "p1-pool",
            positionX: 100,
            positionY: 200,
            Pool: {
                id: "p1-pool",
                name: "Pool p1",
                champions: { top: [], jungle: [], mid: [], adc: [], support: [] }
            }
        };
        const legacyRecord = {
            ...createEmptyLocalCanvas("Legacy"),
            pools: [legacyPool]
        };
        localStorage.setItem("draft-sim:local-canvas", JSON.stringify(legacyRecord));

        const loaded = getLocalCanvas();
        expect(loaded?.pools).toHaveLength(1);
        expect(loaded?.pools[0]?.Pool.version).toBe(0);
    });

    it("preserves a stored pool's existing version rather than resetting it", () => {
        const withVersion: CanvasPoolPlacement = {
            ...pool("p1"),
            Pool: { ...pool("p1").Pool, version: 4 }
        };
        saveLocalCanvas({ ...createEmptyLocalCanvas("Fixture"), pools: [withVersion] });

        expect(getLocalCanvas()?.pools[0]?.Pool.version).toBe(4);
    });
});
