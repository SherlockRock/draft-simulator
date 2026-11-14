// The pure planner of S3 (docs/plans/2026-11-14-s3-plan.md, D2–D6): what a
// send of a mirrored league series puts on a canvas, what a refresh changes,
// and where bulk-sent groups go. No model, no database, no esclub client: the
// callers read the mirror rows and write what this returns.
//
// Nothing a planner returns carries player data: participants, player keys and
// Riot IDs stay in the mirror (the S3 privacy rule).

const { withoutPlaceholderTeamNames } = require("../../utils/teamPlaceholders");
const {
  SERIES_GAME_STEP,
  nextSeriesCardOrigin,
  seriesCardOrigin,
} = require("../../utils/seriesCardLayout");

const DEFAULT_ROW_STEP = 1250;
const MIN_ROW_STEP = 200;
const MAX_ROW_STEP = 2000;
const MIN_SERIES_LENGTH = 1;
const MAX_SERIES_LENGTH = 7;

function byNumber(a, b) {
  return a.number - b.number;
}

function mirrorWinner(game) {
  return game.winner === "blue" || game.winner === "red" ? game.winner : null;
}

function completedAtFor(game, now) {
  return game.played_at ? new Date(game.played_at) : now;
}

/**
 * The Draft row for one mirrored game (D2). Callers add `versus_draft_id`.
 * @param {object} game a LeagueGame row (plain)
 * @param {{ seriesName: string, senderId: string, now: Date }} ctx
 * @returns {object}
 */
function draftRow(game, { seriesName, senderId, now }) {
  const winner = mirrorWinner(game);
  return {
    type: "versus",
    seriesIndex: game.number,
    name: `${seriesName} - Game ${game.number + 1}`,
    picks: [...game.picks],
    firstPick: game.first_pick,
    blueSideTeam: game.blue_side_team,
    winner,
    completed: winner !== null,
    completedAt: winner !== null ? completedAtFor(game, now) : null,
    public: false,
    owner_id: senderId,
  };
}

// Both team ids set, and the Team1 / Team2 rows are those same teams.
function hasBothTeams(series) {
  return (
    Boolean(series.team1_id) &&
    Boolean(series.team2_id) &&
    Boolean(series.Team1) &&
    Boolean(series.Team2) &&
    series.Team1.id === series.team1_id &&
    series.Team2.id === series.team2_id
  );
}

// VersusDraft.length validates 1..7.
function isSupportedLength(bestOf) {
  return Number.isInteger(bestOf) && bestOf >= MIN_SERIES_LENGTH && bestOf <= MAX_SERIES_LENGTH;
}

function cardRow(seriesIndex, { x, y }) {
  return { seriesIndex, positionX: x, positionY: y, is_locked: true, source_type: "versus" };
}

/**
 * Plan the send of one mirrored series to a canvas (D2, D3). Team 1 of the
 * series is team 1 everywhere (fix 7); sides stay per game. The group comes
 * without canvas id or position, which the caller adds.
 * Refusals, in this order: "no-teams" (a team id missing, or its `Team1` /
 * `Team2` row missing or of another id), "upcoming", "unsupported-length"
 * (`best_of` not an integer in 1..7, VersusDraft.length's range), "no-games".
 * @param {object} series a LeagueSeries row (plain) with `Team1` / `Team2` `{id, name}`
 * @param {object[]} games its LeagueGame rows (plain), any order
 * @param {{ senderId: string, now?: Date }} options
 * @returns {{ versusDraft: object, drafts: object[], group: object, cards: object[] } | { refused: "no-teams" | "upcoming" | "unsupported-length" | "no-games" }}
 */
function planSend(series, games, { senderId, now = new Date() }) {
  if (!hasBothTeams(series)) return { refused: "no-teams" };
  if (series.status === "upcoming") return { refused: "upcoming" };
  if (!isSupportedLength(series.best_of)) return { refused: "unsupported-length" };
  if (!Array.isArray(games) || games.length === 0) return { refused: "no-games" };

  const blueTeamName = series.Team1.name;
  const redTeamName = series.Team2.name;
  const name = `${blueTeamName} vs ${redTeamName}`;
  const type = series.draft_type || "standard";
  const ordered = [...games].sort(byNumber);

  const versusDraft = {
    origin: "manual",
    league_series_id: series.id,
    name,
    blueTeamName,
    redTeamName,
    length: series.best_of,
    type,
    competitive: true,
    disabledChampions: [],
    owner_id: senderId,
  };
  const drafts = ordered.map((game) => draftRow(game, { seriesName: name, senderId, now }));
  const group = {
    type: "series",
    name,
    team1_id: series.team1_id,
    team2_id: series.team2_id,
    metadata: withoutPlaceholderTeamNames({
      blueTeamName,
      redTeamName,
      length: series.best_of,
      competitive: true,
      seriesType: type,
      draftMode: type,
      origin: "manual",
      disabledChampions: [],
      gameType: "official",
    }),
  };
  const cards = ordered.map((game, i) => cardRow(game.number, seriesCardOrigin(i)));
  return { versusDraft, drafts, group, cards };
}

