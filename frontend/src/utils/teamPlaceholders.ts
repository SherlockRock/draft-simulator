import type { CanvasGroupMetadata } from "@draft-sim/shared-types";
import { isPlaceholderTeamName } from "./teamLink";

const isStorableTeamName = (name: string | undefined): boolean =>
    typeof name === "string" && name.trim() !== "" && !isPlaceholderTeamName(name);

// A copy of group metadata with blueTeamName / redTeamName absent unless they
// are a real name (non-blank, not "Team 1" / "Team 2"). Absent, not null: the
// same shape as the server's withoutPlaceholderTeamNames
// (backend/utils/teamPlaceholders.js). Other keys are untouched.
export function withoutPlaceholderTeamNames(
    metadata: CanvasGroupMetadata | undefined
): CanvasGroupMetadata {
    const copy: CanvasGroupMetadata = { ...metadata };
    if ("blueTeamName" in copy && !isStorableTeamName(copy.blueTeamName)) {
        delete copy.blueTeamName;
    }
    if ("redTeamName" in copy && !isStorableTeamName(copy.redTeamName)) {
        delete copy.redTeamName;
    }
    return copy;
}
