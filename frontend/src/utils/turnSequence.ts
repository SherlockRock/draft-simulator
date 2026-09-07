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

export const PHASE_LABELS: Record<TurnInfo["phase"], string> = {
    ban1: "Ban Phase 1",
    pick1: "Pick Phase 1",
    ban2: "Ban Phase 2",
    pick2: "Pick Phase 2"
};

/** "Blue Pick 4": the ordinal counts turns of the same (side, type) up to and
 *  including `slot`. Slots past the sequence read "Draft complete". */
export function turnLabel(slot: number): string {
    const turn = TURN_SEQUENCE[slot];
    if (!turn) return "Draft complete";
    let ordinal = 0;
    for (let i = 0; i <= slot; i++) {
        const t = TURN_SEQUENCE[i];
        if (t.side === turn.side && t.type === turn.type) ordinal += 1;
    }
    const side = turn.side === "blue" ? "Blue" : "Red";
    return `${side} ${turn.type === "ban" ? "Ban" : "Pick"} ${ordinal}`;
}

/** Pair nodes span two slots: "Blue Pick 4 + Blue Pick 5". */
export function turnLabelForSlots(slots: readonly number[]): string {
    return slots.map(turnLabel).join(" + ");
}
