import { beforeEach, describe, expect, it } from "vitest";

/**
 * The local (anonymous, localStorage-backed) canvas is a second implementation
 * of the canvas mutations, and it has drifted from the server before. These
 * tests pin the two places that drift is expensive: the Card wire identity the
 * store reconciles on, and the coordinate convention for Cards inside a Group.
 *
 * Frontend vitest runs in the node environment, so localStorage is stubbed
 * here rather than provided by jsdom.
 */
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

const { getLocalCanvas, saveLocalCanvas, createEmptyLocalCanvas, isLocalCanvasEmpty } =
    await import("./localCanvasStore");
const {
    localNewDraft,
    localCopyDraft,
    localCreateConnection,
    localCreateGroup,
    localConvertGroupToSeries,
    localDeleteDraft,
    localDeleteGroup,
    localUpdateGroup,
    localUpdateDraftPositions,
    localCreateAnnotation,
    localUpdateAnnotation,
    localDeleteAnnotation,
    localUpdateConnection,
    localCopyAnnotation
} = await import("./useLocalCanvasMutations");
const { MAX_GROUP_DEPTH } = await import("@draft-sim/shared-types/canvas-tree-vector");
const {
    GROUP_BORDER_WIDTH,
    SERIES_GAME_CONTROLS_HEIGHT,
    SERIES_HEADER_HEIGHT,
    SERIES_PADDING_X,
    SERIES_PADDING_Y
} = await import("./helpers");

/** The seed composite, mirrored from `getSeriesDraftWorldPosition`. */
const SERIES_FIRST_CARD_Y =
    GROUP_BORDER_WIDTH +
    SERIES_HEADER_HEIGHT +
    SERIES_PADDING_Y +
    SERIES_GAME_CONTROLS_HEIGHT;

beforeEach(() => {
    localStorage.clear();
    saveLocalCanvas(createEmptyLocalCanvas("My Canvas"));
});

describe("local Card wire identity", () => {
    it("gives a new Card a top-level draft_id matching its Draft.id", () => {
        const card = localNewDraft({
            name: "Game 1",
            picks: Array(20).fill(""),
            positionX: 10,
            positionY: 20
        });

        expect(card.draft_id).toBe(card.Draft.id);
    });

    it("gives a copied Card its own draft_id, not the source's", () => {
        const source = localNewDraft({
            name: "Game 1",
            picks: Array(20).fill(""),
            positionX: 10,
            positionY: 20
        });

        const { canvasDraft: copy } = localCopyDraft(source.Draft.id);

        expect(copy.draft_id).toBe(copy.Draft.id);
        expect(copy.draft_id).not.toBe(source.draft_id);
    });

    it("gives every Card a draft_id when a series creates its games", () => {
        const { group } = localCreateGroup({ positionX: 100, positionY: 200 });
        localConvertGroupToSeries({
            groupId: group.id,
            name: "Series",
            blueTeamName: "Blue",
            redTeamName: "Red",
            length: 3,
            draftMode: "standard",
            disabledChampions: []
        });

        const cards = getLocalCanvas()?.drafts ?? [];
        expect(cards).toHaveLength(3);
        for (const card of cards) {
            expect(card.draft_id).toBe(card.Draft.id);
        }
    });

    // Canvases saved before Cards carried draft_id must not key on undefined.
    it("backfills draft_id when reading a legacy stored canvas", () => {
        const legacy = createEmptyLocalCanvas("My Canvas");
        legacy.drafts = [
            {
                positionX: 0,
                positionY: 0,
                group_id: null,
                Draft: { id: "legacy-1", name: "old", picks: [], type: "canvas" }
            }
        ] as never;
        localStorage.setItem("draft-sim:local-canvas", JSON.stringify(legacy));

        expect(getLocalCanvas()?.drafts[0].draft_id).toBe("legacy-1");
    });

    it("defaults annotations when a legacy stored canvas omits the key", () => {
        localStorage.setItem(
            "draft-sim:local-canvas",
            JSON.stringify({
                name: "Legacy Canvas",
                description: "",
                icon: "",
                cardLayout: "vertical",
                drafts: [],
                connections: [],
                groups: [],
                viewport: { x: 0, y: 0, zoom: 1 },
                createdAt: "2026-08-01T00:00:00.000Z"
            })
        );

        expect(getLocalCanvas()?.annotations).toEqual([]);
    });
});

