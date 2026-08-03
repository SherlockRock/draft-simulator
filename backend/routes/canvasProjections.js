"use strict";

// Single source of truth for the canvas payload shape. Fourteen call sites
// used to re-declare these by hand and two drifted, dropping blueSideTeam so
// every client's series team names reverted to base orientation on any
// non-rename draft edit. Add a field here, not at a call site.
const CANVAS_DRAFT_ATTRIBUTES = [
  "positionX",
  "positionY",
  "is_locked",
  "group_id",
  "source_type",
  "team1Name",
  "team2Name",
];

const DRAFT_ATTRIBUTES = [
  "name",
  "id",
  "picks",
  "type",
  "versus_draft_id",
  "seriesIndex",
  "completed",
  "winner",
  "blueSideTeam",
  "firstPick",
];

module.exports = { CANVAS_DRAFT_ATTRIBUTES, DRAFT_ATTRIBUTES };
