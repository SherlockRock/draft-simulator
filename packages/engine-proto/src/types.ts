// === Primitives ===

export type Side = "blue" | "red";
export type Phase = "ban1" | "pick1" | "ban2" | "pick2";
export type ActionType = "ban" | "pick";
export type Position = "TOP" | "JUNGLE" | "MIDDLE" | "ADC" | "SUPPORT";

// === Turn Sequence ===

export interface TurnInfo {
  side: Side;
  type: ActionType;
  phase: Phase;
  /** True if this is the first action of a double-pick turn */
  pairStart: boolean;
  /** True if this is the second action of a double-pick turn */
  pairEnd: boolean;
}

// === Draft State (internal, used during search) ===

export interface DraftState {
  blueBans: string[];
  redBans: string[];
  bluePicks: string[];
  redPicks: string[];
  /** Index into TURN_SEQUENCE (0-19). 20 = draft complete. */
  turnIndex: number;
}

// === Scores ===

export interface ScoreSet {
  composite: number;
  compStrength: number;
  informationValue: number;
  flexRetention: number;
  revealCost: number;
}

// === Role Assignment ===

export interface RoleAssignment {
  TOP: string;
  JUNGLE: string;
  MIDDLE: string;
  ADC: string;
  SUPPORT: string;
}

export interface WeightedAssignment {
  assignment: RoleAssignment;
  weight: number;
}

// === Tree ===

export interface TreeNode {
  championId: string | null;
  scores: ScoreSet;
  assignmentDistribution: WeightedAssignment[];
  side: Side | null;
  slot: number | null;
  userInjected: boolean;
  children: TreeNode[];
}

// === Scenario ===

export type Perspective = "robust" | "likely" | "off_profile";

export interface Scenario {
  name: string;
  scores: Pick<ScoreSet, "composite" | "compStrength" | "informationValue">;
  description: string;
  bluePicks: string[];
  likelyAssignments: WeightedAssignment[];
  redPicks: string[];
  treePath: number[];
  perspective: Perspective;
  indicators: string[];
}

// === Opponent Model ===

export interface OpponentModel {
  type: "meta" | "player_specific";
  /** Champion ID → pick probability (0-1) */
  weights: Record<string, number>;
  /** Champion ID → { counter champion ID → multiplier } */
  conditionalAdjustments?: Record<string, Record<string, number>>;
}

// === Player Model ===

export interface PlayerModel {
  championTiers: {
    core: string[];
    playable: string[];
    emergency: string[];
  };
  weights: Record<string, number>;
}

// === Engine Config ===

export interface ForcedMove {
  slot: number;
  championId: string;
  type: ActionType;
}

export interface EngineConfig {
  branchWidth: number;
  maxDepth: number;
  latencyBudgetMs: number;
  forcedMoves: ForcedMove[];
}

// === Meta Data (from compiled matchup-data.json) ===

export interface SynergyRule {
  tags: [string, string];
  bonus: number;
  description: string;
}

export interface MetaData {
  winRates: Record<string, number>;
  synergies: SynergyRule[];
  /** Champion ID → { opponent champion ID → win rate differential } */
  counters: Record<string, Record<string, number>>;
}

// === Champion Data (from compiled champion-meta.json) ===

export interface DamageProfile {
  physical: number;
  magic: number;
  true: number;
}

export interface ScalingProfile {
  early: number;
  mid: number;
  late: number;
}

export interface CcProfile {
  hasCc: boolean;
  ccTypes: string[];
  engageQuality: number;
  peelQuality: number;
}

export interface ChampionTags {
  archetype: string[];
  synergy: string[];
}

export interface ChampionMeta {
  id: string;
  name: string;
  positions: Position[];
  damageProfile: DamageProfile;
  scalingProfile: ScalingProfile;
  ccProfile: CcProfile;
  tags: ChampionTags;
  blindability: number;
  pickRate: number;
  banRate: number;
  winRate: number;
}

export interface ChampionMetaFile {
  version: string;
  patch: string;
  compiledAt: string;
  sources: {
    cdragonScrapedAt: string;
    merakiScrapedAt: string;
  };
  champions: Record<string, ChampionMeta>;
}

export interface MatchupDataFile {
  compiledAt: string;
  counters: Record<string, Record<string, number>>;
  synergyRules: SynergyRule[];
}

// === Engine Request ===

export interface DraftStateInput {
  format: "standard";
  bans: Array<{ championId: string; side: Side; slot: number }>;
  picks: Array<{ championId: string; side: Side; slot: number }>;
  currentPhase: Phase;
  currentSlot: number;
  currentSide: Side;
}

export interface EngineRequest {
  draftState: DraftStateInput;
  searchPool: string[];
  opponentModel: OpponentModel;
  playerModel: PlayerModel;
  metaData: MetaData;
  config: EngineConfig;
}

// === Engine Output ===

export interface ComputeMeta {
  nodesEvaluated: number;
  computeTimeMs: number;
  pruningRate: number;
  depthReached: number;
  transpositionsFound: number;
}

export interface EngineOutput {
  tree: TreeNode;
  scenarios: Scenario[];
  meta: ComputeMeta;
}

// === Search Context (internal, bundles shared params for search recursion) ===

export interface SearchContext {
  champions: Record<string, ChampionMeta>;
  metaData: MetaData;
  playerModel: PlayerModel;
  opponentModel: OpponentModel;
  config: EngineConfig;
  userSide: Side;
}

// === Phase Weights ===

export interface PhaseWeights {
  compStrength: number;
  informationValue: number;
}
