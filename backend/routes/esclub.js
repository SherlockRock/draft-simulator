/**
 * esclub league mirror API (S2 Task 8, D4, D11, D15). Every route is behind
 * `protect`: esclub data is public to any signed-in user.
 *
 * Privacy: responses carry teams, picks, sides, winners and lanes only. No
 * participant list, player key, Riot ID or esclub user id ever leaves here,
 * and sync rows are shown through `syncView` (no requested_by, message, via).
 * Each query selects only the columns it returns.
 */

const express = require("express");
const router = express.Router();
const { Op } = require("sequelize");
const { protect } = require("../middleware/auth");
const Team = require("../models/Team");
const Tournament = require("../models/Tournament");
const LeagueStage = require("../models/LeagueStage");
const LeagueSeries = require("../models/LeagueSeries");
const LeagueGame = require("../models/LeagueGame");
const EsclubSync = require("../models/EsclubSync");
const syncState = require("../services/esclub/syncState");
const syncEngine = require("../services/esclub/sync");
const addLeagueService = require("../services/esclub/addLeague");

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIES_STATUSES = new Set(["upcoming", "in_progress", "finished"]);
const SERIE_PAGE = "https://esclub.gg/multimedia/serie/";

const isUuid = (value) => typeof value === "string" && UUID.test(value);

const TEAM_ATTRIBUTES = ["id", "name", "acronym", "colors"];
const SERIES_ATTRIBUTES = [
  "id",
  "external_id",
  "tournament_id",
  "stage_id",
  "number",
  "starts_at",
  "status",
  "complete",
  "best_of",
  "draft_type",
  "team1_id",
  "team2_id",
];

/** Left joins to the two teams, with the public columns only. */
function teamIncludes() {
  return ["Team1", "Team2"].map((as) => ({
    model: Team,
    as,
    attributes: TEAM_ATTRIBUTES,
    required: false,
  }));
}

/**
 * A sync row as the client sees it. Never includes who asked, the error
 * message or how it was started.
 * @param {object} row
 */
function syncView(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    tournamentId: row.tournament_id ?? null,
    stageId: row.stage_id ?? null,
    seriesId: row.series_id ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    requestCount: row.request_count ?? 0,
    errorClass: row.error_class ?? null,
    summary: row.summary ?? null,
  };
}

function teamView(team) {
  if (!team) return null;
  return {
    id: team.id,
    name: team.name,
    acronym: team.acronym ?? null,
    colors: team.colors ?? null,
  };
}

/** Which team won a game, 1 | 2 | null (winner is a side, blue_side_team a team). */
function winningTeam(game) {
  if (game.winner !== "blue" && game.winner !== "red") return null;
  const blue = game.blue_side_team;
  if (blue !== 1 && blue !== 2) return null;
  return game.winner === "blue" ? blue : blue === 1 ? 2 : 1;
}

function seriesItem(row, games) {
  const wins = { team1: 0, team2: 0 };
  for (const game of games) {
    const team = winningTeam(game);
    if (team === 1) wins.team1 += 1;
    if (team === 2) wins.team2 += 1;
  }
  return {
    id: row.id,
    externalId: row.external_id,
    stageId: row.stage_id,
    number: row.number,
    startsAt: row.starts_at ?? null,
    status: row.status,
    complete: row.complete,
    bestOf: row.best_of,
    draftType: row.draft_type ?? null,
    team1: teamView(row.Team1),
    team2: teamView(row.Team2),
    gameCount: games.length,
    wins,
  };
}

/** champion -> lane, from a game's participants; the lane is all that leaves. */
function lanesOf(participants) {
  const lanes = {};
  if (!participants || typeof participants !== "object") return lanes;
  for (const [champion, entry] of Object.entries(participants)) {
    const lane = entry && typeof entry === "object" ? entry.lane : null;
    if (typeof lane === "string" && lane) lanes[champion] = lane;
  }
  return lanes;
}

function gameView(game) {
  return {
    number: game.number,
    playedAt: game.played_at ?? null,
    picks: game.picks,
    firstPick: game.first_pick,
    blueSideTeam: game.blue_side_team,
    winner: game.winner ?? null,
    complete: game.complete,
    lanes: lanesOf(game.participants),
  };
}

/** Wrap a handler: a thrown error is logged and answered with a generic 500. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.error(`esclub route ${req.method} ${req.path}: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong" });
    }
  }
};

const notFound = (res) => res.status(404).json({ error: "Not found" });

/**
 * Answer a refused press (shared by add and both refreshes). Returns true when
 * it answered.
 */
