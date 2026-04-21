export interface TurnInfo {
    side: "blue" | "red";
    type: "ban" | "pick";
    phase: "ban1" | "pick1" | "ban2" | "pick2";
    pairStart: boolean;
    pairEnd: boolean;
}

export const TURN_SEQUENCE: TurnInfo[] = [
    { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
    { side: "red", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
    { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
    { side: "red", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
    { side: "blue", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
    { side: "red", type: "ban", phase: "ban1", pairStart: false, pairEnd: false },
    { side: "blue", type: "pick", phase: "pick1", pairStart: false, pairEnd: false },
    { side: "red", type: "pick", phase: "pick1", pairStart: true, pairEnd: false },
    { side: "red", type: "pick", phase: "pick1", pairStart: false, pairEnd: true },
    { side: "blue", type: "pick", phase: "pick1", pairStart: true, pairEnd: false },
    { side: "blue", type: "pick", phase: "pick1", pairStart: false, pairEnd: true },
    { side: "red", type: "pick", phase: "pick1", pairStart: false, pairEnd: false },
    { side: "red", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
    { side: "blue", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
    { side: "red", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
    { side: "blue", type: "ban", phase: "ban2", pairStart: false, pairEnd: false },
    { side: "red", type: "pick", phase: "pick2", pairStart: false, pairEnd: false },
    { side: "blue", type: "pick", phase: "pick2", pairStart: true, pairEnd: false },
    { side: "blue", type: "pick", phase: "pick2", pairStart: false, pairEnd: true },
    { side: "red", type: "pick", phase: "pick2", pairStart: false, pairEnd: false }
];

export function isPairStartSlot(slot: number): boolean {
    return TURN_SEQUENCE[slot]?.pairStart === true;
}

export function isPairEndSlot(slot: number): boolean {
    return TURN_SEQUENCE[slot]?.pairEnd === true;
}

export function getPairPartnerSlot(slot: number): number | null {
    const turn = TURN_SEQUENCE[slot];
    if (!turn) return null;
    if (turn.pairStart) return slot + 1;
    if (turn.pairEnd) return slot - 1;
    return null;
}

export function phaseForSlot(slot: number): "ban1" | "pick1" | "ban2" | "pick2" {
    const turn = TURN_SEQUENCE[slot];
    if (!turn) {
        throw new Error(`phaseForSlot: invalid slot ${slot}`);
    }
    return turn.phase;
}