describe("local annotations", () => {
    it("creates one with the defaults the server would apply", () => {
        const result = localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        });

        expect(result.annotation.text).toBe("");
        expect(result.annotation.championIds).toEqual([]);
        expect(result.annotation.color).toBe("slate");
        expect(getLocalCanvas()?.annotations).toHaveLength(1);
    });

    it("updates only carried fields, including nullable manual size floors", () => {
        const created = localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        }).annotation;

        localUpdateAnnotation({
            annotationId: created.id,
            text: "old",
            color: "teal",
            manualWidth: 440,
            manualHeight: 240
        });
        localUpdateAnnotation({
            annotationId: created.id,
            text: "",
            manualWidth: null,
            manualHeight: null
        });

        const stored = getLocalCanvas()?.annotations[0];
        expect(stored?.text).toBe("");
        expect(stored?.color).toBe("teal");
        expect(stored?.manualWidth).toBeNull();
        expect(stored?.manualHeight).toBeNull();
    });

    it("deletes one", () => {
        const created = localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        }).annotation;

        localDeleteAnnotation(created.id);

        expect(getLocalCanvas()?.annotations).toEqual([]);
    });

    it("copies content and manual floors at the caller's placement", () => {
        const source = localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        }).annotation;
        localUpdateAnnotation({
            annotationId: source.id,
            text: "S tier",
            championIds: ["Ahri"],
            manualWidth: null,
            manualHeight: 240
        });

        localCopyAnnotation(source.id, {
            positionX: 500,
            positionY: 300,
            group_id: null
        });

        const copy = getLocalCanvas()?.annotations[1];
        expect(copy?.text).toBe("S tier");
        expect(copy?.championIds).toEqual(["Ahri"]);
        expect(copy?.id).not.toBe(source.id);
        expect(copy?.positionX).toBe(500);
        expect(copy?.manualWidth).toBeNull();
        expect(copy?.manualHeight).toBe(240);
    });

    it("reflows the D13 zero-Card champion-pool Group in one batch", () => {
        const group = localCreateGroup({
            positionX: 100,
            positionY: 200,
            metadata: {
                layout: "grid",
                rowLabels: ["S", "A", "Situational"]
            }
        }).group;
        const annotations = [0, 1, 2].map(
            (_index) =>
                localCreateAnnotation({
                    positionX: 0,
                    positionY: 0,
                    width: 380,
                    height: 120,
                    group_id: group.id
                }).annotation
        );

        localUpdateDraftPositions({
            positions: [],
            annotations: annotations.map((annotation, index) => ({
                id: annotation.id,
                positionX: 64,
                positionY: 96 + index * 120,
                group_id: group.id
            }))
        });

        const stored = getLocalCanvas();
        expect(stored?.drafts).toEqual([]);
        expect(stored?.groups[0].metadata.rowLabels).toEqual(["S", "A", "Situational"]);
        expect(stored?.annotations.map((annotation) => annotation.positionY)).toEqual([
            96, 216, 336
        ]);
    });

    it("applies all three batch annotation membership states by key presence", () => {
        const originalGroup = localCreateGroup({ positionX: 100, positionY: 200 }).group;
        const targetGroup = localCreateGroup({ positionX: 500, positionY: 200 }).group;
        const annotations = [0, 1, 2].map(
            (index) =>
                localCreateAnnotation({
                    positionX: index * 10,
                    positionY: index * 20,
                    width: 380,
                    height: 120,
                    group_id: originalGroup.id
                }).annotation
        );
        const leaveMembershipAlone = {
            id: annotations[0].id,
            positionX: 10,
            positionY: 20
        };
        const ungroup = {
            id: annotations[1].id,
            positionX: 30,
            positionY: 40,
            group_id: null
        };
        const moveToAnotherGroup = {
            id: annotations[2].id,
            positionX: 50,
            positionY: 60,
            group_id: targetGroup.id
        };

        expect(
            Object.prototype.hasOwnProperty.call(leaveMembershipAlone, "group_id")
        ).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(ungroup, "group_id")).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(moveToAnotherGroup, "group_id")).toBe(
            true
        );

        localUpdateDraftPositions({
            positions: [],
            annotations: [leaveMembershipAlone, ungroup, moveToAnotherGroup]
        });

        const stored = getLocalCanvas()?.annotations ?? [];
        expect(stored.find((entry) => entry.id === annotations[0].id)?.group_id).toBe(
            originalGroup.id
        );
        expect(
            stored.find((entry) => entry.id === annotations[1].id)?.group_id
        ).toBeNull();
        expect(stored.find((entry) => entry.id === annotations[2].id)?.group_id).toBe(
            targetGroup.id
        );
    });
});

