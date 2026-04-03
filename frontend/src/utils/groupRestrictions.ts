import { DraftModeSchema, type DraftMode } from "@draft-sim/shared-types";

interface DraftWithPicks {
    id: string;
    name: string;
    picks: string[];
}

export function parseDraftMode(value?: string): DraftMode | undefined {
    const result = DraftModeSchema.safeParse(value);
    return result.success ? result.data : undefined;
}

/**
 * Get champions restricted from selection based on group draft mode
 * and picks across all other drafts in the group.
 *
 * Unlike series restrictions (which use ordering), group restrictions
 * are symmetric — any champion used in any other draft in the group
 * is restricted in the current draft.
 *
 * Picks array layout:
 * - Indices 0-4: Blue bans
 * - Indices 5-9: Red bans
 * - Indices 10-14: Blue picks
 * - Indices 15-19: Red picks
 */
export function getGroupRestrictedChampions(
    draftMode: DraftMode | undefined,
    drafts: DraftWithPicks[],
    currentDraftId: string
): string[] {
    if (draftMode === "standard" || !draftMode) {
        return [];
    }

    const restricted: string[] = [];

    for (const draft of drafts) {
        if (draft.id === currentDraftId) continue;

        const picks = draft.picks || [];

        if (draftMode === "fearless") {
            for (let i = 10; i < 20; i++) {
                if (picks[i] && picks[i] !== "") {
                    restricted.push(picks[i]);
                }
            }
        } else if (draftMode === "ironman") {
            for (let i = 0; i < 20; i++) {
                if (picks[i] && picks[i] !== "") {
                    restricted.push(picks[i]);
                }
            }
        }
    }

    return [...new Set(restricted)];
}

/**
 * Get restricted champions organized by source draft for display purposes.
 */
export interface DraftRestrictions {
    draftName: string;
    blueBans: string[];
    redBans: string[];
    bluePicks: string[];
    redPicks: string[];
}

export function getGroupRestrictedChampionsByDraft(
    draftMode: DraftMode | undefined,
    drafts: DraftWithPicks[],
    currentDraftId: string
): DraftRestrictions[] {
    if (draftMode === "standard" || !draftMode) {
        return [];
    }

    const result: DraftRestrictions[] = [];

    for (const draft of drafts) {
        if (draft.id === currentDraftId) continue;

        const picks = draft.picks || [];

        const draftRestrictions: DraftRestrictions = {
            draftName: draft.name,
            blueBans: [],
            redBans: [],
            bluePicks: [],
            redPicks: []
        };

        // Always include picks
        for (let i = 10; i < 15; i++) {
            draftRestrictions.bluePicks.push(picks[i] || "");
        }
        for (let i = 15; i < 20; i++) {
            draftRestrictions.redPicks.push(picks[i] || "");
        }

        // Fearless only restricts picks, so ban arrays intentionally remain empty.
        // Include bans only for ironman
        if (draftMode === "ironman") {
            for (let i = 0; i < 5; i++) {
                draftRestrictions.blueBans.push(picks[i] || "");
            }
            for (let i = 5; i < 10; i++) {
                draftRestrictions.redBans.push(picks[i] || "");
            }
        }

        result.push(draftRestrictions);
    }

    return result;
}
