import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
    createCanvas: vi.fn(),
    postNewDraft: vi.fn(),
    createCanvasGroup: vi.fn(),
    updateCanvasGroup: vi.fn(),
    updateCanvasDraft: vi.fn(),
    createAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    createConnection: vi.fn(),
    updateCanvasViewport: vi.fn(),
    updateCanvasDraftPositions: vi.fn()
}));
import {
    annotationSyncEntries,
    nestedGroupSyncEntries,
    stripUnsyncableGroupMetadata,
    syncLocalCanvasToServer
} from "./syncLocalCanvas";
import type { CanvasAnnotation, CanvasDraft, CanvasGroup } from "./schemas";
import {
    createAnnotation,
    createCanvas,
    createCanvasGroup,
    createConnection,
    postNewDraft,
    updateAnnotation,
    updateCanvasViewport
} from "./actions";
import { createEmptyLocalCanvas, saveLocalCanvas } from "./localCanvasStore";

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

const localAnnotation = (
    id: string,
    over: Partial<CanvasAnnotation> = {}
): CanvasAnnotation => ({
    id,
    canvas_id: "local",
    group_id: null,
    positionX: 10,
    positionY: 20,
    width: 380,
    height: 120,
    text: "",
    championIds: [],
    color: "slate",
    fontSize: "md",
    ...over
});

const localDraft = (id: string): CanvasDraft => ({
    draft_id: id,
    positionX: 0,
    positionY: 0,
    group_id: null,
    source_type: "canvas",
    Draft: {
        id,
        name: id,
        picks: Array(20).fill(""),
        type: "canvas"
    }
});

describe("annotationSyncEntries", () => {
    it("remaps group ids and passes content through", () => {
        expect(
            annotationSyncEntries(
                [
                    localAnnotation("local-a", {
                        group_id: "local-g",
                        text: "S tier",
                        championIds: ["Ahri"]
                    })
                ],
                new Map([["local-g", "server-g"]])
            )
        ).toEqual([
            expect.objectContaining({
                sourceId: "local-a",
                group_id: "server-g",
                text: "S tier",
                championIds: ["Ahri"]
            })
        ]);
    });

    it("sends null for a group that is not in the map", () => {
        const entries = annotationSyncEntries(
            [localAnnotation("local-a", { group_id: "ghost" })],
            new Map()
        );

        expect(entries[0].group_id).toBe(null);
    });

    it("carries manual size floors without coercing null to zero", () => {
        const entries = annotationSyncEntries(
            [
                localAnnotation("sized", { manualWidth: 440, manualHeight: 260 }),
                localAnnotation("unset", { manualWidth: null, manualHeight: null })
            ],
            new Map()
        );

        expect(entries[0]).toEqual(
            expect.objectContaining({ manualWidth: 440, manualHeight: 260 })
        );
        expect(entries[1]).toEqual(
            expect.objectContaining({ manualWidth: null, manualHeight: null })
        );
    });
});

/**
 * syncLocalCanvasToServer has no test harness (it drives seven network actions
 * end to end), so this asserts at the cheapest seam: the pure strip function
 * the sync loop routes every group's metadata through.
 */
describe("stripUnsyncableGroupMetadata", () => {
    it("drops gameType and keeps everything else", () => {
        const stripped = stripUnsyncableGroupMetadata({
            gameType: "scrim",
            blueTeamName: "T1",
            redTeamName: "GenG",
            layout: "grid",
            gridCols: 3,
            origin: "manual",
            seriesType: "fearless"
        });

        expect(Object.prototype.hasOwnProperty.call(stripped, "gameType")).toBe(false);
        expect(stripped).toEqual({
            blueTeamName: "T1",
            redTeamName: "GenG",
            layout: "grid",
            gridCols: 3,
            origin: "manual",
            seriesType: "fearless"
        });
    });

    it("leaves untagged metadata untouched", () => {
        expect(stripUnsyncableGroupMetadata({ layout: "free" })).toEqual({
            layout: "free"
        });
    });

    it("empties metadata whose only customization was the tag", () => {
        // The sync loop keys `hasMetadata` off this result, so a group tagged
        // and nothing else must send no metadata at all.
        expect(
            Object.keys(stripUnsyncableGroupMetadata({ gameType: "official" }))
        ).toHaveLength(0);
    });
});

const localGroup = (
    id: string,
    opts: { parent?: string | null; x?: number; y?: number } = {}
): CanvasGroup => ({
    id,
    canvas_id: "local",
    name: id,
    type: "custom",
    positionX: opts.x ?? 0,
    positionY: opts.y ?? 0,
    parent_group_id: opts.parent ?? null,
    metadata: {}
});

