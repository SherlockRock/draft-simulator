import type { NavigatorEventData } from "../contexts/NavigatorContext";

export interface EventTuple {
    event_type: "pick" | "ban";
    champion_id: string;
    slot: number;
}

function toTuple(event: NavigatorEventData): EventTuple | null {
    if (event.event_type !== "pick" && event.event_type !== "ban") {
        return null;
    }
    return {
        event_type: event.event_type,
        champion_id: event.champion_id,
        slot: event.slot
    };
}

function hashTuples(tuples: EventTuple[]): string {
    return tuples
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((t) => `${t.event_type}:${t.champion_id}:${t.slot}`)
        .join("|");
}

export function hashNavigatorEvents(events: NavigatorEventData[]): string {
    const tuples: EventTuple[] = [];
    for (const event of events) {
        const tuple = toTuple(event);
        if (tuple) tuples.push(tuple);
    }
    return hashTuples(tuples);
}

export function hashAfterAppend(
    events: NavigatorEventData[],
    next: EventTuple
): string {
    const tuples: EventTuple[] = [];
    for (const event of events) {
        const tuple = toTuple(event);
        if (tuple) tuples.push(tuple);
    }
    tuples.push(next);
    return hashTuples(tuples);
}

export function hashAfterPop(events: NavigatorEventData[]): string {
    const tuples: EventTuple[] = [];
    for (const event of events) {
        const tuple = toTuple(event);
        if (tuple) tuples.push(tuple);
    }
    tuples.pop();
    return hashTuples(tuples);
}

export function makeCacheKey(configVersion: number, eventsHash: string): string {
    return `${configVersion}:${eventsHash}`;
}
