/**
 * Add a league (S2 Task 7, D4, D12, D15): from one esclub series link, walk up
 * serie -> (group ->) round -> stage -> season, check the stage is one we can
 * mirror, then create the tournament, stage and the user's row and backfill
 * the stage, all inside one counted `add` sync.
 *
 * Only esclub series links are accepted (plan Q2). Everything is validated
 * before anything is written, and a rejection writes nothing.
 *
 * Cost note: a series already in the mirror is recognised with no request. Any
 * other known stage is only recognised after the walk, so it costs the walk's
 * 4 or 5 requests (6 with the season fetch of a group link) and the `add` sync
 * row it leaves counts toward the 3-adds-a-day limit, although it backfills
 * nothing.
 */

const { UniqueConstraintError } = require("sequelize");
const sequelize = require("../../config/database");
const Tournament = require("../../models/Tournament");
const LeagueStage = require("../../models/LeagueStage");
const LeagueSeries = require("../../models/LeagueSeries");
const UserTournament = require("../../models/UserTournament");
const { isValidRegion } = require("../../utils/teamRegions");
const defaultRequests = require("./requests");
const defaultStore = require("./mirrorStore");
const defaultState = require("./syncState");
const syncEngine = require("./sync");
const { EsclubError, EsclubProtocolChanged } = require("./errors");

const { ACCEPTED_LINK_EXAMPLE, parseEsclubUrl } = require("../../utils/esclubLinks");

const NAME_MAX = 200;
const SUPPORTED_FEARLESS = new Set(["HardPick", "None"]);

/**
 * A league was understood and refused. `code` is stable:
 * NOT_LOL, NO_DRAFT, BLIND or UNSUPPORTED_DRAFT.
 */
