import {
    ScoutPlayersResponseSchema,
    type ScoutPlayersResponse
} from "@draft-sim/shared-types";
import { apiPost } from "./apiClient";

export interface ScoutPlayersInput {
    region: string;
    players: { gameName: string; tagLine: string }[];
    /** Bypass the backend's short-TTL envelope cache for this batch. */
    refresh?: boolean;
}

// POST /api/scouting/players — apiPost validates the response against the Zod
// schema, so a drifted u.gg/back-end shape surfaces as a ValidationError.
export function scoutPlayers(input: ScoutPlayersInput): Promise<ScoutPlayersResponse> {
    return apiPost("/scouting/players", input, ScoutPlayersResponseSchema);
}
