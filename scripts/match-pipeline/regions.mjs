/**
 * Riot API region routing.
 *
 * Riot splits endpoints into two routing tiers:
 *   - Platform endpoints (Summoner-V4, League-V4)  → e.g. na1.api.riotgames.com
 *   - Continent endpoints (Match-V5, Account-V1)    → e.g. americas.api.riotgames.com
 *
 * v1 of the pipeline uses NA only, but the full mapping is captured here
 * so adding regions later is a one-line change at the call site.
 */

export const PLATFORMS = Object.freeze({
  na1: { continent: "americas", displayName: "North America" },
  br1: { continent: "americas", displayName: "Brazil" },
  la1: { continent: "americas", displayName: "Latin America North" },
  la2: { continent: "americas", displayName: "Latin America South" },
  euw1: { continent: "europe", displayName: "Europe West" },
  eun1: { continent: "europe", displayName: "Europe Nordic & East" },
  ru: { continent: "europe", displayName: "Russia" },
  tr1: { continent: "europe", displayName: "Turkey" },
  kr: { continent: "asia", displayName: "Korea" },
  jp1: { continent: "asia", displayName: "Japan" },
  oc1: { continent: "sea", displayName: "Oceania" },
  ph2: { continent: "sea", displayName: "Philippines" },
  sg2: { continent: "sea", displayName: "Singapore" },
  th2: { continent: "sea", displayName: "Thailand" },
  tw2: { continent: "sea", displayName: "Taiwan" },
  vn2: { continent: "sea", displayName: "Vietnam" },
});

export const CONTINENTS = Object.freeze(["americas", "europe", "asia", "sea"]);

export function getPlatformHost(platform) {
  if (!PLATFORMS[platform]) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return `${platform}.api.riotgames.com`;
}

export function getContinentHost(continent) {
  if (!CONTINENTS.includes(continent)) {
    throw new Error(`Unknown continent: ${continent}`);
  }
  return `${continent}.api.riotgames.com`;
}

export function platformToContinent(platform) {
  if (!PLATFORMS[platform]) {
    throw new Error(`Unknown platform: ${platform}`);
  }
  return PLATFORMS[platform].continent;
}
