#!/usr/bin/env node
/**
 * Collector orchestrator — one process per region:
 *
 *   node collector.mjs --region na1
 *
 * Runs migrate, then three async loops sharing one CompositeRateLimiter
 * (deliberately unlike LoLDraftAI's split-budget processes — the ladder and
 * match-id loops' demand is bursty and small next to the processor's, so a
 * shared in-process limiter uses the whole per-region budget):
 *   - ladder loop     every 24h
 *   - match-id loop   continuous, backlog-aware
 *   - processor loop  continuous (match+timeline → extract → JSONB)
 *
 * SIGTERM/SIGINT finish the in-flight items (not the whole batch — a processor
 * batch is ~8 min of rate budget, systemd's TimeoutStopSec is 120s), then exit.
 * A 401/403 pauses all loops in KEY_EXPIRED until push-key.sh delivers a
 * fresh key to the env file; the DB is the only state.
 */

import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { createDb, migrate } from "./db.mjs";
import { SlidingWindowBucket, CompositeRateLimiter } from "./rate-limiter.mjs";
import { RiotClient } from "./riot-client.mjs";
import { KeyManager, wrapClientWithKeyRotation } from "./key-manager.mjs";
import { runLadderOnce } from "./ladder.mjs";
import { runMatchIdCycle } from "./match-ids.mjs";
import { runProcessorCycle } from "./processor.mjs";

const { values } = parseArgs({ options: { region: { type: "string" } } });
const region = values.region;
if (!region) {
  console.error("collector: --region is required (e.g. --region na1)");
  process.exit(1);
}

const config = loadConfig();
if (!config.regions.includes(region)) {
  console.error(`collector: region "${region}" not in COLLECTOR_REGIONS (${config.regions})`);
  process.exit(1);
}

const line = (loop, msg) => console.log(`${new Date().toISOString()} ${region} ${loop} ${msg}`);
const makeLogger = (loop) => ({
  info: (msg) => line(loop, msg),
  warn: (msg) => line(loop, `WARN ${msg}`),
  error: (msg) => line(loop, `ERROR ${msg}`),
});
const log = makeLogger("main");

if (!process.env.DATABASE_URL) {
  console.error("collector: DATABASE_URL is required");
  process.exit(1);
}
const db = createDb(process.env.DATABASE_URL);
await migrate(db);
log.info("schema migrated");

const envFile = process.env.COLLECTOR_ENV_FILE ?? "/etc/firstpick-collector/env";
const keyManager = new KeyManager({ envFilePath: envFile, logger: makeLogger("key") });
const apiKey = (await keyManager.loadKey().catch(() => null)) ?? process.env.RIOT_API_KEY;
if (!apiKey) {
  console.error(`collector: no RIOT_API_KEY in ${envFile} or environment`);
  process.exit(1);
}
keyManager.currentKey = apiKey;

// Sliding-window buckets — Riot counts requests per window; a refill-style
// token bucket double-spends the window at boot and 429-oscillates.
const buckets = [...config.appBuckets, config.matchMethodBucket].map(
  ([capacity, windowMs]) => new SlidingWindowBucket(capacity, windowMs),
);
const rateLimiter = new CompositeRateLimiter(buckets);
const rawClient = new RiotClient({
  apiKey,
  rateLimiter,
  logger: makeLogger("http"),
});
const client = wrapClientWithKeyRotation(rawClient, keyManager, makeLogger("key"));

let running = true;
const shouldStop = () => !running;
const sleepWhileRunning = async (ms) => {
  const until = Date.now() + ms;
  while (running && Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
  }
};

async function ladderLoop() {
  const logger = makeLogger("ladder");
  while (running) {
    try {
      const n = await runLadderOnce({ client, db, config, region, logger, shouldStop });
      logger.info(`refreshed ${n} summoners`);
    } catch (err) {
      logger.error(err.message);
    }
    await sleepWhileRunning(config.ladderIntervalMs);
  }
}

async function matchIdLoop() {
  const logger = makeLogger("match-ids");
  while (running) {
    try {
      const r = await runMatchIdCycle({ client, db, config, region, logger, shouldStop });
      if (r.discovered > 0 || r.summonersProcessed > 0) {
        logger.info(`summoners=${r.summonersProcessed} discovered=${r.discovered}`);
      }
      if (r.paused || r.summonersProcessed === 0) await sleepWhileRunning(60_000);
    } catch (err) {
      logger.error(err.message);
      await sleepWhileRunning(10_000);
    }
  }
}

async function processorLoop() {
  const logger = makeLogger("processor");
  while (running) {
    try {
      const r = await runProcessorCycle({ client, db, config, region, logger, shouldStop });
      if (r.claimed > 0) {
        logger.info(
          `claimed=${r.claimed} fetched=${r.fetched} skipped=${r.skipped} failed=${r.failed}`,
        );
      } else {
        await sleepWhileRunning(30_000);
      }
    } catch (err) {
      logger.error(err.message);
      await sleepWhileRunning(10_000);
    }
  }
}

const loops = Promise.all([ladderLoop(), matchIdLoop(), processorLoop()]);

const shutdown = (signal) => {
  log.info(`${signal} received, draining in-flight work`);
  running = false;
  keyManager.abort(); // unblock loops parked in KEY_EXPIRED
  rateLimiter.abort(); // unblock requests parked on a saturated window (up to 2 min)
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log.info(`collector started (buckets: ${JSON.stringify(config.appBuckets)})`);
await loops;
await db.close();
log.info("collector stopped cleanly");
// Stray retry/backoff timers must not keep the process alive past a drain.
process.exit(0);
