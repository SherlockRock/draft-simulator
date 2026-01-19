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

export function getPicksArrayIndex(currentPickIndex: number): number {
    const currentPick = VERSUS_PICK_ORDER[currentPickIndex];
    const { team, type, slot } = currentPick;

    let picksIndex: number;

    if (type === "ban") {
        // Bans: picks[0-9]
        // Blue bans: 0-4, Red bans: 5-9
        picksIndex = team === "blue" ? slot : slot + 5;
    } else {
        // Picks: picks[10-19]
        // Blue picks: 10-14, Red picks: 15-19
        picksIndex = team === "blue" ? slot + 10 : slot + 15;
    }

    return picksIndex;
}
