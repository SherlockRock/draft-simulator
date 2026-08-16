import { describe, expect, it } from "vitest";
import type { CanvasDraft } from "./schemas";
import type { DraftMatch } from "./canvasSearch";
import { buildSearchRowModel } from "./searchRowModel";

const makeDraft = (id: string, picks: string[]): CanvasDraft => ({
    draft_id: id,
    positionX: 0,
    positionY: 0,
    group_id: null,
    Draft: { id, name: `label-${id}`, type: "canvas", picks }
});

const fullPicks = (): string[] => Array.from({ length: 20 }, (_, i) => `Filler${i}`);

const match = (draftId: string, overrides: Partial<DraftMatch> = {}): DraftMatch => ({
    draftId,
    groupId: null,
    teamSide: "blue",
    slots: [
        { index: 2, phase: "ban", side: "blue", bucket: "bannedBy" },
        { index: 11, phase: "pick", side: "blue", bucket: "pickedBy" }
    ],
    inProgress: false,
    outcome: "win",
    ...overrides
});

describe("buildSearchRowModel", () => {
    it("maps matched slots to index -> phase and carries outcome/teamSide", () => {
        const row = buildSearchRowModel(makeDraft("d1", fullPicks()), undefined, match("d1"));
        expect(row.matchedSlots).toEqual({ 2: "ban", 11: "pick" });
        expect(row.outcome).toBe("win");
        expect(row.teamSide).toBe("blue");
        expect(row.label).toBe("label-d1");
    });

    it("resolves display names side-aware via blueSideTeam (two-tier model, R3 edge)", () => {
        const cd: CanvasDraft = {
            ...makeDraft("d2", fullPicks()),
            team1Name: "TSM",
            team2Name: "C9"
        };
        cd.Draft.blueSideTeam = 2;
        const row = buildSearchRowModel(cd, undefined, match("d2"));
        expect(row.leftTeam).toBe("C9");
        expect(row.rightTeam).toBe("TSM");
    });

    it("a pinned row the query does not match shows the bare draft (R6)", () => {
        const row = buildSearchRowModel(makeDraft("d3", fullPicks()), undefined, null);
        expect(row.matchedSlots).toEqual({});
        expect(row.outcome).toBeNull();
        expect(row.teamSide).toBeNull();
        expect(row.inProgress).toBe(false);
    });

    it("copies the draft's own picks", () => {
        const picks = fullPicks();
        picks[10] = "Jinx";
        const row = buildSearchRowModel(makeDraft("d4", picks), undefined, null);
        expect(row.picks).toEqual(picks);
        expect(row.picks).not.toBe(picks);
    });

    it("date precedence: Draft.createdAt wins over the card's createdAt", () => {
        const cd: CanvasDraft = {
            ...makeDraft("d5", fullPicks()),
            createdAt: "2026-08-02T00:00:00Z"
        };
        cd.Draft.createdAt = "2026-08-01T00:00:00Z";
        expect(buildSearchRowModel(cd, undefined, null).date).toBe("2026-08-01T00:00:00Z");
        const cardOnly: CanvasDraft = {
            ...makeDraft("d6", fullPicks()),
            createdAt: "2026-08-02T00:00:00Z"
        };
        expect(buildSearchRowModel(cardOnly, undefined, null).date).toBe(
            "2026-08-02T00:00:00Z"
        );
        expect(buildSearchRowModel(makeDraft("d7", fullPicks()), undefined, null).date)
            .toBeNull();
    });

    it("bare pins respect the versus completed flag for inProgress", () => {
        const emptyPicks = Array.from({ length: 20 }, () => "");
        const done = makeDraft("d8", emptyPicks);
        done.Draft.completed = true;
        // completed overrides empty pick slots (isDraftInProgress semantics)
        expect(buildSearchRowModel(done, undefined, null).inProgress).toBe(false);
        const manual = makeDraft("d9", emptyPicks);
        expect(buildSearchRowModel(manual, undefined, null).inProgress).toBe(true);
    });
});
