import { z } from "zod";

/** Client → server: user clicked Stop. */
export const NavigatorStopComputeRequestSchema = z.object({
  sessionId: z.string(),
});
export type NavigatorStopComputeRequest = z.infer<typeof NavigatorStopComputeRequestSchema>;
