import { VersusPickOrderItem } from "./types";

// Versus draft pick order matching the backend
export const VERSUS_PICK_ORDER: VersusPickOrderItem[] = [
    // Phase 1: Blue ban, Red ban (3 each, alternating)
    { team: "blue", type: "ban", slot: 0 },
    { team: "red", type: "ban", slot: 0 },
    { team: "blue", type: "ban", slot: 1 },
    { team: "red", type: "ban", slot: 1 },
    { team: "blue", type: "ban", slot: 2 },
    { team: "red", type: "ban", slot: 2 },

    // Phase 2: Blue pick, Red pick (3 each, alternating - red double pick)
    { team: "blue", type: "pick", slot: 0 },
    { team: "red", type: "pick", slot: 0 },
    { team: "red", type: "pick", slot: 1 },
    { team: "blue", type: "pick", slot: 1 },
    { team: "blue", type: "pick", slot: 2 },
    { team: "red", type: "pick", slot: 2 },

    // Phase 3: Red ban, Blue ban (2 each, alternating)
    { team: "red", type: "ban", slot: 3 },
    { team: "blue", type: "ban", slot: 3 },
    { team: "red", type: "ban", slot: 4 },
    { team: "blue", type: "ban", slot: 4 },

    // Phase 4: Red pick, Blue pick (2 each, alternating - red double pick)
    { team: "red", type: "pick", slot: 3 },
    { team: "blue", type: "pick", slot: 3 },
    { team: "blue", type: "pick", slot: 4 },
    { team: "red", type: "pick", slot: 4 }
];

export function getEffectivePickOrder(
    firstPick: "blue" | "red" = "blue"
): VersusPickOrderItem[] {
    if (firstPick === "blue") return VERSUS_PICK_ORDER;
    return VERSUS_PICK_ORDER.map((item) => ({
        ...item,
        team: item.team === "blue" ? "red" : "blue",
    }));
}

export function getPicksArrayIndex(
    currentPickIndex: number,
    firstPick: "blue" | "red" = "blue"
): number {
    const effectiveOrder = getEffectivePickOrder(firstPick);
    const currentPick = effectiveOrder[currentPickIndex];
    const { team, type, slot } = currentPick;

    let picksIndex: number;

    if (type === "ban") {
        picksIndex = team === "blue" ? slot : slot + 5;
    } else {
        picksIndex = team === "blue" ? slot + 10 : slot + 15;
    }

    return picksIndex;
}
