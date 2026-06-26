import { z } from "zod";

export const PROTOCOL_VERSION = "1.1.0";

export const ErrorCodeSchema = z.enum([
  "engine.cancelled",
  "engine.timeout",
  "engine.invalid_input",
  "engine.internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const EngineErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  path: z.array(z.string()).optional(),
});
export type EngineError = z.infer<typeof EngineErrorSchema>;
