import { z } from "zod";
import toast from "solid-toast";

/**
 * Validate incoming socket event data against a Zod schema.
 * Shows a toast and logs error on failure, returns null to signal skip.
 */
export function validateSocketEvent<T>(
    event: string,
    data: unknown,
    schema: z.ZodType<T>
): T | null {
    const result = schema.safeParse(data);
    if (!result.success) {
        toast.error("Something went wrong. Please try again.");
        console.error(`Socket validation failed for ${event}:`, result.error.format());
        return null;
    }
    return result.data;
}
