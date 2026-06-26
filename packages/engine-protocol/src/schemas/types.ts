import { z } from "zod";

export const SideSchema = z.enum(["blue", "red"]);
export type Side = z.infer<typeof SideSchema>;

export const PhaseSchema = z.enum(["ban1", "pick1", "ban2", "pick2"]);
export type Phase = z.infer<typeof PhaseSchema>;

export const ActionTypeSchema = z.enum(["ban", "pick"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const RoleSchema = z.enum(["TOP", "JUNGLE", "MIDDLE", "ADC", "SUPPORT"]);
export type Role = z.infer<typeof RoleSchema>;

export const RolePoolMapSchema = z.object({
  TOP: z.array(z.string()),
  JUNGLE: z.array(z.string()),
  MIDDLE: z.array(z.string()),
  ADC: z.array(z.string()),
  SUPPORT: z.array(z.string()),
});

export const TeamPoolSchema = z.object({
  display: RolePoolMapSchema,
  search: z.array(z.string()),
});