function answerRefusal(res, outcome) {
  if (outcome.joined) {
    res.status(200).json({ joined: syncView(outcome.joined) });
  } else if (outcome.busy) {
    res.status(409).json({ retryAfter: outcome.busy.retryAfter });
  } else if (outcome.cooldown) {
    res.status(200).json({ cooldown: { availableAt: outcome.cooldown.availableAt } });
  } else if (outcome.limited) {
    res.set("Retry-After", String(outcome.limited.retryAfter));
    res.status(429).json({ retryAfter: outcome.limited.retryAfter });
  } else if (outcome.off === "disabled") {
    res.status(503).json({ reason: "disabled", error: "esclub sync is off" });
  } else if (outcome.off === "budget") {
    res
      .status(503)
      .json({ reason: "budget", error: "esclub sync paused until tomorrow" });
  } else {
    return false;
  }
  return true;
}

/** Start the work for a sync without waiting for it. */
function startInBackground(sync, work) {
  try {
    Promise.resolve(syncEngine.runSync(sync, work)).catch((err) => {
      console.error(`esclub sync ${sync.id} failed to run: ${err.message}`);
    });
  } catch (err) {
    console.error(`esclub sync ${sync.id} failed to start: ${err.message}`);
  }
}

// ---------------------------------------------------------------- writes

router.post(
  "/leagues",
  protect,
  handle(async (req, res) => {
    const body = req.body ?? {};
    const outcome = await addLeagueService.addLeague({
      url: body.url,
      region: body.region,
      userId: req.user.id,
      via: "api",
    });
    if (outcome.invalid === "URL") {
      return res.status(400).json({
        error: `Paste an esclub series link, like ${addLeagueService.ACCEPTED_LINK_EXAMPLE}`,
        code: "INVALID_URL",
      });
    }
    if (outcome.invalid === "REGION") {
      return res
        .status(400)
        .json({ error: "Choose a valid region", code: "INVALID_REGION" });
    }
    if (outcome.known) return res.status(200).json({ known: outcome.known });
    if (outcome.sync) {
      return res.status(202).json({ sync: syncView(outcome.sync) });
    }
    if (answerRefusal(res, outcome)) return undefined;
    console.error("esclub add: unexpected addLeague result");
    return res.status(500).json({ error: "Something went wrong" });
  }),
);

router.post(
  "/tournaments/:id/refresh",
  protect,
  handle(async (req, res) => {
    const tournamentId = req.params.id;
    if (!isUuid(tournamentId)) return notFound(res);
    const tournament = await Tournament.findByPk(tournamentId, {
      attributes: ["id", "source"],
    });
    if (!tournament || tournament.source !== "esclub") return notFound(res);

    const outcome = await syncState.beginSync({
      kind: "league",
      tournamentId,
      userId: req.user.id,
      via: "api",
      now: new Date(),
    });
    if (outcome.sync) {
      startInBackground(outcome.sync, (client, summary) =>
        syncEngine.syncTournament(client, { tournamentId, summary }),
      );
      return res.status(202).json({ sync: syncView(outcome.sync) });
    }
    if (answerRefusal(res, outcome)) return undefined;
    console.error("esclub refresh: unexpected beginSync result");
    return res.status(500).json({ error: "Something went wrong" });
  }),
);

router.post(
  "/series/:id/refresh",
  protect,
  handle(async (req, res) => {
    const seriesId = req.params.id;
    if (!isUuid(seriesId)) return notFound(res);
    const series = await LeagueSeries.findByPk(seriesId, {
      attributes: ["id", "tournament_id", "stage_id"],
    });
    if (!series) return notFound(res);

    const outcome = await syncState.beginSync({
      kind: "serie",
      tournamentId: series.tournament_id,
      stageId: series.stage_id ?? null,
      seriesId,
      userId: req.user.id,
      via: "api",
      now: new Date(),
    });
    if (outcome.sync) {
      startInBackground(outcome.sync, (client, summary) =>
        syncEngine.syncSerie(client, { seriesId, summary }),
      );
      return res.status(202).json({ sync: syncView(outcome.sync) });
    }
    if (answerRefusal(res, outcome)) return undefined;
    console.error("esclub serie refresh: unexpected beginSync result");
    return res.status(500).json({ error: "Something went wrong" });
  }),
);

// ----------------------------------------------------------------- reads