class EsclubLeagueRejected extends EsclubError {
  /**
   * @param {"NOT_LOL" | "NO_DRAFT" | "BLIND" | "UNSUPPORTED_DRAFT"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function need(condition, what) {
  if (!condition) throw new EsclubProtocolChanged(`esclub add league: ${what} missing or malformed`);
}

/**
 * Walk up from a series and check the stage may be mirrored. Requests: serie,
 * (group,) round, stage, season: 5 under a group, 4 under a round.
 * @param {import("./client").EsclubClient} client
 * @param {{ serieId: string }} ids
 * @param {typeof defaultRequests} [requests]
 * @returns {Promise<{ season: { externalId: string, name: string }, stage: { externalId: string, name: string } }>}
 * @throws {EsclubLeagueRejected} the stage is not League of Legends, has no
 *   default draft, a blind one, or an unsupported fearless type
 * @throws {EsclubProtocolChanged} a needed field is missing or the parent type is unknown
 */
async function validateAndLocate(client, { serieId }, requests = defaultRequests) {
  const serie = await requests.fetchSerie(client, { id_serie: serieId });
  let roundId;
  if (serie.type_parent === "Group") {
    roundId = (await requests.fetchGroup(client, { id_group: serie.id_parent })).id_round;
  } else if (serie.type_parent === "Round") {
    roundId = serie.id_parent;
  } else {
    throw new EsclubProtocolChanged("esclub add league: unknown series type_parent");
  }
  const round = await requests.fetchRound(client, { id_round: roundId });
  const stage = await requests.fetchEventStage(client, { id_event_stage: round.id_event_stage });

  need(typeof stage.id_game === "string", "stage.id_game");
  need(typeof stage.id_event_active === "string", "stage.id_event_active");
  if (stage.id_game !== syncEngine.LOL_GAME_ID) {
    throw new EsclubLeagueRejected("NOT_LOL", "this league is not League of Legends");
  }
  const draft = stage.config.default_draft;
  if (draft === null) {
    throw new EsclubLeagueRejected("NO_DRAFT", "this league's stage has no default draft");
  }
  need(isObject(draft), "stage.config.default_draft");
  need(typeof draft.is_blind === "boolean", "default_draft.is_blind");
  need(typeof draft.type_fearless === "string", "default_draft.type_fearless");
  if (draft.is_blind) {
    throw new EsclubLeagueRejected("BLIND", "this league uses blind drafts, which are not imported");
  }
  if (!SUPPORTED_FEARLESS.has(draft.type_fearless)) {
    throw new EsclubLeagueRejected("UNSUPPORTED_DRAFT", `this league's fearless type ${JSON.stringify(draft.type_fearless)} is not supported`);
  }

  const season = await requests.fetchEventActive(client, { id_event_active: stage.id_event_active });
  return {
    season: { externalId: season.id_event_active, name: season.name },
    stage: { externalId: stage.id_event_stage, name: stage.name },
  };
}

/**
 * Create the user's UserTournaments row, or un-archive it.
 * @param {string} userId
 * @param {string} tournamentId
 * @param {object} [transaction]
 * @returns {Promise<void>}
 */
async function ensureUserTournament(userId, tournamentId, transaction) {
  const opts = transaction ? { transaction } : {};
  const [updated] = await UserTournament.update(
    { archived_at: null },
    { where: { user_id: userId, tournament_id: tournamentId }, ...opts },
  );
  if (updated > 0) return;
  try {
    await UserTournament.create({ user_id: userId, tournament_id: tournamentId, archived_at: null }, opts);
  } catch (err) {
    // A concurrent press made the row between our update and insert: it exists.
    if (!(err instanceof UniqueConstraintError)) throw err;
  }
}

/**
 * Point the running sync row at the tournament and stage it found.
 * @param {string} syncId
 * @param {string} tournamentId
 * @param {string} stageId
 * @param {object} [transaction]
 * @returns {Promise<void>}
 */
async function setSyncTarget(syncId, tournamentId, stageId, transaction) {
  await sequelize.query(
    `UPDATE "EsclubSyncs"
        SET tournament_id = :tournamentId, stage_id = :stageId, "updatedAt" = NOW()
      WHERE id = :syncId AND status = 'running'`,
    { replacements: { syncId, tournamentId, stageId }, ...(transaction ? { transaction } : {}) },
  );
}

/** Find or create the season's Tournament and the stage, and the user's row, in one transaction. */
async function writeLeague({ located, region, userId, syncId, store }) {
  const { season, stage } = located;
  return store.inTransaction(async (transaction) => {
    let tournament = await Tournament.findOne({
      where: { source: "esclub", external_id: season.externalId },
      transaction,
    });
    let stageRow = await LeagueStage.findOne({ where: { external_id: stage.externalId }, transaction });
    if (stageRow && (!tournament || stageRow.tournament_id !== tournament.id)) {
      throw new EsclubProtocolChanged("stage belongs to a different season");
    }
    const newSeason = !tournament;
    if (!tournament) {
      tournament = await Tournament.create(
        {
          name: season.name.slice(0, NAME_MAX),
          source: "esclub",
          external_id: season.externalId,
          region,
          created_by: userId,
        },
        { transaction },
      );
    }
    const newStage = !stageRow;
    if (!stageRow) {
      stageRow = await LeagueStage.create(
        {
          tournament_id: tournament.id,
          external_id: stage.externalId,
          name: stage.name.slice(0, NAME_MAX),
          added_by: userId,
        },
        { transaction },
      );
    }
    // The CLI adds without a user: no UserTournaments row then.
    if (userId) await ensureUserTournament(userId, tournament.id, transaction);
    await setSyncTarget(syncId, tournament.id, stageRow.id, transaction);
    return {
      newSeason,
      newStage,
      // A stage whose first backfill failed has never been stamped: backfill it now.
      stageSynced: Boolean(stageRow.last_synced_at),
      tournament: {
        id: tournament.id,
        external_id: tournament.external_id,
        region: tournament.region,
        source: tournament.source,
        name: tournament.name,
      },
      stage: { id: stageRow.id, external_id: stageRow.external_id, name: stageRow.name },
    };
  }, syncId);
}

/**
 * Add the league behind an esclub series link for a user.
 *
 * Returns `{ invalid: "URL" | "REGION" }` before any request or row;
 * `{ known: { tournamentId, stageId } }` when the series is already mirrored
 * and its stage's initial backfill succeeded
 * (the user's row is created or un-archived; no request, no sync row, no add
 * counted); a refusal of `beginSync` as is (`off`, `busy`, `joined`,
 * `cooldown`, `limited`); otherwise `{ sync }`, and with `background: false`
 * also `{ result }` once the work is done. A rejected league ends the sync as
 * failed (class EsclubLeagueRejected) and writes nothing.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {string} [args.region]
 * @param {string | null} args.userId
 * @param {"api" | "cli"} [args.via]
 * @param {Record<string, string | undefined>} [args.env]
 * @param {() => Date} [args.now]
 * @param {Function} [args.session] defaults to the real esclub session
 * @param {typeof defaultStore} [args.store]
 * @param {boolean} [args.background] return at once and run the sync unawaited
 * @returns {Promise<object>}
 */
async function addLeague({
  url,
  region = "na1",
  userId,
  via = "api",
  env = process.env,
  now = () => new Date(),
  session,
  store = defaultStore,
  background = true,
}) {
  const parsed = parseEsclubUrl(url);
  if (!parsed) return { invalid: "URL" };
  if (!isValidRegion(region)) return { invalid: "REGION" };

  const knownSeries = await LeagueSeries.findOne({
    where: { external_id: parsed.id },
    attributes: ["tournament_id", "stage_id"],
    raw: true,
  });
  const knownStage = knownSeries
    ? await LeagueStage.findByPk(knownSeries.stage_id, { attributes: ["last_synced_at"], raw: true })
    : null;
  if (knownStage?.last_synced_at) {
    if (userId) {
      await store.inTransaction((transaction) => ensureUserTournament(userId, knownSeries.tournament_id, transaction));
    }
    return { known: { tournamentId: knownSeries.tournament_id, stageId: knownSeries.stage_id } };
  }

  const began = await defaultState.beginSync({ kind: "add", tournamentId: null, userId, via, now: now(), env });
  if (!began.sync) return began;
  const sync = began.sync;

  const work = async (client, summary) => {
    const located = await validateAndLocate(client, { serieId: parsed.id });
    const written = await writeLeague({ located, region, userId, syncId: sync.id, store });
    summary.newSeason = written.newSeason;
    summary.newStage = written.newStage;
    summary.backfilled = written.newStage || !written.stageSynced;
    if (summary.backfilled) {
      await syncEngine.syncStage(client, { tournament: written.tournament, stage: written.stage, store, summary, now });
      await store.inTransaction((transaction) => store.touchSynced(written.stage, written.tournament, now(), transaction), sync.id);
    }
  };

  const running = syncEngine.runSync(sync, work, { env, session, now });
  if (background) {
    running.catch((err) => console.error(`esclub add league ${sync.id}: ${err instanceof Error ? err.constructor.name : "Error"}`));
    return { sync };
  }
  return { sync, result: await running };
}

module.exports = {
  ACCEPTED_LINK_EXAMPLE,
  EsclubLeagueRejected,
  parseEsclubUrl,
  validateAndLocate,
  ensureUserTournament,
  setSyncTarget,
  addLeague,
};
