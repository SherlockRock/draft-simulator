// scripts/ugg-scraper/fetcher.mjs
//
// Polite HTTP fetching for u.gg's stats endpoints. Self-rate-limits to be
// gentle (u.gg doesn't enforce a rate-limit header, but unbounded fetching is
// rude). Retries on 5xx + 429 + transient network errors with exponential
// backoff. Returns null on 404 — u.gg legitimately 404s for
// (champion, patch) combos that don't exist (e.g. Smolder pre-release).

import { TokenBucket } from "../match-pipeline/rate-limiter.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER_AGENT = "draft-simulator-pipeline/1.0 (firstpick.lol)";

export class UggFetcher {
  constructor({
    fetch = globalThis.fetch.bind(globalThis),
    rateLimiter = new TokenBucket(5, 1000),
    maxRetries = 3,
    backoffBaseMs = 500,
    logger = console,
  } = {}) {
    this.fetch = fetch;
    this.rateLimiter = rateLimiter;
    this.maxRetries = maxRetries;
    this.backoffBaseMs = backoffBaseMs;
    this.logger = logger;
  }

  async getJson(url) {
    return this.#request(url, { headers: { "user-agent": USER_AGENT } });
  }

  async postJson(url, body) {
    return this.#request(url, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async #request(url, init) {
    let attempt = 0;
    while (true) {
      await this.rateLimiter.acquire();
      let response;
      try {
        response = await this.fetch(url, init);
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        const wait = this.backoffBaseMs * 2 ** attempt;
        this.logger.warn?.(`fetch error ${err.message}; retry in ${wait}ms`);
        await sleep(wait);
        attempt += 1;
        continue;
      }

      if (response.ok) return response.json();

      // 404 = legitimate "no data" (private/empty profile, missing combo).
      // 403 = u.gg's response for non-real / blocked identifiers. Both: null.
      if (response.status === 404 || response.status === 403) return null;

      if (response.status >= 500 || response.status === 429) {
        if (attempt >= this.maxRetries) {
          throw new Error(
            `u.gg ${response.status} after ${attempt} retries: ${url}`,
          );
        }
        const wait = this.backoffBaseMs * 2 ** attempt;
        this.logger.warn?.(`${response.status} from ${url}; retry in ${wait}ms`);
        await sleep(wait);
        attempt += 1;
        continue;
      }

      throw new Error(`u.gg ${response.status} from ${url}`);
    }
  }
}
