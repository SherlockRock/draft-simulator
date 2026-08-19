"use strict";

const {
  Canvas,
  CanvasDraft,
  CanvasGroup,
  CanvasConnection,
  CanvasAnnotation,
  CanvasPoolPlacement,
} = require("../models/Canvas");
const Draft = require("../models/Draft.js");
const Team = require("../models/Team.js");
const TeamPlayer = require("../models/TeamPlayer.js");
const Pool = require("../models/Pool.js");

// Single source of truth for the canvas payload shape. Fourteen call sites
// used to re-declare these by hand and two drifted, dropping blueSideTeam so
// every client's series team names reverted to base orientation on any
// non-rename draft edit. Add a field here, not at a call site.
const CANVAS_DRAFT_ATTRIBUTES = [
  // The Card's stable wire identity. Clients reconcile canvasDrafts keyed on
  // this; without it the store reconciles positionally, and since this payload
  // has no ORDER BY (Postgres gives no order guarantee on an unordered SELECT,
  // and any drag's UPDATE can relocate a heap row) the wrong Card gets bound to
  // retained DOM — hover, inline edit and open pickers follow array position
  // instead of Draft identity.
  "draft_id",
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

// Eager-load the linked Team entities (with rosters) so serialized groups
// carry the entity name for search resolution and the roster for "Scout this
// team". Moved here from canvas.js: a Group's Team rows are part of the
// payload shape, and the hand-built broadcasts that omitted it stripped
// Team1/Team2 from every client store, which made the Scout button disappear
// until reload.
const TEAM_INCLUDE = [
  {
    model: Team,
    as: "Team1",
    include: [{ model: TeamPlayer, as: "TeamPlayers" }],
  },
  {
    model: Team,
    as: "Team2",
    include: [{ model: TeamPlayer, as: "TeamPlayers" }],
  },
];

/**
 * THE canvas payload. Every `canvasUpdate` broadcast and the REST snapshot
 * come from here — there is no second way to build one.
 *
 * Thirteen call sites used to hand-build this. Two of them had already
 * drifted (dropping `TEAM_INCLUDE`), and a third omission class is worse: a
 * missing `annotations` key is not a partial update, it is an ERASURE,
 * because the client reconciles the array it is handed. Add a field here,
 * not at a call site.
 */
async function buildCanvasSnapshot(canvasId) {
  const [canvas, drafts, connections, groups, annotations, poolPlacements] =
    await Promise.all([
      Canvas.findByPk(canvasId),
      CanvasDraft.findAll({
        where: { canvas_id: canvasId },
        attributes: CANVAS_DRAFT_ATTRIBUTES,
        include: [{ model: Draft, attributes: DRAFT_ATTRIBUTES }],
        raw: true,
        nest: true,
      }),
      CanvasConnection.findAll({ where: { canvas_id: canvasId }, raw: true }),
      CanvasGroup.findAll({
        where: { canvas_id: canvasId },
        include: TEAM_INCLUDE,
      }),
      CanvasAnnotation.findAll({ where: { canvas_id: canvasId } }),
      CanvasPoolPlacement.findAll({
        where: { canvas_id: canvasId },
        include: [{ model: Pool }],
      }),
    ]);

  return {
    canvas: canvas ? canvas.toJSON() : null,
    drafts,
    connections,
    groups: groups.map((group) => group.toJSON()),
    annotations: annotations.map((annotation) => annotation.toJSON()),
    pools: poolPlacements.map((p) => p.toJSON()),
  };
}

module.exports = {
  CANVAS_DRAFT_ATTRIBUTES,
  DRAFT_ATTRIBUTES,
  TEAM_INCLUDE,
  buildCanvasSnapshot,
};