describe("isLocalCanvasEmpty", () => {
    it("an annotation-only canvas is not empty", () => {
        localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        });

        expect(getLocalCanvas()?.drafts).toEqual([]);
        expect(getLocalCanvas()?.groups).toEqual([]);
        expect(isLocalCanvasEmpty()).toBe(false);
    });
});

describe("local series Card placement", () => {
    // Cards are stored relative to their immediate container (ADR-0006), so
    // both branches of the series conversion must produce container-relative
    // coordinates. The empty-group branch used to add group.positionX/Y, which
    // is a world coordinate — harmless while series rendering ignores stored
    // positions, but it corrupts the moment the series is ungrouped.
    it("places the first game of an empty series relative to its group", () => {
        const { group } = localCreateGroup({ positionX: 900, positionY: 700 });

        localConvertGroupToSeries({
            groupId: group.id,
            name: "Series",
            blueTeamName: "Blue",
            redTeamName: "Red",
            length: 1,
            draftMode: "standard",
            disabledChampions: []
        });

        const card = (getLocalCanvas()?.drafts ?? [])[0];
        expect(card.positionX).toBe(SERIES_PADDING_X);
        expect(card.positionY).toBe(SERIES_FIRST_CARD_Y);
    });

    it("keeps later games on the same relative convention as the first", () => {
        const { group } = localCreateGroup({ positionX: 900, positionY: 700 });

        localConvertGroupToSeries({
            groupId: group.id,
            name: "Series",
            blueTeamName: "Blue",
            redTeamName: "Red",
            length: 3,
            draftMode: "standard",
            disabledChampions: []
        });

        const cards = [...(getLocalCanvas()?.drafts ?? [])].sort(
            (a, b) => (a.Draft.seriesIndex ?? 0) - (b.Draft.seriesIndex ?? 0)
        );
        expect(cards.map((c) => c.positionX)).toEqual([
            SERIES_PADDING_X,
            SERIES_PADDING_X + 380,
            SERIES_PADDING_X + 760
        ]);
        for (const card of cards) {
            expect(card.positionY).toBe(SERIES_FIRST_CARD_Y);
        }
    });

    // A group that already holds Cards continues from those Cards, which are
    // already relative — this branch was always correct and must stay so.
    it("continues from an existing Card's relative position", () => {
        const { group } = localCreateGroup({ positionX: 900, positionY: 700 });
        localNewDraft({
            name: "existing",
            picks: Array(20).fill(""),
            positionX: 16,
            positionY: 64,
            group_id: group.id
        });

        localConvertGroupToSeries({
            groupId: group.id,
            name: "Series",
            blueTeamName: "Blue",
            redTeamName: "Red",
            length: 2,
            draftMode: "standard",
            disabledChampions: []
        });

        const added = (getLocalCanvas()?.drafts ?? []).find(
            (d) => d.Draft.seriesIndex === 1
        );
        expect(added?.positionX).toBe(16 + 380);
        expect(added?.positionY).toBe(64);
    });
});

/**
 * The local runtime is the one with no server to fall back on: a tree it
 * accepts here is a tree the user keeps until sign-up, when the batch route
 * would reject it (5a-5).
 */
