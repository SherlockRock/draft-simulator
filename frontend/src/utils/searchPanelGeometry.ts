import { z } from "zod";

export type PanelGeometry = { x: number; y: number; width: number; height: number };

/**
 * R8 minimum, restated as max(row, header-with-wrapping): one uncompromised
 * full-draft row wide (10 24px icons + gaps + padding ≈ 330px, plus breathing
 * room) × query header + one row tall. Rows are never compromised to fit the
 * panel — the panel grows, not the row. The query header is WIDER than the
 * row when on one line (champion w-52 + team w-44 + opponent w-44 + gaps ≈
 * 576px + panel padding/border ≈ 602px), so the header section must
 * flex-wrap below that — the min width is row-driven, the header stacks. The
 * min HEIGHT is derived from the worst-case wrapped header (~280px: panel
 * header + three stacked selects + scope chips + record strip + bucket chips)
 * plus one full row (~100px). The DEFAULT width is the one-line header plus a
 * hair of slack — no dead space right of the opponent select.
 */
export const SEARCH_PANEL_MIN_WIDTH = 400;
export const SEARCH_PANEL_MIN_HEIGHT = 380;
export const SEARCH_PANEL_DEFAULT_WIDTH = 608;
const PANEL_MARGIN = 8;
const STORAGE_KEY = "firstpick:canvas:search-panel";

const PanelGeometrySchema = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
});

export const clampPanelGeometry = (
    geometry: PanelGeometry,
    containerWidth: number,
    containerHeight: number
): PanelGeometry => {
    const maxWidth = Math.max(containerWidth - PANEL_MARGIN * 2, SEARCH_PANEL_MIN_WIDTH);
    const maxHeight = Math.max(
        containerHeight - PANEL_MARGIN * 2,
        SEARCH_PANEL_MIN_HEIGHT
    );
    const width = Math.min(Math.max(geometry.width, SEARCH_PANEL_MIN_WIDTH), maxWidth);
    const height = Math.min(
        Math.max(geometry.height, SEARCH_PANEL_MIN_HEIGHT),
        maxHeight
    );
    const maxX = Math.max(containerWidth - width - PANEL_MARGIN, PANEL_MARGIN);
    const maxY = Math.max(containerHeight - height - PANEL_MARGIN, PANEL_MARGIN);
    const x = Math.min(Math.max(geometry.x, PANEL_MARGIN), maxX);
    const y = Math.min(Math.max(geometry.y, PANEL_MARGIN), maxY);
    return { x, y, width, height };
};

export const defaultPanelGeometry = (
    containerWidth: number,
    containerHeight: number
): PanelGeometry =>
    clampPanelGeometry(
        {
            x: containerWidth - SEARCH_PANEL_DEFAULT_WIDTH - 24,
            y: 24,
            width: SEARCH_PANEL_DEFAULT_WIDTH,
            height: Math.round(containerHeight * 0.6)
        },
        containerWidth,
        containerHeight
    );

export const loadPanelGeometry = (
    containerWidth: number,
    containerHeight: number
): PanelGeometry => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
        try {
            const parsed = PanelGeometrySchema.safeParse(JSON.parse(raw));
            if (parsed.success) {
                return clampPanelGeometry(parsed.data, containerWidth, containerHeight);
            }
        } catch {
            // Corrupt JSON degrades to the default position.
        }
    }
    return defaultPanelGeometry(containerWidth, containerHeight);
};

export const savePanelGeometry = (geometry: PanelGeometry): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(geometry));
};