function samePicks(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((p, i) => p === b[i]);
}

/**
 * Plan a refresh of an imported series from the mirror (D6, Q2 B, Q3 A).
 *  - appends: a Draft and a locked card for each mirror game whose number has
 *    no Draft in the series (a Draft dragged out of the group still counts),
 *    placed after `lastCard`, one series step apart;
 *  - updates: an existing Draft follows its mirror game's picks, first pick
 *    and sides; its winner is set from the mirror when the mirror has one
 *    (never cleared). Only changed fields are listed; `picksChanged` asks the
 *    caller to bump `picksVersion`. A Draft without a mirror game is left
 *    alone, and no existing card is ever moved.
 * Running it again on the applied result gives no appends and no updates.
 * @param {{ id: string, seriesIndex: number, picks: string[], firstPick: string, blueSideTeam: number, winner: string|null, completed: boolean }[]} existingDrafts every Draft of the series
 * @param {object[]} games the series' LeagueGame rows (plain)
 * @param {{ lastCard: { positionX: number, positionY: number } | null, now?: Date, seriesName: string, senderId: string }} options
 * @returns {{ appends: { draft: object, card: object }[], updates: { id: string, changes: object, picksChanged?: true }[] }}
 */
function planRefresh(existingDrafts, games, { lastCard, now = new Date(), seriesName, senderId }) {
  const byIndex = new Map(existingDrafts.map((d) => [d.seriesIndex, d]));
  const ordered = [...(games || [])].sort(byNumber);

  const appends = [];
  const updates = [];
  let origin = nextSeriesCardOrigin(lastCard || null);

  for (const game of ordered) {
    const draft = byIndex.get(game.number);
    if (!draft) {
      appends.push({
        draft: draftRow(game, { seriesName, senderId, now }),
        card: cardRow(game.number, origin),
      });
      origin = { x: origin.x + SERIES_GAME_STEP, y: origin.y };
      continue;
    }

    const changes = {};
    let picksChanged = false;
    if (!samePicks(draft.picks, game.picks)) {
      changes.picks = [...game.picks];
      picksChanged = true;
    }
    if (draft.firstPick !== game.first_pick) changes.firstPick = game.first_pick;
    if (draft.blueSideTeam !== game.blue_side_team) changes.blueSideTeam = game.blue_side_team;
    const winner = mirrorWinner(game);
    if (winner !== null && (draft.winner !== winner || draft.completed !== true)) {
      changes.winner = winner;
      changes.completed = true;
      changes.completedAt = completedAtFor(game, now);
    }
    if (Object.keys(changes).length > 0) {
      updates.push(picksChanged ? { id: draft.id, changes, picksChanged: true } : { id: draft.id, changes });
    }
  }
  return { appends, updates };
}

function startsAtMs(series) {
  if (series.starts_at === null || series.starts_at === undefined) return null;
  const ms = new Date(series.starts_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The order of a bulk send's column (Q4 A): newest first, by `starts_at`
 * descending (none last), then series number descending, then id.
 * @param {object[]} seriesList LeagueSeries rows (plain)
 * @returns {object[]} a new array
 */
function bulkOrder(seriesList) {
  return [...seriesList].sort((a, b) => {
    const ta = startsAtMs(a);
    const tb = startsAtMs(b);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    }
    if (a.number !== b.number) return (b.number ?? 0) - (a.number ?? 0);
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
}

/**
 * Where bulk-sent groups go (D5): a column down from the drop point, one
 * `rowStep` apart. `rowStep` is clamped to 200–2000 and falls back to 1250
 * when absent or not a finite number.
 * @param {{ positionX: number, positionY: number }} drop
 * @param {number} count
 * @param {number} [rowStep]
 * @returns {{ x: number, y: number }[]}
 */
function columnPositions({ positionX, positionY }, count, rowStep) {
  const step =
    typeof rowStep === "number" && Number.isFinite(rowStep)
      ? Math.min(MAX_ROW_STEP, Math.max(MIN_ROW_STEP, rowStep))
      : DEFAULT_ROW_STEP;
  return Array.from({ length: count }, (_, i) => ({ x: positionX, y: positionY + i * step }));
}

module.exports = {
  DEFAULT_ROW_STEP,
  planSend,
  planRefresh,
  bulkOrder,
  columnPositions,
};
