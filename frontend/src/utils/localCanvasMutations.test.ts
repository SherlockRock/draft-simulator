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
const { localNewDraft, localCopyDraft, localCreateGroup, localConvertGroupToSeries } =
    await import("./useLocalCanvasMutations");
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
