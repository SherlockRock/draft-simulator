/**
 * Personal-key rotation. The key lives in /etc/firstpick-collector/env and
 * expires every 24h. On a 401/403 the worker enters KEY_EXPIRED — it stops
 * issuing requests and polls the env file until the key changes (the user
 * pushes a fresh one via push-key.sh), then resumes. No restart, no crash
 * loop; the DB is the only state.
 *
 * A freshly regenerated key can be "Unknown apikey" at Riot for its first
 * seconds, so a rejected key is also re-probed each poll: the file never
 * changes in that case, and waiting for a *different* key stranded the
 * collectors on a key that was valid moments later (seen 4x, 2026-08-23/25).
 */

import { readFile as fsReadFile } from "node:fs/promises";

// Unref'd: a pending key-poll sleep must never hold the process open past
// shutdown (abort() breaks the loop, but the timer would still be live).
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

/** Minimal KEY=value parser for the env file (comments, blanks, quotes). */
export function parseEnvFile(content) {
  const out = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export class KeyManager {
  constructor({
    envFilePath,
    pollIntervalMs = 30_000,
    readFile = (p) => fsReadFile(p, "utf8"),
    sleep = defaultSleep,
    probeKey = null,
    logger = console,
  }) {
    this.envFilePath = envFilePath;
    this.pollIntervalMs = pollIntervalMs;
    this.readFile = readFile;
    this.sleep = sleep;
    this.probeKey = probeKey;
    this.logger = logger;
    this.state = "ok";
    this.currentKey = null;
    this.pendingWait = null;
    this.aborted = false;
    this.abortedPromise = new Promise((resolve) => {
      this.#resolveAbort = resolve;
    });
  }

  #resolveAbort;

  /** Unblock any pending waiters (shutdown path) — they reject with "aborted". */
  abort() {
    this.aborted = true;
    this.#resolveAbort();
  }

  async loadKey() {
    const parsed = parseEnvFile(await this.readFile(this.envFilePath));
    this.currentKey = parsed.RIOT_API_KEY ?? null;
    return this.currentKey;
  }

  /**
   * Called after a 401/403 seen with `badKey`. Resolves with a usable key:
   * immediately if the key already rotated, otherwise after polling the env
   * file until it changes — or, when a `probeKey` is configured, until Riot
   * starts accepting the same key. Concurrent callers share one poll loop.
   */
  async waitForNewKey(badKey) {
    if (this.currentKey && this.currentKey !== badKey) return this.currentKey;
    if (!this.pendingWait) {
      this.pendingWait = this.#pollUntilRotated(badKey).finally(() => {
        this.pendingWait = null;
      });
    }
    return this.pendingWait;
  }

  async #pollUntilRotated(badKey) {
    this.state = "KEY_EXPIRED";
    this.logger.warn?.(`key-manager: key rejected; polling ${this.envFilePath} for a fresh key`);
    while (!this.aborted) {
      await Promise.race([this.sleep(this.pollIntervalMs), this.abortedPromise]);
      if (this.aborted) break;
      const key = await this.loadKey().catch((err) => {
        this.logger.warn?.(`key-manager: cannot read env file: ${err.message}`);
        return null;
      });
      if (key && key !== badKey) {
        this.state = "ok";
        this.logger.info?.("key-manager: new key detected, resuming");
        return key;
      }
      if (key && this.probeKey && (await this.#probe(key))) {
        this.state = "ok";
        this.logger.info?.("key-manager: rejected key is now accepted by Riot, resuming");
        return key;
      }
    }
    throw new Error("key-manager aborted");
  }

  async #probe(key) {
    try {
      return await this.probeKey(key);
    } catch (err) {
      this.logger.warn?.(`key-manager: probe failed, will retry: ${err.message}`);
      return false;
    }
  }
}

/**
 * Build a `probeKey` for KeyManager from a raw RiotClient: one cheap
 * platform-data GET with the candidate key. Resolves true on success, false on
 * 401/403; other errors (network, 5xx after retries) propagate so the caller
 * can log them as "not yet" rather than "rejected".
 */
export function makeKeyProbe(rawClient, platform) {
  return async (key) => {
    const previous = rawClient.apiKey;
    rawClient.apiKey = key;
    try {
      await rawClient.get("/lol/status/v4/platform-data", { routing: "platform", region: platform });
      return true;
    } catch (err) {
      if (AUTH_ERROR.test(err.message)) return false;
      throw err;
    } finally {
      rawClient.apiKey = previous;
    }
  };
}

const AUTH_ERROR = /Riot API (401|403)\b/;

/**
 * Wrap a RiotClient so any 401/403 pauses in KEY_EXPIRED and retries with the
 * rotated key. All other errors pass through untouched.
 */
export function wrapClientWithKeyRotation(client, keyManager, logger = console) {
  const wrap =
    (method) =>
    async (...args) => {
      while (true) {
        try {
          return await client[method](...args);
        } catch (err) {
          if (!AUTH_ERROR.test(err.message)) throw err;
          logger.warn?.(`key rotation: ${method} got auth failure, waiting for new key: ${err.message}`);
          client.apiKey = await keyManager.waitForNewKey(client.apiKey);
        }
      }
    };

  const wrapped = {};
  for (const method of [
    "get",
    "getMatch",
    "getMatchTimeline",
    "getMatchIdsByPuuid",
    "getApexEntries",
    "getLeagueEntries",
    "getSummonerByPuuid",
  ]) {
    if (typeof client[method] === "function") wrapped[method] = wrap(method);
  }
  return wrapped;
}
