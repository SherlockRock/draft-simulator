import { describe, expect, it } from "vitest";
import { CanvasDraftSchema } from "./schemas";

/**
 * The canvasDrafts store reconciles keyed on draft_id (Canvas.tsx). Zod strips
 * undeclared keys, so the schema is a third place the Card's wire identity can
 * be silently dropped — alongside the server projection and the local-canvas
 * Card construction.
 */
const withoutIdentity = {
    positionX: 10,
    positionY: 20,
    group_id: null,
    Draft: { id: "d1", name: "Game 1", picks: Array(20).fill(""), type: "canvas" }
};

describe("CanvasDraftSchema identity", () => {
    it("keeps draft_id instead of stripping it", () => {
        const parsed = CanvasDraftSchema.parse({ ...withoutIdentity, draft_id: "d1" });
        expect(parsed.draft_id).toBe("d1");
    });

    it("rejects a Card with no draft_id rather than keying it on undefined", () => {
        expect(CanvasDraftSchema.safeParse(withoutIdentity).success).toBe(false);
    });
});
