import { z } from "zod";
import { SideSchema, PhaseSchema, ActionTypeSchema } from "./types.js";

const ScoreSetSchema = z.object({
  composite: z.number(),
  compStrength: z.number(),
  informationValue: z.number(),
  flexRetention: z.number(),
  revealCost: z.number(),
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

const baseTreeNode = z.object({
  championIds: z.array(z.string()),
  scores: ScoreSetSchema,
  assignmentDistribution: z.array(WeightedAssignmentSchema),
  side: SideSchema.nullable(),
  slots: z.array(z.number().int()),
  actionType: ActionTypeSchema,
  phase: PhaseSchema,
  userInjected: z.boolean(),
});
type TreeNodeShape = z.infer<typeof baseTreeNode> & { children: TreeNodeShape[] };

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
  }),
  bluePicks: z.array(z.string()),
  redPicks: z.array(z.string()),
  blueBans: z.array(z.string()),
  redBans: z.array(z.string()),
  likelyAssignments: z.array(WeightedAssignmentSchema),
  treePath: z.array(
    z.object({
      slot: z.number().int().nonnegative(),
      championIds: z.array(z.string()),
    }),
  ),
});

const ComputeMetaSchema = z.object({
  nodesEvaluated: z.number().int().nonnegative(),
  computeTimeMs: z.number().nonnegative(),
  pruningRate: z.number().min(0).max(1),
  depthReached: z.number().int().nonnegative(),
  transpositionsFound: z.number().int().nonnegative(),
  forcedBranchesDropped: z.number().int().nonnegative(),
  cancelled: z.boolean(),
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
