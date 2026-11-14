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
const Tournament = require("../models/Tournament.js");
const Pool = require("../models/Pool.js");
const VersusDraft = require("../models/VersusDraft.js");
const LeagueSeries = require("../models/LeagueSeries.js");
const LeagueStage = require("../models/LeagueStage.js");
const { esclubSerieUrl } = require("../utils/esclubLinks");

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
  "picksVersion",
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
//
// Each team also carries its Tournament (id, name, source only), so search
// and picker labels can read `name · tournament`. Imported tournaments are
// public; a pickup team has none (LEFT join, so it still loads).
const teamTournamentInclude = () => ({
  model: Tournament,
  attributes: ["id", "name", "source"],
});

const TEAM_INCLUDE = [
  {
    model: Team,
    as: "Team1",
    include: [{ model: TeamPlayer, as: "TeamPlayers" }, teamTournamentInclude()],
  },
  {
    model: Team,
    as: "Team2",
    include: [{ model: TeamPlayer, as: "TeamPlayers" }, teamTournamentInclude()],
  },
];

// Everything a serialized group carries: the linked teams plus, for a series
// sent from the league mirror (S3 D8), the provenance needed for its header
// line and refresh button. LEFT joins only (a custom group has no
// VersusDraft, a manual series no LeagueSeries) and public columns only: no
// games, no participants, no roster ids. The raw rows never leave the server;
// `projectGroup` turns them into `LeagueImport`.
const GROUP_INCLUDE = [
  ...TEAM_INCLUDE,
  {
    model: VersusDraft,
    attributes: ["id", "league_series_id"],
    required: false,
    include: [
      {
        model: LeagueSeries,
        as: "LeagueSeries",
        attributes: [
          "id",
          "external_id",
          "tournament_id",
          "starts_at",
          "status",
          "complete",
        ],
        required: false,
        include: [
          {
            model: LeagueStage,
            as: "Stage",
            attributes: ["name"],
            required: false,
          },
        ],
      },
    ],
  },
];

/**
 * The `LeagueImport` view of a group's VersusDraft (as loaded by
 * GROUP_INCLUDE), or null when the group is not an imported series: no
 * VersusDraft, no `league_series_id` (manual, or purged), or no series row.
 * @param {object|null|undefined} versusDraft  plain VersusDraft JSON
 * @returns {{leagueSeriesId: string, tournamentId: string, stageName: string|null,
 *   startsAt: string|null, status: string, complete: boolean, esclubUrl: string}|null}
 */
function leagueImportView(versusDraft) {
  const series = versusDraft?.LeagueSeries;
  if (!versusDraft?.league_series_id || !series) return null;
  return {
    leagueSeriesId: series.id,
    tournamentId: series.tournament_id,
    stageName: series.Stage?.name ?? null,
    startsAt: series.starts_at ? new Date(series.starts_at).toISOString() : null,
    status: series.status,
    complete: Boolean(series.complete),
    esclubUrl: esclubSerieUrl(series.external_id),
  };
}

/**
 * A group as the client sees it: plain JSON with the raw `VersusDraft`
 * include removed and `LeagueImport` added (null unless imported). Every
 * path that hands out a group loaded with GROUP_INCLUDE goes through here.
 * @param {object} group  a CanvasGroup instance or its toJSON()
 * @returns {object}
 */
function projectGroup(group) {
  const json = typeof group.toJSON === "function" ? group.toJSON() : group;
  const { VersusDraft: versusDraft, ...rest } = json;
  return { ...rest, LeagueImport: leagueImportView(versusDraft) };
}

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
        include: GROUP_INCLUDE,
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
    groups: groups.map(projectGroup),
    annotations: annotations.map((annotation) => annotation.toJSON()),
    pools: poolPlacements.map((p) => p.toJSON()),
  };
}

module.exports = {
  CANVAS_DRAFT_ATTRIBUTES,
  DRAFT_ATTRIBUTES,
  TEAM_INCLUDE,
  GROUP_INCLUDE,
  projectGroup,
  buildCanvasSnapshot,
};