describe("local group nesting", () => {
    const create = (parentId?: string | null) =>
        localCreateGroup({ positionX: 100, positionY: 100, parentId }).group;

    it("nests a new group under a parent, keeping ABSOLUTE coordinates", () => {
        const parent = create();
        const child = localCreateGroup({
            positionX: 540,
            positionY: 460,
            parentId: parent.id
        }).group;

        expect(child.parent_group_id).toBe(parent.id);
        // ADR-0006: not rebased against the parent's origin.
        expect(child.positionX).toBe(540);
        expect(child.positionY).toBe(460);
    });

    it("leaves an unparented create at top level", () => {
        expect(create().parent_group_id ?? null).toBe(null);
    });

    it("refuses a series parent with the server's wording", () => {
        const group = create();
        localConvertGroupToSeries({
            groupId: group.id,
            name: "Bo3",
            blueTeamName: "A",
            redTeamName: "B",
            length: 3,
            draftMode: "standard",
            disabledChampions: []
        });

        expect(() => create(group.id)).toThrow("Can't put a group inside a series");
    });

    it("refuses a create past the depth cap", () => {
        let parentId: string | null = null;
        for (let depth = 0; depth <= MAX_GROUP_DEPTH; depth++) {
            parentId = create(parentId).id;
        }
        expect(() => create(parentId)).toThrow("Too deeply nested");
    });

    it("refuses converting a container that holds groups", () => {
        const parent = create();
        create(parent.id);

        expect(() =>
            localConvertGroupToSeries({
                groupId: parent.id,
                name: "Bo3",
                blueTeamName: "A",
                redTeamName: "B",
                length: 3,
                draftMode: "standard",
                disabledChampions: []
            })
        ).toThrow("Can't convert a group that contains groups");
    });

    it("refuses converting a container that holds notes without changing it", () => {
        const parent = create();
        localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: parent.id
        });

        expect(() =>
            localConvertGroupToSeries({
                groupId: parent.id,
                name: "Bo3",
                blueTeamName: "A",
                redTeamName: "B",
                length: 3,
                draftMode: "standard",
                disabledChampions: []
            })
        ).toThrow("Can't convert a group that contains notes");
        expect(
            getLocalCanvas()?.groups.find((group) => group.id === parent.id)?.type
        ).toBe("custom");
    });

    it("promotes direct children when their container is deleted", () => {
        const top = create();
        const mid = create(top.id);
        const leaf = create(mid.id);

        localDeleteGroup(mid.id, true);

        const groups = getLocalCanvas()?.groups ?? [];
        expect(groups.map((g) => g.id)).not.toContain(mid.id);
        expect(groups.find((g) => g.id === leaf.id)?.parent_group_id).toBe(top.id);
    });

    it("promotes to top level when the deleted container was top level", () => {
        const top = create();
        const child = create(top.id);

        localDeleteGroup(top.id, true);

        const groups = getLocalCanvas()?.groups ?? [];
        expect(groups.find((g) => g.id === child.id)?.parent_group_id ?? null).toBe(null);
    });

    it("moves a group to top level without touching its coordinates", () => {
        const parent = create();
        const child = localCreateGroup({
            positionX: 700,
            positionY: 800,
            parentId: parent.id
        }).group;

        localUpdateDraftPositions({
            positions: [],
            groups: [{ id: child.id, positionX: 700, positionY: 800, parentId: null }]
        });

        const stored = (getLocalCanvas()?.groups ?? []).find((g) => g.id === child.id);
        expect(stored?.parent_group_id ?? null).toBe(null);
        expect(stored?.positionX).toBe(700);
        expect(stored?.positionY).toBe(800);
    });

    it("refuses a reparent that would create a cycle", () => {
        const root = create();
        const child = create(root.id);

        expect(() =>
            localUpdateDraftPositions({
                positions: [],
                groups: [
                    {
                        id: root.id,
                        positionX: 0,
                        positionY: 0,
                        parentId: child.id
                    }
                ]
            })
        ).toThrow("Can't put a group inside itself");
    });

    it("leaves parentage alone when the entry carries no parentId key", () => {
        const parent = create();
        const child = create(parent.id);

        localUpdateDraftPositions({
            positions: [],
            groups: [{ id: child.id, positionX: 5, positionY: 6 }]
        });

        const stored = (getLocalCanvas()?.groups ?? []).find((g) => g.id === child.id);
        expect(stored?.parent_group_id).toBe(parent.id);
        expect(stored?.positionX).toBe(5);
    });
});

describe("localDeleteDraft, against the server's route", () => {
    const card = (name: string) =>
        localNewDraft({ name, picks: Array(20).fill(""), positionX: 0, positionY: 0 });

    it("trims a multi-endpoint connection instead of deleting it", () => {
        const source = card("source");
        const doomed = card("doomed");
        const survivor = card("survivor");
        localCreateConnection({
            sourceDraftIds: [{ draftId: source.draft_id }],
            targetDraftIds: [{ draftId: doomed.draft_id }, { draftId: survivor.draft_id }]
        });

        localDeleteDraft(doomed.draft_id);

        const connections = getLocalCanvas()?.connections ?? [];
        expect(connections).toHaveLength(1);
        expect(connections[0].target_draft_ids).toHaveLength(1);
        expect(connections[0].target_draft_ids[0]).toMatchObject({
            draft_id: survivor.draft_id
        });
    });

    it("still destroys a connection whose side the delete empties", () => {
        const source = card("source");
        const doomed = card("doomed");
        localCreateConnection({
            sourceDraftIds: [{ draftId: source.draft_id }],
            targetDraftIds: [{ draftId: doomed.draft_id }]
        });

        localDeleteDraft(doomed.draft_id);

        expect(getLocalCanvas()?.connections ?? []).toHaveLength(0);
    });
});

