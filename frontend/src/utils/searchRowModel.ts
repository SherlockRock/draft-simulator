import type { CanvasDraft, CanvasGroup } from "./schemas";
import {
    isDraftInProgress,
    type DraftMatch,
    type MatchOutcome,
    type SlotPhase,
    type SlotSide
} from "./canvasSearch";
import { resolveTeamNames } from "./teamNames";

/**
 * Everything one result row renders (design decision 4: the complete draft —
 * all 20 slots, picks and bans, plus teams, W/L + side, label, date). Plain
 * serializable data so the panel's store can reconcile it keyed by draftId.
 */
export type SearchRowModel = {
    draftId: string;
    /** Raw pick values in picks[] layout; the row resolves them via resolveChampion. */
    picks: string[];
    /** Matched slot index -> phase from the CURRENT query; {} for pinned rows it doesn't match. */
    matchedSlots: Record<number, SlotPhase>;
    leftTeam: string | null;
    rightTeam: string | null;
    label: string;
    /** ISO date string or null; Draft.createdAt wins over the card's. */
    date: string | null;
    outcome: MatchOutcome | null;
    /** Side the searched team played (R2's side marker); null without a team filter. */
    teamSide: SlotSide | null;
    inProgress: boolean;
};

export const buildSearchRowModel = (
    canvasDraft: CanvasDraft,
    group: CanvasGroup | undefined,
    match: DraftMatch | null
): SearchRowModel => {
    const names = resolveTeamNames(canvasDraft, group);
    const matchedSlots: Record<number, SlotPhase> = {};
    for (const slot of match?.slots ?? []) matchedSlots[slot.index] = slot.phase;
    return {
        draftId: canvasDraft.Draft.id,
        picks: [...canvasDraft.Draft.picks],
        matchedSlots,
        leftTeam: names.left ?? null,
        rightTeam: names.right ?? null,
        label: canvasDraft.Draft.name,
        date: canvasDraft.Draft.createdAt ?? canvasDraft.createdAt ?? null,
        outcome: match?.outcome ?? null,
        teamSide: match?.teamSide ?? null,
        inProgress: match?.inProgress ?? isDraftInProgress(canvasDraft)
    };
};
