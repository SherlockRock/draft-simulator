import { z } from "zod";
import { SideSchema, PhaseSchema, TeamPoolSchema } from "./types.js";

const PickOrBanSchema = z.object({
  championId: z.string(),
  side: SideSchema,
  slot: z.number().int().nonnegative(),
});

const DraftStateInputSchema = z.object({
  format: z.literal("standard"),
  bans: z.array(PickOrBanSchema),
  picks: z.array(PickOrBanSchema),
  currentPhase: PhaseSchema,
  currentSlot: z.number().int().nonnegative(),
  currentSide: SideSchema,
});

const PoolsSchema = z.object({
  ourSide: SideSchema,
  blue: TeamPoolSchema,
  red: TeamPoolSchema,
  crossGameExclusions: z.array(z.string()),
});

const OpponentModelSchema = z.object({
  type: z.enum(["meta", "player_specific"]),
  weights: z.record(z.string(), z.number()),
  conditionalAdjustments: z
    .array(
      z.object({
        when: z.string(),
        then: z.string(),
        multiplier: z.number(),
      }),
    )
    .optional(),
});

const PlayerModelSchema = z.object({
  championTiers: z.object({
    core: z.array(z.string()),
    playable: z.array(z.string()),
    emergency: z.array(z.string()),
  }),
  weights: z.record(z.string(), z.number()),
});

const SearchConfigSchema = z.object({
  branchWidth: z.number().int().positive(),
  pairBranchWidth: z.number().int().positive(),
  singlePairTopK: z.number().int().positive(),
  maxDepth: z.number().int().positive(),
  broadDepth: z.number().int().positive(),
  extensionTurnThreshold: z.number().int().positive(),
  latencyBudgetMs: z.number().int().positive(),
});

const PhaseWeightTableSchema = z.object({
  ban1: z.object({ info: z.number(), comp: z.number(), coverage: z.number() }),
  pick1: z.object({ info: z.number(), comp: z.number(), coverage: z.number() }),
  ban2: z.object({ info: z.number(), comp: z.number(), coverage: z.number() }),
  pick2: z.object({ info: z.number(), comp: z.number(), coverage: z.number() }),
});

const WeightsConfigSchema = z.object({
  phaseWeights: z.object({
    blue: PhaseWeightTableSchema,
    red: PhaseWeightTableSchema,
  }),
  penalties: z.object({
    outOfRole: z.number().min(0).max(1),
    outOfPool: z.number().min(0).max(1),
  }),
  synergyMultiplier: z.number(),
  counterMultiplier: z.number(),
  flexRetentionWeight: z.number(),
  revealCostWeight: z.number(),
});

const ForcedBranchSchema = z.object({
  path: z.array(
    z.object({
      slot: z.number().int().nonnegative(),
      championIds: z.array(z.string()),
    }),
  ),
  targetSlot: z.number().int().nonnegative(),
  championId: z.string(),
  mode: z.enum(["sole", "include"]),
});

export const EngineRequestSchema = z.object({
  protocolVersion: z.string(),
  draftState: DraftStateInputSchema,
  pools: PoolsSchema,
  opponentModel: OpponentModelSchema,
  playerModel: PlayerModelSchema,
  config: z.object({
    search: SearchConfigSchema,
    weights: WeightsConfigSchema,
    profile: z.string(),
    forcedBranches: z.array(ForcedBranchSchema),
  }),
});

export type EngineRequest = z.infer<typeof EngineRequestSchema>;
