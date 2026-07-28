import { getGroupRestrictedChampions, parseDraftMode } from "./groupRestrictions";
import { getRestrictedChampions } from "./seriesRestrictions";

/**
 * Resolve restricted champions for a draft inside a canvas group, dispatching
 * to the correct restriction model based on the group type.
 *
 * This mirrors the backend's utils/draftRestrictions.js. It exists because the
 * two frontend surfaces had drifted: DraftDetailView handled both group types,
 * while Canvas.tsx returned [] for anything that wasn't "custom" — which is
 * every series group, so fearless silently greyed out nothing on the canvas
 * while the backend gate still rejected the pick. Route both surfaces through
 * here so they cannot disagree again.
 *
 * - Series groups are ORDERED: only games with a lower seriesIndex restrict the
 *   current game, so editing an earlier game is never blocked by a later one.
 * - Custom groups are SYMMETRIC: any champion used in any other draft counts.
 */
export interface RestrictionGroup {
    type: string;
    metadata: {
        seriesType?: string;
        draftMode?: string;
    };
}

export interface RestrictionDraft {
    id: string;
    name: string;
    picks: string[];
    seriesIndex?: number | null;
}

/**
 * The mode a group's restrictions run in, or undefined when it has none.
 *
 * Series groups carry it in `seriesType`; custom groups in `draftMode`. The
 * fallback matches the backend gate (canvasMutations.js), which reads
 * `metadata.seriesType || metadata.draftMode` — the two must agree, or the UI
 * greys out picks the server accepts.
 */
export function resolveGroupMode(group: RestrictionGroup) {
    return group.type === "series"
        ? parseDraftMode(group.metadata.seriesType ?? group.metadata.draftMode)
        : parseDraftMode(group.metadata.draftMode);
}

export function getRestrictedChampionsForGroup({
    group,
    drafts,
    currentDraftId
}: {
    group: RestrictionGroup;
    drafts: RestrictionDraft[];
    currentDraftId: string;
}): string[] {
    const mode = resolveGroupMode(group);
    if (!mode || mode === "standard") return [];

    if (group.type === "series") {
        // Matching the backend's `?? 0` here is deliberate. A miss means we
        // cannot order the games, and diverging from the enforcing layer is
        // what produced this bug in the first place.
        const currentSeriesIndex =
            drafts.find((d) => d.id === currentDraftId)?.seriesIndex ?? 0;
        return getRestrictedChampions(mode, drafts, currentSeriesIndex);
    }

    return getGroupRestrictedChampions(mode, drafts, currentDraftId);
}