router.get(
  "/syncs/:id",
  protect,
  handle(async (req, res) => {
    if (!isUuid(req.params.id)) return notFound(res);
    const row = await syncState.getSync(req.params.id);
    if (!row) return notFound(res);
    return res.json({ sync: syncView(row) });
  }),
);

router.get(
  "/tournaments/:id",
  protect,
  handle(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) return notFound(res);
    const tournament = await Tournament.findByPk(id, {
      attributes: ["id", "name", "region", "source", "last_synced_at"],
    });
    if (!tournament || tournament.source !== "esclub") return notFound(res);

    const now = new Date();
    const stages = await LeagueStage.findAll({
      where: { tournament_id: id },
      attributes: ["id", "name", "last_synced_at"],
      order: [
        ["name", "ASC"],
        ["id", "ASC"],
      ],
    });
    const running = await EsclubSync.findOne({
      where: { tournament_id: id, status: "running" },
      attributes: [
        "id",
        "kind",
        "status",
        "tournament_id",
        "stage_id",
        "series_id",
        "started_at",
        "finished_at",
        "request_count",
        "error_class",
        "summary",
      ],
    });
    const availableAt = await syncState.nextAvailableAt({
      kind: "league",
      tournamentId: id,
      now,
    });
    const usage = await syncState.usageToday({ now });

    return res.json({
      tournament: {
        id: tournament.id,
        name: tournament.name,
        region: tournament.region,
        lastSyncedAt: tournament.last_synced_at ?? null,
      },
      stages: stages.map((s) => ({
        id: s.id,
        name: s.name,
        lastSyncedAt: s.last_synced_at ?? null,
      })),
      sync: {
        running: running ? syncView(running) : null,
        availableAt: availableAt ?? null,
        syncEnabled: syncState.limitsFromEnv().enabled,
        budgetPaused: usage.used >= usage.budget,
      },
    });
  }),
);

router.get(
  "/tournaments/:id/series",
  protect,
  handle(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) return notFound(res);
    const { stage, team, status } = req.query;
    if (stage !== undefined && !isUuid(stage)) {
      return res.status(400).json({ error: "stage must be a UUID" });
    }
    if (team !== undefined && !isUuid(team)) {
      return res.status(400).json({ error: "team must be a UUID" });
    }
    if (status !== undefined && !SERIES_STATUSES.has(status)) {
      return res.status(400).json({
        error: "status must be upcoming, in_progress or finished",
      });
    }

    const tournament = await Tournament.findByPk(id, {
      attributes: ["id", "source"],
    });
    if (!tournament || tournament.source !== "esclub") return notFound(res);

    const where = { tournament_id: id };
    if (stage !== undefined) where.stage_id = stage;
    if (status !== undefined) where.status = status;
    if (team !== undefined) {
      where[Op.or] = [{ team1_id: team }, { team2_id: team }];
    }
    const rows = await LeagueSeries.findAll({
      where,
      attributes: SERIES_ATTRIBUTES,
      include: teamIncludes(),
      order: [
        ["starts_at", "ASC NULLS LAST"],
        ["number", "ASC"],
        ["id", "ASC"],
      ],
    });

    // One query for every game of the listed series; only the columns that
    // decide a win (no participants).
    const gamesBySeries = new Map();
    if (rows.length > 0) {
      const games = await LeagueGame.findAll({
        where: { series_id: rows.map((r) => r.id) },
        attributes: ["series_id", "winner", "blue_side_team"],
      });
      for (const game of games) {
        const list = gamesBySeries.get(game.series_id) ?? [];
        list.push(game);
        gamesBySeries.set(game.series_id, list);
      }
    }
    return res.json({
      series: rows.map((r) => seriesItem(r, gamesBySeries.get(r.id) ?? [])),
    });
  }),
);

router.get(
  "/series/:id",
  protect,
  handle(async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) return notFound(res);
    const row = await LeagueSeries.findByPk(id, {
      attributes: SERIES_ATTRIBUTES,
      include: teamIncludes(),
    });
    if (!row) return notFound(res);
    // participants is read only to derive lanes; it is never sent.
    const games = await LeagueGame.findAll({
      where: { series_id: id },
      attributes: [
        "series_id",
        "number",
        "played_at",
        "picks",
        "first_pick",
        "blue_side_team",
        "winner",
        "complete",
        "participants",
      ],
      order: [["number", "ASC"]],
    });
    return res.json({
      series: {
        ...seriesItem(row, games),
        esclubUrl: `${SERIE_PAGE}${row.external_id}`,
        games: games.map(gameView),
      },
    });
  }),
);

module.exports = router;
