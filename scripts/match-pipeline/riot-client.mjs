/**
 * Riot Games API client.
 *
 * Wraps `fetch` with:
 *   - X-Riot-Token authentication
 *   - Two-tier rate limiting (via injected CompositeRateLimiter)
 *   - 429 handling that respects Retry-After
 *   - 5xx exponential backoff with jitter
 *   - Immediate errors for other 4xx responses
 *
 * The `fetch` and `sleep` implementations are injectable so tests can run
 * deterministically without touching the network or wall-clock time.
 */

import { getPlatformHost, getContinentHost } from "./regions.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RiotClient {
  constructor({
    apiKey,
    rateLimiter = null,
    fetch = globalThis.fetch.bind(globalThis),
    sleep = defaultSleep,
    maxRetries = 5,
    backoffBaseMs = 500,
    backoffMaxMs = 30_000,
    logger = console,
  } = {}) {
    if (!apiKey) {
      throw new Error("RiotClient: apiKey is required");
    }
    this.apiKey = apiKey;
    this.rateLimiter = rateLimiter;
    this.fetch = fetch;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.backoffBaseMs = backoffBaseMs;
    this.backoffMaxMs = backoffMaxMs;
    this.logger = logger;
  }

  #buildUrl(path, { routing, region, query }) {
    const host =
      routing === "platform" ? getPlatformHost(region) : getContinentHost(region);
    let url = `https://${host}${path}`;
    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        params.append(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  async get(path, opts = {}) {
    const { routing, region, query, signal } = opts;
    if (!routing || !region) {
      throw new Error("RiotClient.get: routing and region are required");
    }
    const url = this.#buildUrl(path, { routing, region, query });

    let attempt = 0;
    while (true) {
      if (this.rateLimiter) {
        await this.rateLimiter.acquire();
      }

      const response = await this.fetch(url, {
        method: "GET",
        headers: {
          "X-Riot-Token": this.apiKey,
          accept: "application/json",
        },
        signal,
      });

      if (response.status >= 200 && response.status < 300) {
        return response.json();
      }

      if (response.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new Error(`Riot API 429 after ${attempt} retries: ${url}`);
        }
        const retryAfterSec = parseInt(response.headers.get("retry-after") ?? "1", 10);
        const waitMs = Math.max(0, retryAfterSec * 1000);
        this.logger.warn?.(`429 from ${url}; sleeping ${waitMs}ms (Retry-After)`);
        await this.sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (response.status >= 500 && response.status < 600) {
        if (attempt >= this.maxRetries) {
          throw new Error(`Riot API ${response.status} after ${attempt} retries: ${url}`);
        }
        const base = Math.min(this.backoffBaseMs * 2 ** attempt, this.backoffMaxMs);
        // Full jitter: random in [base, 2*base)
        const waitMs = base + Math.floor(Math.random() * base);
        this.logger.warn?.(`${response.status} from ${url}; backoff ${waitMs}ms`);
        await this.sleep(waitMs);
        attempt += 1;
        continue;
      }

      // Other 4xx — surface immediately, don't retry.
      let body = "";
      try {
        body = await response.text();
      } catch {
        /* swallow */
      }
      throw new Error(`Riot API ${response.status} from ${url}: ${body}`);
    }
  }

  // ---- Convenience methods ----

  /**
   * Match-V5: full match document.
   * @param {string} matchId   e.g. "NA1_5012345678"
   * @param {string} continent  "americas" | "europe" | "asia" | "sea"
   */
  getMatch(matchId, continent) {
    return this.get(`/lol/match/v5/matches/${matchId}`, {
      routing: "continent",
      region: continent,
    });
  }

  /**
   * Match-V5: list match IDs for a player. Default queue=420 (ranked solo/duo).
   * @param {string} puuid
   * @param {string} continent
   * @param {object} opts
   * @param {number} [opts.queue]      e.g. 420 for ranked solo/duo
   * @param {string} [opts.type]       "ranked" | "normal" | "tourney" | "tutorial"
   * @param {number} [opts.count]      1..100, default 20
   * @param {number} [opts.start]      pagination offset
   * @param {number} [opts.startTime]  unix seconds
   * @param {number} [opts.endTime]    unix seconds
   */
  getMatchIdsByPuuid(puuid, continent, opts = {}) {
    return this.get(`/lol/match/v5/matches/by-puuid/${puuid}/ids`, {
      routing: "continent",
      region: continent,
      query: opts,
    });
  }

  /**
   * League-V4 apex tiers (CHALLENGER / GRANDMASTER / MASTER) — single-page LeagueListDTO.
   * @param {object} opts
   * @param {"CHALLENGER" | "GRANDMASTER" | "MASTER"} opts.tier
   * @param {string} opts.queue       e.g. "RANKED_SOLO_5x5"
   * @param {string} opts.platform    e.g. "na1"
   */
  getApexEntries({ tier, queue, platform }) {
    const tierPath = {
      CHALLENGER: "challengerleagues",
      GRANDMASTER: "grandmasterleagues",
      MASTER: "masterleagues",
    }[tier];
    if (!tierPath) {
      throw new Error(`getApexEntries: unsupported tier "${tier}"`);
    }
    return this.get(`/lol/league/v4/${tierPath}/by-queue/${queue}`, {
      routing: "platform",
      region: platform,
    });
  }

  /**
   * Summoner-V4 by PUUID — needed if we ever start from a non-PUUID source.
   */
  getSummonerByPuuid(puuid, platform) {
    return this.get(`/lol/summoner/v4/summoners/by-puuid/${puuid}`, {
      routing: "platform",
      region: platform,
    });
  }
}
