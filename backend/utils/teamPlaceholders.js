// The "Team 1" / "Team 2" seeds the series dialog and the VersusDraft column
// defaults put in a name field. Same rule as the frontend's
// isPlaceholderTeamName (frontend/src/utils/teamLink.ts): trimmed,
// case-insensitive, exactly "team 1" or "team 2".
const PLACEHOLDER_NAMES = new Set(["team 1", "team 2"]);

const TEAM_NAME_KEYS = ["blueTeamName", "redTeamName"];

function isPlaceholderTeamName(name) {
  return (
    typeof name === "string" &&
    PLACEHOLDER_NAMES.has(name.trim().toLowerCase())
  );
}

// A name worth storing: a non-blank string that is not a placeholder.
function isStorableTeamName(name) {
  return typeof name === "string" && name.trim() !== "" && !isPlaceholderTeamName(name);
}

// A copy of a CanvasGroup metadata object with blueTeamName / redTeamName
// absent unless they are a real name. Absent, not null: the same shape the
// clear protocol (mergeGroupMetadata) leaves. Other keys are untouched.
function withoutPlaceholderTeamNames(metadata) {
  const copy = { ...(metadata || {}) };
  for (const key of TEAM_NAME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(copy, key) && !isStorableTeamName(copy[key])) {
      delete copy[key];
    }
  }
  return copy;
}

module.exports = {
  PLACEHOLDER_NAMES,
  isPlaceholderTeamName,
  withoutPlaceholderTeamNames,
};