describe("localDeleteAnnotation, against the server's route", () => {
    const card = () =>
        localNewDraft({
            name: "source",
            picks: Array(20).fill(""),
            positionX: 0,
            positionY: 0
        });

    const annotation = () =>
        localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        }).annotation;

    it("trims a deleted annotation endpoint from a multi-endpoint side", () => {
        const source = card();
        const doomed = annotation();
        const survivor = annotation();
        const canvas = getLocalCanvas();
        if (!canvas) throw new Error("Expected local canvas");
        canvas.connections.push({
            id: "connection-1",
            canvas_id: "local",
            source_draft_ids: [{ draft_id: source.draft_id, anchor_type: "bottom" }],
            target_draft_ids: [
                {
                    type: "annotation",
                    annotation_id: doomed.id,
                    anchor_type: "top"
                },
                {
                    type: "annotation",
                    annotation_id: survivor.id,
                    anchor_type: "top"
                }
            ],
            vertices: [],
            style: "solid"
        });
        saveLocalCanvas(canvas);

        localDeleteAnnotation(doomed.id);

        const connections = getLocalCanvas()?.connections ?? [];
        expect(connections).toHaveLength(1);
        expect(connections[0].target_draft_ids).toEqual([
            {
                type: "annotation",
                annotation_id: survivor.id,
                anchor_type: "top"
            }
        ]);
    });

    it("destroys a connection when deleting the annotation empties one side", () => {
        const source = card();
        const doomed = annotation();
        const canvas = getLocalCanvas();
        if (!canvas) throw new Error("Expected local canvas");
        canvas.connections.push({
            id: "connection-1",
            canvas_id: "local",
            source_draft_ids: [{ draft_id: source.draft_id, anchor_type: "bottom" }],
            target_draft_ids: [
                {
                    type: "annotation",
                    annotation_id: doomed.id,
                    anchor_type: "top"
                }
            ],
            vertices: [],
            style: "solid"
        });
        saveLocalCanvas(canvas);

        localDeleteAnnotation(doomed.id);

        expect(getLocalCanvas()?.connections ?? []).toHaveLength(0);
    });
});

describe("local annotation connection endpoint formatting", () => {
    it("creates an annotation endpoint with its discriminator", () => {
        const annotation = localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        }).annotation;
        const card = localNewDraft({
            name: "target",
            picks: Array(20).fill(""),
            positionX: 0,
            positionY: 0
        });

        const { connection } = localCreateConnection({
            sourceDraftIds: [{ annotationId: annotation.id, anchorType: "right" }],
            targetDraftIds: [{ draftId: card.draft_id, anchorType: "left" }]
        });

        expect(connection.source_draft_ids).toEqual([
            {
                type: "annotation",
                annotation_id: annotation.id,
                anchor_type: "right"
            }
        ]);
    });

    it("adds an annotation endpoint with its discriminator", () => {
        const first = localNewDraft({
            name: "source",
            picks: Array(20).fill(""),
            positionX: 0,
            positionY: 0
        });
        const target = localNewDraft({
            name: "target",
            picks: Array(20).fill(""),
            positionX: 0,
            positionY: 0
        });
        const annotation = localCreateAnnotation({
            positionX: 10,
            positionY: 20,
            width: 380,
            height: 120,
            group_id: null
        }).annotation;
        const { connection } = localCreateConnection({
            sourceDraftIds: [{ draftId: first.draft_id }],
            targetDraftIds: [{ draftId: target.draft_id }]
        });

        localUpdateConnection({
            connectionId: connection.id,
            addSource: { annotationId: annotation.id, anchorType: "left" }
        });

        expect(getLocalCanvas()?.connections[0].source_draft_ids[1]).toEqual({
            type: "annotation",
            annotation_id: annotation.id,
            anchor_type: "left"
        });
    });
});

/**
 * Deleting a container is where the local runtime has drifted furthest from
 * `canvas.js`'s route: it wrote no position for the Cards it ungrouped, and it
 * cleaned up only the connections anchored to the Group itself. Both are
 * server/local divergences with local on the wrong side.
 */
