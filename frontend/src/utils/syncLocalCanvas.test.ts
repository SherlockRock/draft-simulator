import { describe, expect, it } from "vitest";
import { nestedGroupSyncEntries, stripUnsyncableGroupMetadata } from "./syncLocalCanvas";
import type { CanvasGroup } from "./schemas";

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
