// scripts/ugg-scraper/constants.mjs
//
// u.gg public JSON endpoints. The data is keyed by [region][rank][role] with
// positional-array leaves; index meanings are documented below and verified
// against the SSR HTML at https://u.gg/lol/champions/{slug}/build.

export const API_VERSION = "1.5";

// Underscore-separated patch. Update each patch cycle. Discoverable from
// the SSR HTML at https://u.gg/lol/champions/aatrox/counter as
// `https://stats2.u.gg/lol/{API_VERSION}/rankings/{PATCH}/...`.
export const PATCH = "16_8";

export const QUEUE = "ranked_solo_5x5";

export const BASE = "https://stats2.u.gg/lol";

// Outer key 1: region. We only consume `world` (all regions combined).
// Verified 2026-04-29 against Aatrox SSR HTML.
export const REGION_INDEX = { world: 12 };

// Outer key 2: rank tier. Only `emerald_plus` is verified — it's the rank
// u.gg's counter page defaults to. Other rank indices are unverified
// guesses; nail them down at decode time if you start using them.
export const RANK_INDEX = {
  emerald_plus: 17,
};

// Outer key 3: role. Verified 2026-04-29 by cross-referencing Aatrox + Caitlyn
// SSR HTML against the compact rankings JSON (Caitlyn covers all five SSR role
// names: jungle/support/adc/top/mid). u.gg SSR uses `adc` for BOTTOM and `mid`
// for MIDDLE — the index→role mapping is:
export const ROLE_INDEX = {
  JUNGLE: 1,
  SUPPORT: 2,
  BOTTOM: 3,
  TOP: 4,
  MIDDLE: 5,
};

export function rankingsUrl(championId) {
  return `${BASE}/${API_VERSION}/rankings/${PATCH}/${QUEUE}/${championId}/${API_VERSION}.0.json`;
}

export function matchupsUrl(championId) {
  return `${BASE}/${API_VERSION}/matchups/${PATCH}/${QUEUE}/${championId}/${API_VERSION}.0.json`;
}
