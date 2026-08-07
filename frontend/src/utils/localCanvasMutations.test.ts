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

const { getLocalCanvas, saveLocalCanvas, createEmptyLocalCanvas } =
    await import("./localCanvasStore");
const {
    localNewDraft,
    localCopyDraft,
    localCreateGroup,
    localConvertGroupToSeries,
    localDeleteGroup,
    localUpdateDraftPositions
} = await import("./useLocalCanvasMutations");
const { MAX_GROUP_DEPTH } = await import("@draft-sim/shared-types/canvas-tree-vector");
const { SERIES_HEADER_HEIGHT, SERIES_PADDING } = await import("./helpers");

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
        expect(card.positionX).toBe(SERIES_PADDING);
        expect(card.positionY).toBe(SERIES_HEADER_HEIGHT + SERIES_PADDING);
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
            SERIES_PADDING,
            SERIES_PADDING + 380,
            SERIES_PADDING + 760
        ]);
        for (const card of cards) {
            expect(card.positionY).toBe(SERIES_HEADER_HEIGHT + SERIES_PADDING);
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
