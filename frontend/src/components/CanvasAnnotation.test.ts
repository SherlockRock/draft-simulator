import { describe, expect, it } from "vitest";
import { CUSTOM_GROUP_HEADER_HEIGHT } from "./CustomGroupContainer";
import { annotationRenderTop } from "./CanvasAnnotation";

describe("annotationRenderTop", () => {
    it("compensates for the custom Group content area's header offset", () => {
        expect(annotationRenderTop(120, true)).toBe(120 - CUSTOM_GROUP_HEADER_HEIGHT);
    });

    it("leaves a loose canvas annotation in world coordinates", () => {
        expect(annotationRenderTop(120, false)).toBe(120);
    });
});
