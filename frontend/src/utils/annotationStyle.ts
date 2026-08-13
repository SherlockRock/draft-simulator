import type { AnnotationColor, AnnotationFontSize } from "./schemas";

/** Font presets in world-space pixels, before the canvas zoom transform. */
export const ANNOTATION_FONT_PX: Record<AnnotationFontSize, number> = {
    sm: 14,
    md: 20,
    lg: 32,
    xl: 56
};

/**
 * Complete static class literals keep every palette surface visible to
 * Tailwind's scanner. `none` deliberately has neither chrome nor a fill.
 */
const SURFACE_CLASSES: Record<AnnotationColor, string> = {
    none: "bg-transparent border-transparent",
    slate: "bg-slate-800/90 border-slate-500/60",
    purple: "bg-purple-900/40 border-purple-500/60",
    teal: "bg-teal-900/40 border-teal-500/60",
    amber: "bg-amber-900/40 border-amber-500/60",
    crimson: "bg-red-900/40 border-red-500/60",
    emerald: "bg-emerald-900/40 border-emerald-500/60"
};

export const annotationSurfaceClass = (color: AnnotationColor): string =>
    SURFACE_CLASSES[color];

export const ANNOTATION_COLOR_OPTIONS: {
    value: AnnotationColor;
    label: string;
    swatchClass: string;
}[] = [
    { value: "none", label: "None", swatchClass: "bg-transparent border-slate-500" },
    { value: "slate", label: "Slate", swatchClass: "bg-slate-700" },
    { value: "purple", label: "Purple", swatchClass: "bg-purple-600" },
    { value: "teal", label: "Teal", swatchClass: "bg-teal-600" },
    { value: "amber", label: "Amber", swatchClass: "bg-amber-600" },
    { value: "crimson", label: "Crimson", swatchClass: "bg-red-600" },
    { value: "emerald", label: "Emerald", swatchClass: "bg-emerald-600" }
];

export const ANNOTATION_FONT_OPTIONS: {
    value: AnnotationFontSize;
    label: string;
}[] = [
    { value: "sm", label: "Small" },
    { value: "md", label: "Medium" },
    { value: "lg", label: "Large" },
    { value: "xl", label: "Huge" }
];
