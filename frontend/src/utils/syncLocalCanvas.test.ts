import { describe, expect, it } from "vitest";
import { stripUnsyncableGroupMetadata } from "./syncLocalCanvas";

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

        expect(Object.prototype.hasOwnProperty.call(stripped, "gameType")).toBe(
            false
        );
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
        expect(Object.keys(stripUnsyncableGroupMetadata({ gameType: "official" })))
            .toHaveLength(0);
    });
});
