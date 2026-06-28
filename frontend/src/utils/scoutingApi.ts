import {
  ChampionStatsEnvelopeSchema,
  type ChampionStatsEnvelope,
} from "@draft-sim/shared-types";
import { apiPost } from "./apiClient";

export interface ScoutInput {
  region: string;
  gameName: string;
  tagLine: string;
}

// POST /api/scouting/player — apiPost validates the response against the Zod
// envelope schema, so a drifted u.gg shape surfaces as a ValidationError.
export function scoutPlayer(input: ScoutInput): Promise<ChampionStatsEnvelope> {
  return apiPost("/scouting/player", input, ChampionStatsEnvelopeSchema);
}
