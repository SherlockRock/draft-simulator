import type { NavigatorEventData } from "../contexts/NavigatorContext";

export interface DraftStateSummary {
    blueBans: string[];
    redBans: string[];
    bluePicks: string[];
    redPicks: string[];
    turnIndex: number;
}

export function draftEventsToState(events: NavigatorEventData[]): DraftStateSummary {
    const summary: DraftStateSummary = {
        blueBans: [],
        redBans: [],
        bluePicks: [],
        redPicks: [],
        turnIndex: 0
    };

    const ordered = [...events].sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        if (aTime !== bTime) return aTime - bTime;
        return a.slot - b.slot;
    });

    for (const event of ordered) {
        if (event.event_type !== "ban" && event.event_type !== "pick") continue;
        if (event.event_type === "ban") {
            if (event.side === "blue") summary.blueBans.push(event.champion_id);
            else summary.redBans.push(event.champion_id);
        } else {
            if (event.side === "blue") summary.bluePicks.push(event.champion_id);
            else summary.redPicks.push(event.champion_id);
        }
        summary.turnIndex++;
    }

    return summary;
}

export function isChampionAvailable(
    championId: string,
    state: DraftStateSummary
): boolean {
    if (state.blueBans.includes(championId)) return false;
    if (state.redBans.includes(championId)) return false;
    if (state.bluePicks.includes(championId)) return false;
    if (state.redPicks.includes(championId)) return false;
    return true;
}