describe("nestedGroupSyncEntries", () => {
    it("emits nothing for a flat local canvas", () => {
        expect(
            nestedGroupSyncEntries([localGroup("a"), localGroup("b")], new Map())
        ).toEqual([]);
    });

    it("remaps BOTH ids and carries the position unchanged", () => {
        const groups = [
            localGroup("local-parent", { x: 10, y: 20 }),
            localGroup("local-child", { parent: "local-parent", x: 30, y: 40 })
        ];
        const idMap = new Map([
            ["local-parent", "server-parent"],
            ["local-child", "server-child"]
        ]);

        expect(nestedGroupSyncEntries(groups, idMap)).toEqual([
            {
                id: "server-child",
                positionX: 30,
                positionY: 40,
                parentId: "server-parent"
            }
        ]);
    });

    it("needs no ordering — a child listed before its parent still remaps", () => {
        const groups = [localGroup("child", { parent: "parent" }), localGroup("parent")];
        const idMap = new Map([
            ["parent", "s-parent"],
            ["child", "s-child"]
        ]);
        expect(nestedGroupSyncEntries(groups, idMap)[0].parentId).toBe("s-parent");
    });

    it("sends a parent it could not map as top level rather than a local id", () => {
        // A local id would 400 the whole batch. Top level is the same fallback
        // `renderOrder` already applies to an orphan.
        const groups = [localGroup("child", { parent: "gone" })];
        expect(nestedGroupSyncEntries(groups, new Map([["child", "s-child"]]))).toEqual([
            { id: "s-child", positionX: 0, positionY: 0, parentId: null }
        ]);
    });
});

describe("syncLocalCanvasToServer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.mocked(createCanvas).mockResolvedValue({
            success: true,
            canvas: { id: "server-canvas", name: "My Canvas", drafts: [] }
        });
        vi.mocked(updateCanvasViewport).mockResolvedValue({ success: true });
        vi.mocked(createCanvasGroup).mockResolvedValue({
            success: true,
            group: localGroup("server-group")
        });
        vi.mocked(postNewDraft).mockResolvedValue({
            id: "server-draft",
            name: "draft",
            picks: Array<string>(20).fill(""),
            type: "canvas",
            public: false,
            owner_id: null,
            firstPick: "blue",
            blueSideTeam: 1
        });
        vi.mocked(createAnnotation).mockResolvedValue({
            success: true,
            annotation: localAnnotation("server-annotation")
        });
        vi.mocked(updateAnnotation).mockResolvedValue({
            success: true,
            annotation: localAnnotation("server-annotation")
        });
        vi.mocked(createConnection).mockResolvedValue({
            success: true,
            connection: {
                id: "server-connection",
                canvas_id: "server-canvas",
                source_draft_ids: [],
                target_draft_ids: [],
                vertices: [],
                style: "solid"
            }
        });
    });

    it("syncs an annotation-only canvas instead of treating it as empty", async () => {
        const canvas = createEmptyLocalCanvas("My Canvas");
        canvas.annotations = [
            localAnnotation("a1", {
                text: "keep me",
                manualWidth: 440,
                manualHeight: 260
            })
        ];
        saveLocalCanvas(canvas);

        const canvasId = await syncLocalCanvasToServer();

        expect(canvasId).toBe("server-canvas");
        expect(createAnnotation).toHaveBeenCalledTimes(1);
        expect(createAnnotation).toHaveBeenCalledWith(
            expect.objectContaining({
                canvasId: "server-canvas",
                text: "keep me",
                manualWidth: 440,
                manualHeight: 260
            })
        );
        expect(updateAnnotation).not.toHaveBeenCalled();
    });

    it("creates annotations after Cards and before Connections", async () => {
        const canvas = createEmptyLocalCanvas("My Canvas");
        canvas.drafts = [localDraft("d1")];
        canvas.annotations = [localAnnotation("a1")];
        canvas.connections = [
            {
                id: "c1",
                canvas_id: "local",
                source_draft_ids: [{ draft_id: "d1", anchor_type: "right" }],
                target_draft_ids: [{ draft_id: "d1", anchor_type: "left" }],
                vertices: [],
                style: "solid"
            }
        ];
        saveLocalCanvas(canvas);

        await syncLocalCanvasToServer();

        expect(vi.mocked(postNewDraft).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(createAnnotation).mock.invocationCallOrder[0]
        );
        expect(vi.mocked(createAnnotation).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(createConnection).mock.invocationCallOrder[0]
        );
    });

    it("remaps annotation endpoint ids before creating Connections", async () => {
        const canvas = createEmptyLocalCanvas("My Canvas");
        canvas.drafts = [localDraft("d1")];
        canvas.annotations = [localAnnotation("local-annotation")];
        canvas.connections = [
            {
                id: "c1",
                canvas_id: "local",
                source_draft_ids: [{ draft_id: "d1", anchor_type: "right" }],
                target_draft_ids: [
                    {
                        type: "annotation",
                        annotation_id: "local-annotation",
                        anchor_type: "left"
                    }
                ],
                vertices: [],
                style: "solid"
            }
        ];
        saveLocalCanvas(canvas);

        await syncLocalCanvasToServer();

        expect(createConnection).toHaveBeenCalledWith(
            expect.objectContaining({
                targetDraftIds: [
                    { annotationId: "server-annotation", anchorType: "left" }
                ]
            })
        );
    });
});
