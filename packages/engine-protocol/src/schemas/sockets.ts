import { z } from "zod";

/**
 * Client → server: extend the active root by the delta in `rerootStep`.
 * `rerootStep` is delta-relative to the current active root (Decision 7);
 * the authoritative cumulative path comes back on `snapshot.meta.rootPath`.
 */
export const NavigatorRerootRequestSchema = z.object({
  sessionId: z.string(),
  draftId: z.string(),
  rerootId: z.number().int().nonnegative(),
  rerootStep: z.array(z.array(z.string())),
});
export type NavigatorRerootRequest = z.infer<typeof NavigatorRerootRequestSchema>;

/** Client → server: user clicked Stop. */
export const NavigatorStopComputeRequestSchema = z.object({
  sessionId: z.string(),
});
export type NavigatorStopComputeRequest = z.infer<typeof NavigatorStopComputeRequestSchema>;

/**
 * Server → client: reroot rejected (e.g., path doesn't match an existing child
 * of the current active root). Frontend rolls back the optimistic update for
 * the matching `rerootId`.
 */
export const NavigatorRerootErrorSchema = z.object({
  sessionId: z.string(),
  draftId: z.string(),
  rerootId: z.number().int().nonnegative(),
  attemptedPath: z.array(z.array(z.string())),
  error: z.string(),
});
export type NavigatorRerootError = z.infer<typeof NavigatorRerootErrorSchema>;
