import type { ChampionMeta, Position, DraftState } from "../src/types.js";

/** Minimal champion factory — only fill fields tests actually check */
export function makeChampion(
  id: string,
  positions: Position[],
  overrides: Partial<ChampionMeta> = {},
): ChampionMeta {
  return {
    id,
    name: id,
    positions,
    damageProfile: { physical: 0.5, magic: 0.4, true: 0.1 },
    scalingProfile: { early: 0.3, mid: 0.6, late: 0.4 },
    ccProfile: { hasCc: false, ccTypes: [], engageQuality: 0, peelQuality: 0 },
    tags: { archetype: [], synergy: [] },
    blindability: 0.5,
    pickRate: 0.05,
    banRate: 0.05,
    winRate: 0.5,
    ...overrides,
  };
}

/**
 * 6 champions that can fill all 5 roles, with Akali as a MID/TOP flex.
 * Use this as the default test champion pool.
 */
export const TEST_CHAMPIONS: Record<string, ChampionMeta> = {
  Aatrox: makeChampion("Aatrox", ["TOP"], {
    damageProfile: { physical: 0.8, magic: 0.1, true: 0.1 },
    scalingProfile: { early: 0.3, mid: 0.7, late: 0.9 },
    ccProfile: { hasCc: true, ccTypes: ["knockup"], engageQuality: 0.2, peelQuality: 0.2 },
    tags: { archetype: ["bruiser", "frontline"], synergy: ["frontline", "ad_threat"] },
  }),
  LeeSin: makeChampion("LeeSin", ["JUNGLE"], {
    damageProfile: { physical: 0.85, magic: 0.1, true: 0.05 },
    scalingProfile: { early: 0.9, mid: 0.6, late: 0.3 },
    ccProfile: { hasCc: true, ccTypes: ["knockback"], engageQuality: 0.7, peelQuality: 0.5 },
    tags: { archetype: ["bruiser"], synergy: ["engage_initiator"] },
  }),
  Ahri: makeChampion("Ahri", ["MIDDLE"], {
    damageProfile: { physical: 0.05, magic: 0.9, true: 0.05 },
    scalingProfile: { early: 0.4, mid: 0.8, late: 0.6 },
    ccProfile: { hasCc: true, ccTypes: ["charm"], engageQuality: 0.3, peelQuality: 0.4 },
    tags: { archetype: ["mage", "assassin"], synergy: ["ap_threat", "pick_threat"] },
  }),
  Jinx: makeChampion("Jinx", ["ADC"], {
    damageProfile: { physical: 0.95, magic: 0.05, true: 0 },
    scalingProfile: { early: 0.2, mid: 0.5, late: 1.0 },
    ccProfile: { hasCc: true, ccTypes: ["slow", "root"], engageQuality: 0, peelQuality: 0.1 },
    tags: { archetype: ["adc"], synergy: ["adc", "backline_carry"] },
  }),
  Leona: makeChampion("Leona", ["SUPPORT"], {
    damageProfile: { physical: 0.3, magic: 0.6, true: 0.1 },
    scalingProfile: { early: 0.7, mid: 0.7, late: 0.4 },
    ccProfile: { hasCc: true, ccTypes: ["stun", "root"], engageQuality: 0.9, peelQuality: 0.6 },
    tags: { archetype: ["tank", "engage"], synergy: ["engage_initiator", "frontline"] },
  }),
  Akali: makeChampion("Akali", ["MIDDLE", "TOP"], {
    damageProfile: { physical: 0.3, magic: 0.65, true: 0.05 },
    scalingProfile: { early: 0.4, mid: 0.8, late: 0.7 },
    ccProfile: { hasCc: false, ccTypes: [], engageQuality: 0.3, peelQuality: 0 },
    tags: { archetype: ["assassin"], synergy: ["ap_threat"] },
  }),
};

export const TEST_CHAMPION_IDS = Object.keys(TEST_CHAMPIONS);

/** Empty draft state at turn 0 */
export function emptyDraft(): DraftState {
  return { blueBans: [], redBans: [], bluePicks: [], redPicks: [], turnIndex: 0 };
}