describe("localDeleteGroup, against the server's route", () => {
    const groupAt = (positionX: number, positionY: number) =>
        localCreateGroup({ positionX, positionY }).group;

    const cardIn = (groupId: string | null, positionX: number, positionY: number) =>
        localNewDraft({
            name: "Card",
            picks: Array(20).fill(""),
            positionX,
            positionY,
            group_id: groupId
        });

    it("rebases a kept Card to world coordinates when it is ungrouped", () => {
        const group = groupAt(100, 200);
        const card = cardIn(group.id, 30, 40);

        localDeleteGroup(group.id, true);

        const stored = (getLocalCanvas()?.drafts ?? []).find(
            (d) => d.draft_id === card.draft_id
        );
        expect(stored?.group_id ?? null).toBe(null);
        // canvas.js:2038 — group.position + card.position, not the bare
        // container-relative pair, which would land the Card near the origin.
        expect(stored?.positionX).toBe(130);
        expect(stored?.positionY).toBe(240);
    });

    it("rebases a kept annotation to world coordinates when it is ungrouped", () => {
        const group = groupAt(100, 200);
        const annotation = localCreateAnnotation({
            positionX: 30,
            positionY: 40,
            width: 380,
            height: 120,
            group_id: group.id
        }).annotation;

        localDeleteGroup(group.id, true);

        const stored = getLocalCanvas()?.annotations.find(
            (entry) => entry.id === annotation.id
        );
        expect(stored).toMatchObject({
            group_id: null,
            positionX: 130,
            positionY: 240
        });
    });

    it("destroys annotations with a zero-Card Group", () => {
        const group = groupAt(100, 200);
        localCreateAnnotation({
            positionX: 30,
            positionY: 40,
            width: 380,
            height: 120,
            group_id: group.id
        });

        localDeleteGroup(group.id, false);

        expect(getLocalCanvas()?.annotations).toEqual([]);
    });

    it("drops an endpoint whose annotation is deleted with the container", () => {
        const group = groupAt(100, 200);
        const inside = localCreateAnnotation({
            positionX: 30,
            positionY: 40,
            width: 380,
            height: 120,
            group_id: group.id
        }).annotation;
        const outside = cardIn(null, 500, 500);
        const canvas = getLocalCanvas();
        if (!canvas) throw new Error("Expected local canvas");
        canvas.connections.push({
            id: "connection-1",
            canvas_id: "local",
            source_draft_ids: [{ draft_id: outside.draft_id, anchor_type: "bottom" }],
            target_draft_ids: [
                {
                    type: "annotation",
                    annotation_id: inside.id,
                    anchor_type: "top"
                }
            ],
            vertices: [],
            style: "solid"
        });
        saveLocalCanvas(canvas);

        localDeleteGroup(group.id, false);

        expect(getLocalCanvas()?.connections ?? []).toHaveLength(0);
    });

    it("leaves a Card outside the deleted container untouched", () => {
        const group = groupAt(100, 200);
        const outside = cardIn(null, 7, 9);

        localDeleteGroup(group.id, true);

        const stored = (getLocalCanvas()?.drafts ?? []).find(
            (d) => d.draft_id === outside.draft_id
        );
        expect(stored?.positionX).toBe(7);
        expect(stored?.positionY).toBe(9);
    });

    it("drops a connection whose endpoint was a Card deleted with the container", () => {
        const group = groupAt(100, 200);
        const inside = cardIn(group.id, 10, 10);
        const outside = cardIn(null, 500, 500);
        localCreateConnection({
            sourceDraftIds: [{ draftId: outside.draft_id }],
            targetDraftIds: [{ draftId: inside.draft_id }]
        });

        localDeleteGroup(group.id, false);

        expect(getLocalCanvas()?.connections ?? []).toHaveLength(0);
    });

    it("trims a multi-endpoint connection instead of deleting it", () => {
        const group = groupAt(100, 200);
        const inside = cardIn(group.id, 10, 10);
        const survivor = cardIn(null, 500, 500);
        const source = cardIn(null, 0, 0);
        localCreateConnection({
            sourceDraftIds: [{ draftId: source.draft_id }],
            targetDraftIds: [{ draftId: inside.draft_id }, { draftId: survivor.draft_id }]
        });

        localDeleteGroup(group.id, false);

        // The server trims the endpoint and keeps the connection
        // (canvas.js:1249) — only an empty SIDE destroys it.
        const connections = getLocalCanvas()?.connections ?? [];
        expect(connections).toHaveLength(1);
        expect(connections[0].target_draft_ids).toHaveLength(1);
        expect(connections[0].target_draft_ids[0]).toMatchObject({
            draft_id: survivor.draft_id
        });
    });

    it("still drops endpoints anchored to the Group itself", () => {
        const group = groupAt(100, 200);
        const outside = cardIn(null, 500, 500);
        localCreateConnection({
            sourceDraftIds: [{ draftId: outside.draft_id }],
            targetDraftIds: [{ groupId: group.id }]
        });

        localDeleteGroup(group.id, true);

        expect(getLocalCanvas()?.connections ?? []).toHaveLength(0);
    });
});

