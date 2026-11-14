/** Admin CLI for the esclub mirror. Run from backend: node scripts/esclub.js <cmd>. */
const { isValidRegion } = require("../utils/teamRegions");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIE_URL = /^https?:\/\/(?:www\.)?esclub\.gg\/multimedia\/serie\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[^?#\s]*)?(?:\?[^#\s]*)?(?:#\S*)?$/i;
const USAGE = "Usage: node scripts/esclub.js status | list | add <series-url> [--region <region>] | refresh <tournament-uuid> | refresh-serie <series-uuid> | purge <tournament-uuid> [--yes] | unlock";

/**
 * Parse CLI arguments without loading models or opening a connection.
 * @param {string[]} args command arguments, excluding node and script path
 * @returns {object} the validated command
 * @throws {Error} unsupported command, argument, id, URL or region
 */
function parseArgs(args) {
  const [command, value, flag, option] = args;
  if (["status", "list", "unlock"].includes(command) && args.length === 1) return { command };
  if (command === "add" && (args.length === 2 || (args.length === 4 && flag === "--region"))) {
    if (!SERIE_URL.test(value)) throw new Error("Expected an esclub series link: https://esclub.gg/multimedia/serie/<series id>");
    const region = option ?? "na1";
    if (!isValidRegion(region)) throw new Error("Invalid region");
    return { command, url: value, region };
  }
  if (["refresh", "refresh-serie", "purge"].includes(command)) {
    const validLength = args.length === 2 || (command === "purge" && args.length === 3 && flag === "--yes");
    if (validLength && typeof value === "string" && UUID.test(value)) {
      return { command, id: value, ...(command === "purge" ? { yes: flag === "--yes" } : {}) };
    }
  }
  throw new Error(USAGE);
}

/**
 * Load production services lazily. Queries below project administrative
 * metadata and counts only; no game participants, rosters or error messages.
 * @returns {object} CLI dependencies, including close for the database pool
 */
function createServices() {
  const { QueryTypes } = require("sequelize");
  const sequelize = require("../config/database");
  const select = (sql, replacements = {}) => sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
  return {
    ...require("../services/esclub/syncState"),
    ...require("../services/esclub/sync"),
    addLeague: require("../services/esclub/addLeague").addLeague,
    ...require("../services/esclub/purge"),
    close: () => sequelize.close(),
    findTournament: async (id) => (await select(
      `SELECT id FROM "Tournaments" WHERE id = :id AND source = 'esclub'`, { id },
    ))[0] ?? null,
    findSerie: async (id) => (await select(
      `SELECT s.id, s.tournament_id, s.stage_id FROM "LeagueSeries" s
         JOIN "Tournaments" t ON t.id = s.tournament_id
       WHERE s.id = :id AND t.source = 'esclub'`, { id },
    ))[0] ?? null,
    readRunning: async () => (await select(
      `SELECT id, kind, tournament_id, stage_id, series_id, status, started_at,
              heartbeat_at, request_count FROM "EsclubSyncs" WHERE status = 'running' LIMIT 1`,
    ))[0] ?? null,
    listTournaments: () => select(
      `SELECT t.id, t.name, t.region, t.last_synced_at,
         (SELECT COUNT(*)::int FROM "LeagueStages" WHERE tournament_id = t.id) AS stages,
         (SELECT COUNT(*)::int FROM "LeagueSeries" WHERE tournament_id = t.id) AS series,
         (SELECT COUNT(*)::int FROM "LeagueGames" g JOIN "LeagueSeries" s ON s.id = g.series_id
            WHERE s.tournament_id = t.id) AS games,
         latest.id AS last_sync_id, latest.status AS last_sync_status,
         latest.started_at AS last_sync_started_at, latest.finished_at AS last_sync_finished_at,
         latest.request_count AS last_sync_requests, latest.error_class AS last_sync_error_class
       FROM "Tournaments" t LEFT JOIN LATERAL
         (SELECT id, status, started_at, finished_at, request_count, error_class FROM "EsclubSyncs"
          WHERE tournament_id = t.id ORDER BY started_at DESC, id DESC LIMIT 1) latest ON true
       WHERE t.source = 'esclub' ORDER BY t.name, t.id`,
    ),
  };
}

function syncView(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    tournamentId: row.tournament_id ?? null,
    seriesId: row.series_id ?? null,
    requestCount: row.request_count ?? 0,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    errorClass: row.error_class ?? null,
  };
}

