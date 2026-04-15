import type { Phase, Side, PhaseWeights } from "./types.js";

const BLUE_WEIGHTS: Record<Phase, PhaseWeights> = {
  ban1:  { compStrength: 0.35, informationValue: 0.65 },
  pick1: { compStrength: 0.5,  informationValue: 0.5  },
  ban2:  { compStrength: 0.6,  informationValue: 0.4  },
  pick2: { compStrength: 0.8,  informationValue: 0.2  },
};

const RED_WEIGHTS: Record<Phase, PhaseWeights> = {
  ban1:  { compStrength: 0.3,  informationValue: 0.7  },
  pick1: { compStrength: 0.4,  informationValue: 0.6  },
  ban2:  { compStrength: 0.5,  informationValue: 0.5  },
  pick2: { compStrength: 0.8,  informationValue: 0.2  },
};

export function getPhaseWeights(phase: Phase, side: Side): PhaseWeights {
  return side === "blue" ? BLUE_WEIGHTS[phase] : RED_WEIGHTS[phase];
}
