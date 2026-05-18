import { z } from "zod";
import { SideSchema, PhaseSchema, ActionTypeSchema } from "./types.js";

const ScoreSetSchema = z.object({
  composite: z.number(),
  compStrength: z.number(),
  informationValue: z.number(),
  flexRetention: z.number(),
  revealCost: z.number(),
  roleCoverage: z.number(),
});
export type ScoreSet = z.infer<typeof ScoreSetSchema>;

const RoleAssignmentSchema = z.object({
  TOP: z.string(),
  JUNGLE: z.string(),
  MIDDLE: z.string(),
  ADC: z.string(),
  SUPPORT: z.string(),
});

const WeightedAssignmentSchema = z.object({
  assignment: RoleAssignmentSchema,
  weight: z.number(),
});

// v5 phase 7a: optional MCTS-specific per-node metadata. Populated only when
// the request was dispatched to the MCTS engine (algorithm="mcts"); αβ never
// emits this field.
const McTsExtrasSchema = z.object({
  visits: z.number().int().nonnegative(),
  visitShare: z.number().min(0).max(1),
  paretoOnFrontier: z.boolean().optional(),
});

const baseTreeNode = z.object({
  championIds: z.array(z.string()),
  scores: ScoreSetSchema,
  assignmentDistribution: z.array(WeightedAssignmentSchema),
  side: SideSchema.nullable(),
  slots: z.array(z.number().int()),
  actionType: ActionTypeSchema,
  phase: PhaseSchema,
  userInjected: z.boolean(),
  mctsExtras: McTsExtrasSchema.optional(),
});
type TreeNodeShape = z.infer<typeof baseTreeNode> & {
  children: TreeNodeShape[];
};

export const TreeNodeSchema: z.ZodType<TreeNodeShape> = baseTreeNode.extend({
  children: z.lazy(() => z.array(TreeNodeSchema)),
});

const ScenarioSchema = z.object({
  name: z.string(),
  description: z.string(),
  perspective: z.enum(["robust", "likely", "off_profile"]),
  indicators: z.array(z.string()),
  scores: ScoreSetSchema.pick({
    composite: true,
    compStrength: true,
    informationValue: true,
    roleCoverage: true,
  }),
  bluePicks: z.array(z.string()),
  redPicks: z.array(z.string()),
  blueBans: z.array(z.string()),
  redBans: z.array(z.string()),
  blueLikelyAssignments: z.array(WeightedAssignmentSchema),
  redLikelyAssignments: z.array(WeightedAssignmentSchema),
  treePath: z.array(
    z.object({
      slot: z.number().int().nonnegative(),
      championIds: z.array(z.string()),
    }),
  ),
});

// v5 phase 4: optional dev-only metadata returned only when the request was
// dispatched to the experimental MCTS engine.
// v5 phase 7a: `truncated` indicates the rendered tree was capped by
// MAX_NODES during subtree_walk; defaulted to false for older snapshots.
const McTsMetaSchema = z.object({
  algorithm: z.literal("mcts"),
  iterations: z.number().int().nonnegative(),
  isExperimental: z.literal(true),
  truncated: z.boolean().default(false),
});

// Phase 7b Decision 6: `partial` marks intermediate snapshots from the
// streaming iterate loop so the frontend can distinguish them from the final
// settled result.
const ComputeMetaSchema = z.object({
  nodesEvaluated: z.number().int().nonnegative(),
  computeTimeMs: z.number().nonnegative(),
  pruningRate: z.number().min(0).max(1),
  depthReached: z.number().int().nonnegative(),
  transpositionsFound: z.number().int().nonnegative(),
  forcedBranchesDropped: z.number().int().nonnegative(),
  cancelled: z.boolean(),
  mctsMeta: McTsMetaSchema.optional(),
  partial: z.boolean().optional(),
  persistOnPause: z.boolean().optional(),
});

export const EngineResponseSchema = z.object({
  protocolVersion: z.string(),
  engineId: z.string(),
  requestId: z.string().optional(),
  tree: TreeNodeSchema,
  scenarios: z.array(ScenarioSchema),
  meta: ComputeMetaSchema,
});
export type EngineResponse = z.infer<typeof EngineResponseSchema>;