function printAnswer(answer, output) {
  if (answer.off) {
    output.error(answer.off === "disabled" ? "esclub sync is off" : "esclub daily request budget is exhausted");
    return 1;
  }
  if (answer.busy || answer.limited) {
    output.error(JSON.stringify(answer.busy ? { busy: answer.busy } : { limited: answer.limited }));
    return 1;
  }
  if (answer.invalid) {
    output.error(`Invalid ${answer.invalid}`);
    return 1;
  }
  if (answer.result?.status === "failed") {
    output.error(`esclub sync failed (${answer.result.error?.name ?? "Error"})`);
    return 1;
  }
  output.log(JSON.stringify({
    ...(answer.sync ? { sync: syncView(answer.sync) } : {}),
    ...(answer.joined ? { joined: syncView(answer.joined) } : {}),
    ...(answer.known ? { known: answer.known } : {}),
    ...(answer.cooldown ? { cooldown: answer.cooldown } : {}),
    ...(answer.result ? { status: answer.result.status, summary: answer.result.summary } : {}),
  }, null, 2));
  return 0;
}

/**
 * Execute a command with injected environment, services, clock and output.
 * Sync commands use via="cli"/userId=null to skip user limits and cooldowns,
 * and run synchronously through the engine's switch, lock, budget and cap.
 * Without injected services the build's database guard applies before loading
 * the database. Only the executable's own pool is closed here.
 * @param {string[]} args command arguments
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {object} [options.services]
 * @param {{ log: Function, error: Function }} [options.output]
 * @param {() => Date} [options.now]
 * @returns {Promise<number>} exit code: 0 success, 1 refused/failed, 2 bad arguments
 */
async function runCli(args, { env = process.env, services, output = console, now = () => new Date() } = {}) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    output.error(error.message);
    return 2;
  }
  const ownServices = !services;
  if (ownServices && env.DB_NAME !== "firstpick_s2_build") {
    output.error("Database guard: DB_NAME must be firstpick_s2_build");
    return 1;
  }
  try {
    services ??= createServices();
    const limits = services.limitsFromEnv(env);
    const { command, id } = parsed;
    if (["add", "refresh", "refresh-serie"].includes(command) && !limits.enabled) {
      output.error("esclub sync is off");
      return 1;
    }
    if (command === "status") {
      const [usage, running, tournaments] = await Promise.all([
        services.usageToday({ now: now(), env }), services.readRunning(), services.listTournaments(),
      ]);
      output.log(JSON.stringify({ syncEnabled: limits.enabled, ...usage, left: Math.max(0, usage.budget - usage.used), cap: limits.cap, running: syncView(running), tournaments }, null, 2));
      return 0;
    }
    if (command === "list") {
      output.log(JSON.stringify(await services.listTournaments(), null, 2));
      return 0;
    }
    if (command === "unlock") {
      output.log(`Marked ${await services.markStale(now())} stale sync(s) failed.`);
      return 0;
    }
    if (command === "purge") {
      const planned = await services.previewPurge(id);
      output.log(JSON.stringify({ wouldDelete: planned }, null, 2));
      if (!parsed.yes) {
        output.log("No rows deleted. Repeat with --yes to purge. Sync logs are kept.");
        return 0;
      }
      output.log(JSON.stringify({ deleted: await services.purgeTournament(id) }, null, 2));
      return 0;
    }
    if (command === "add") {
      return printAnswer(await services.addLeague({ url: parsed.url, region: parsed.region, via: "cli", userId: null, background: false, env, now }), output);
    }
    const serie = command === "refresh-serie";
    const target = await (serie ? services.findSerie(id) : services.findTournament(id));
    if (!target) {
      output.error(serie ? "esclub series not found" : "esclub tournament not found");
      return 1;
    }
    const began = await services.beginSync({
      kind: serie ? "serie" : "league",
      tournamentId: serie ? target.tournament_id : target.id,
      ...(serie ? { seriesId: target.id, stageId: target.stage_id } : {}),
      via: "cli", userId: null, now: now(), env,
    });
    if (!began.sync) return printAnswer(began, output);
    const result = await services.runSync(began.sync, (client, summary) => (
      serie ? services.syncSerie(client, { seriesId: id, summary }) : services.syncTournament(client, { tournamentId: id, summary })
    ), { env, now });
    const sync = await services.getSync(began.sync.id);
    return printAnswer({ sync: sync ?? began.sync, result }, output);
  } catch (error) {
    // Error messages can contain transport payloads or DB values. Class only.
    output.error(`esclub command failed (${error.name ?? "Error"})`);
    return 1;
  } finally {
    if (ownServices && services) await services.close();
  }
}

module.exports = { parseArgs, createServices, runCli };

if (require.main === module) {
  require("dotenv").config();
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    console.error("esclub command failed");
    process.exitCode = 1;
  });
}