/**
 * The local twin of the create route's `metadata` (design §10, 5c). Without
 * these, a Group created on a local canvas is born `free` while a server one is
 * born `grid`, and the divergence only surfaces at sign-up.
 */
describe("localCreateGroup metadata and name", () => {
    it("is born with the metadata the creation dialog decided", () => {
        const { group } = localCreateGroup({
            positionX: 0,
            positionY: 0,
            metadata: {
                layout: "grid",
                gridCols: 4,
                colLabels: ["A"],
                draftMode: "fearless"
            }
        });

        expect(group.metadata.layout).toBe("grid");
        expect(group.metadata.gridCols).toBe(4);
        expect(group.metadata.colLabels).toEqual(["A"]);
        expect(group.metadata.draftMode).toBe("fearless");
        // And it survives the round trip through localStorage.
        const stored = (getLocalCanvas()?.groups ?? []).find((g) => g.id === group.id);
        expect(stored?.metadata.gridCols).toBe(4);
    });

    it("stores no metadata key when none is supplied", () => {
        const { group } = localCreateGroup({ positionX: 0, positionY: 0 });
        expect(group.metadata).toEqual({});
    });

    it("deletes a null gameType rather than storing one (D3)", () => {
        const { group } = localCreateGroup({
            positionX: 0,
            positionY: 0,
            metadata: { layout: "grid", gameType: null }
        });
        expect(Object.prototype.hasOwnProperty.call(group.metadata, "gameType")).toBe(
            false
        );
    });

    it("takes the supplied name, and auto-numbers only without one", () => {
        expect(localCreateGroup({ positionX: 0, positionY: 0 }).group.name).toBe(
            "New Group"
        );
        expect(localCreateGroup({ positionX: 0, positionY: 0 }).group.name).toBe(
            "New Group 1"
        );
        expect(
            localCreateGroup({ positionX: 0, positionY: 0, name: "Scrim block" }).group
                .name
        ).toBe("Scrim block");
        // A duplicate explicit name is the user's call, not something to
        // silently renumber behind their back.
        expect(
            localCreateGroup({ positionX: 0, positionY: 0, name: "Scrim block" }).group
                .name
        ).toBe("Scrim block");
    });
});

/**
 * `draftMode` joined `gameType` as a clearable key when the settings dialog
 * stopped offering draft mode for custom groups. A custom group that already
 * stored `fearless` restricts champions across its drafts (draftRestrictions'
 * SYMMETRIC branch), so it has to be able to stop.
 */
describe("localUpdateGroup clear protocol", () => {
    it("deletes a stored draftMode on an explicit null", () => {
        const { group } = localCreateGroup({
            positionX: 0,
            positionY: 0,
            metadata: { layout: "grid", draftMode: "fearless" }
        });

        localUpdateGroup({ groupId: group.id, metadata: { draftMode: null } });

        const stored = (getLocalCanvas()?.groups ?? []).find((g) => g.id === group.id);
        expect(
            Object.prototype.hasOwnProperty.call(stored?.metadata ?? {}, "draftMode")
        ).toBe(false);
        expect(stored?.metadata.layout).toBe("grid");
    });

    it("leaves a stored draftMode alone when the update omits the key", () => {
        const { group } = localCreateGroup({
            positionX: 0,
            positionY: 0,
            metadata: { draftMode: "fearless" }
        });

        localUpdateGroup({ groupId: group.id, metadata: { gridCols: 4 } });

        const stored = (getLocalCanvas()?.groups ?? []).find((g) => g.id === group.id);
        expect(stored?.metadata.draftMode).toBe("fearless");
    });
});
