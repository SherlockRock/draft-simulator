import type {
  ScoreSet, ChampionMeta, MetaData, PlayerModel,
  Phase, Side, WeightedAssignment,
} from "./types.js";
import { getPhaseWeights } from "./weights.js";
import { createAssignmentCache } from "./role-solver.js";

export interface EvalInput {
  bluePicks: string[];
  redPicks: string[];
  blueBans: string[];
  redBans: string[];
  phase: Phase;
  userSide: Side;
  remainingPool: string[];
  champions: Record<string, ChampionMeta>;
  metaData: MetaData;
  playerModel: PlayerModel;
  assignmentCache: ReturnType<typeof createAssignmentCache>;
}

export function evaluate(input: EvalInput): ScoreSet {
  const picks = input.userSide === "blue" ? input.bluePicks : input.redPicks;

  if (picks.length === 0) {
    return { composite: 0, compStrength: 0, informationValue: 0, flexRetention: 0, revealCost: 0 };
  }

  // Dimension 1: Role coverage (binary gate)
  const assignments = input.assignmentCache.solve(picks, input.champions);
  if (picks.length >= 5 && assignments.length === 0) {
    return { composite: -Infinity, compStrength: 0, informationValue: 0, flexRetention: 0, revealCost: 0 };
  }

  // Dimension 2: Damage balance (0-1)
  const damageBalance = scoreDamageBalance(picks, input.champions);

  // Dimension 3: CC & engage quality (0-1)
  const ccEngage = scoreCcEngage(picks, input.champions, input.metaData);

  // Dimension 4: Scaling coherence (0-1)
  const scalingCoherence = scoreScalingCoherence(picks, input.champions);

  // Dimension 5: Flex retention (0-1)
  const flexRetention = scoreFlexRetention(picks, assignments, input);

  // Dimension 6: Reveal cost (0-1)
  const revealCost = scoreRevealCost(picks, assignments, input);

  // Dimension 7: Player feasibility (0-1)
  const playerFeasibility = scorePlayerFeasibility(picks, input.playerModel);

  // Composite
  const weights = getPhaseWeights(input.phase, input.userSide);
  const compStrength = (damageBalance + ccEngage + scalingCoherence + playerFeasibility) / 4;
  const informationValue = flexRetention - revealCost;
  const composite = weights.compStrength * compStrength + weights.informationValue * informationValue;

  return { composite, compStrength, informationValue, flexRetention, revealCost };
}

function scoreDamageBalance(picks: string[], champions: Record<string, ChampionMeta>): number {
  let physical = 0, magic = 0, trueD = 0;
  for (const id of picks) {
    const c = champions[id];
    physical += c.damageProfile.physical;
    magic += c.damageProfile.magic;
    trueD += c.damageProfile.true;
  }
  const total = physical + magic + trueD;
  if (total === 0) return 0.5;
  const maxSkew = Math.max(physical, magic, trueD) / total;
  if (maxSkew > 0.7) return Math.max(0, 1 - (maxSkew - 0.7) / 0.3);
  return 1.0;
}

function scoreCcEngage(
  picks: string[],
  champions: Record<string, ChampionMeta>,
  metaData: MetaData,
): number {
  let engageSum = 0, peelSum = 0;
  for (const id of picks) {
    engageSum += champions[id].ccProfile.engageQuality;
    peelSum += champions[id].ccProfile.peelQuality;
  }
  const engageScore = Math.min(engageSum / picks.length, 1);
  const peelScore = Math.min(peelSum / picks.length, 1);
  let base = (engageScore + peelScore) / 2;

  const teamTags = new Set<string>();
  for (const id of picks) {
    for (const tag of champions[id].tags.synergy) {
      teamTags.add(tag);
    }
  }
  for (const rule of metaData.synergies) {
    if (teamTags.has(rule.tags[0]) && teamTags.has(rule.tags[1])) {
      base += rule.bonus * 0.1;
    }
  }

  return Math.min(base, 1);
}

function scoreScalingCoherence(picks: string[], champions: Record<string, ChampionMeta>): number {
  if (picks.length < 2) return 0.5;
  const peaks: number[] = [];
  for (const id of picks) {
    const s = champions[id].scalingProfile;
    if (s.early >= s.mid && s.early >= s.late) peaks.push(0);
    else if (s.mid >= s.late) peaks.push(1);
    else peaks.push(2);
  }
  const uniquePeaks = new Set(peaks).size;
  return 1 - (uniquePeaks - 1) / 2;
}

function scoreFlexRetention(
  picks: string[],
  currentAssignments: WeightedAssignment[],
  input: EvalInput,
): number {
  if (picks.length <= 1) {
    const champ = input.champions[picks[0]];
    return champ ? Math.min(champ.positions.length / 3, 1) : 0.5;
  }
  const prevPicks = picks.slice(0, -1);
  const prevAssignments = input.assignmentCache.solve(prevPicks, input.champions);
  const prevTotal = prevAssignments.reduce((s, a) => s + a.weight, 0);
  const currTotal = currentAssignments.reduce((s, a) => s + a.weight, 0);
  if (prevTotal === 0) return 0;
  return Math.min(currTotal / prevTotal, 1);
}

function scoreRevealCost(
  picks: string[],
  currentAssignments: WeightedAssignment[],
  input: EvalInput,
): number {
  if (picks.length <= 1) return 0;
  const prevPicks = picks.slice(0, -1);
  const prevAssignments = input.assignmentCache.solve(prevPicks, input.champions);
  const prevEntropy = assignmentEntropy(prevAssignments);
  const currEntropy = assignmentEntropy(currentAssignments);
  if (prevEntropy === 0) return 0;
  return Math.max(0, (prevEntropy - currEntropy) / prevEntropy);
}

function assignmentEntropy(assignments: WeightedAssignment[]): number {
  if (assignments.length <= 1) return 0;
  const totalWeight = assignments.reduce((s, a) => s + a.weight, 0);
  if (totalWeight === 0) return 0;
  let entropy = 0;
  for (const a of assignments) {
    const p = a.weight / totalWeight;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

function scorePlayerFeasibility(picks: string[], playerModel: PlayerModel): number {
  if (picks.length === 0) return 1;
  let total = 0;
  for (const id of picks) {
    if (playerModel.championTiers.core.includes(id)) total += 1.0;
    else if (playerModel.championTiers.playable.includes(id)) total += 0.85;
    else if (playerModel.championTiers.emergency.includes(id)) total += 0.65;
    else total += 0.75;
  }
  return total / picks.length;
}
