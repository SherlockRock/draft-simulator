import { describe, expect, it } from "vitest";
import { AnnotationColorSchema, AnnotationFontSizeSchema } from "./schemas";
import { ANNOTATION_COLOR_OPTIONS, ANNOTATION_FONT_OPTIONS } from "./annotationStyle";

describe("annotation style options", () => {
    it("offers every annotation colour exactly once", () => {
        expect(ANNOTATION_COLOR_OPTIONS.map((option) => option.value).sort()).toEqual(
            AnnotationColorSchema.options.slice().sort()
        );
    });

    it("offers every annotation font size exactly once", () => {
        expect(ANNOTATION_FONT_OPTIONS.map((option) => option.value).sort()).toEqual(
            AnnotationFontSizeSchema.options.slice().sort()
        );
    });
});
