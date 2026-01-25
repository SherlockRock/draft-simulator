import { draft } from "./types";

/**
 * Get champions restricted from selection based on series type and previous games.
 *
 * Picks array layout:
 * - Indices 0-4: Blue bans
 * - Indices 5-9: Red bans
 * - Indices 10-14: Blue picks
 * - Indices 15-19: Red picks
 *
 * @param seriesType - 'standard', 'fearless', or 'ironman'
 * @param drafts - Array of draft objects with picks arrays
 * @param currentSeriesIndex - The seriesIndex of the current game
 * @returns Array of champion IDs that are restricted
 */
export function getRestrictedChampions(
    seriesType: string,
    drafts: draft[],
    currentSeriesIndex: number
): string[] {
    if (seriesType === "standard") {
        return [];
    }

    const restricted: string[] = [];

    for (const draft of drafts) {
        if ((draft.seriesIndex ?? 0) >= currentSeriesIndex) continue;

        const picks = draft.picks || [];

        if (seriesType === "fearless") {
            // Picks only: indices 10-19
            for (let i = 10; i < 20; i++) {
                if (picks[i] && picks[i] !== "") {
                    restricted.push(picks[i]);
                }
            }
        } else if (seriesType === "ironman") {
            // Picks and bans: indices 0-19
            for (let i = 0; i < 20; i++) {
                if (picks[i] && picks[i] !== "") {
                    restricted.push(picks[i]);
                }
            }
        }
    }

    return [...new Set(restricted)]; // dedupe
}

/**
 * Get restricted champions organized by game for display purposes.
 *
 * @param seriesType - 'standard', 'fearless', or 'ironman'
 * @param drafts - Array of draft objects with picks arrays
 * @param currentSeriesIndex - The seriesIndex of the current game
 * @returns Array of game restriction info objects
 */
export interface GameRestrictions {
    gameNumber: number;
    blueBans: string[];
    redBans: string[];
    bluePicks: string[];
    redPicks: string[];
}

export function getRestrictedChampionsByGame(
    seriesType: string,
    drafts: draft[],
    currentSeriesIndex: number
): GameRestrictions[] {
    if (seriesType === "standard") {
        return [];
    }

    const result: GameRestrictions[] = [];

    for (const draft of drafts) {
        const draftSeriesIndex = draft.seriesIndex ?? 0;
        if (draftSeriesIndex >= currentSeriesIndex) continue;

        const picks = draft.picks || [];

        const gameRestrictions: GameRestrictions = {
            gameNumber: draftSeriesIndex + 1,
            blueBans: [],
            redBans: [],
            bluePicks: [],
            redPicks: []
        };

        // Always include picks
        for (let i = 10; i < 15; i++) {
            gameRestrictions.bluePicks.push(picks[i] || "");
        }
        for (let i = 15; i < 20; i++) {
            gameRestrictions.redPicks.push(picks[i] || "");
        }

        // Include bans only for ironman
        if (seriesType === "ironman") {
            for (let i = 0; i < 5; i++) {
                gameRestrictions.blueBans.push(picks[i] || "");
            }
            for (let i = 5; i < 10; i++) {
                gameRestrictions.redBans.push(picks[i] || "");
            }
        }

        result.push(gameRestrictions);
    }

    return result;
}
