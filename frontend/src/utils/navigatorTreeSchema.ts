import { z } from "zod";
import type { NavigatorTreeNode } from "../contexts/NavigatorContext";

export const NavigatorScoreSetSchema = z.object({
    composite: z.number(),
    compStrength: z.number(),
    informationValue: z.number(),
    flexRetention: z.number(),
    revealCost: z.number()
});

export const NavigatorRoleAssignmentSchema = z.object({
    TOP: z.string(),
    JUNGLE: z.string(),
    MIDDLE: z.string(),
    ADC: z.string(),
    SUPPORT: z.string()
});

export const NavigatorWeightedAssignmentSchema = z.object({
    assignment: NavigatorRoleAssignmentSchema,
    weight: z.number()
});

export const NavigatorTreeNodeSchema: z.ZodType<NavigatorTreeNode> = z.lazy(() =>
    z.object({
        championIds: z.array(z.string()),
        actionType: z.enum(["ban", "pick"]),
        phase: z.enum(["ban1", "pick1", "ban2", "pick2"]),
        scores: NavigatorScoreSetSchema,
        assignmentDistribution: z.array(NavigatorWeightedAssignmentSchema),
        side: z.enum(["blue", "red"]).nullable(),
        slots: z.array(z.number()),
        userInjected: z.boolean(),
        children: z.array(NavigatorTreeNodeSchema),
        confirmedChampionIds: z.array(z.string()).optional()
    })
);
