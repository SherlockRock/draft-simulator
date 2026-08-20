import {
    CanvasAnnotation,
    CanvasDraft,
    CanvasPoolPlacement,
    Connection,
    CanvasGroup,
    Viewport
} from "./schemas";
import { DEFAULT_CARD_LAYOUT } from "./canvasCardLayout";
import type { CardLayout } from "./canvasCardLayout";

const STORAGE_KEY = "draft-sim:local-canvas";

export type LocalCanvas = {
    name: string;
    description: string;
    icon: string;
    cardLayout: CardLayout;
    drafts: CanvasDraft[];
    connections: Connection[];
    groups: CanvasGroup[];
    annotations: CanvasAnnotation[];
    pools: CanvasPoolPlacement[];
    viewport: Viewport;
    createdAt: string;
};

export const getLocalCanvas = (): LocalCanvas | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<LocalCanvas>;
        return {
            name: parsed.name ?? "My Canvas",
            description: parsed.description ?? "",
            icon: parsed.icon ?? "",
            cardLayout: parsed.cardLayout ?? "vertical",
            // Canvases saved before Cards carried a top-level draft_id have to
            // be backfilled on read: the store reconciles keyed on draft_id, and
            // a legacy Card would key on `undefined`.
            drafts: (parsed.drafts ?? []).map((d) =>
                d.draft_id ? d : { ...d, draft_id: d.Draft.id }
            ),
            connections: parsed.connections ?? [],
            groups: parsed.groups ?? [],
            annotations: parsed.annotations ?? [],
            // Canvases saved before pools existed have no `pools` key at all;
            // a canvas saved by an earlier build of THIS feature can have the
            // key but a pool missing `version` (PoolSchema.version is
            // required — an unbackfilled row would feed the version-guard
            // garbage downstream).
            pools: (parsed.pools ?? []).map((pool) => ({
                ...pool,
                Pool: { ...pool.Pool, version: pool.Pool.version ?? 0 }
            })),
            viewport: parsed.viewport ?? { x: 0, y: 0, zoom: 1 },
            createdAt: parsed.createdAt ?? new Date().toISOString()
        };
    } catch {
        return null;
    }
};

export const saveLocalCanvas = (canvas: LocalCanvas): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(canvas));
};

export const clearLocalCanvas = (): void => {
    localStorage.removeItem(STORAGE_KEY);
};

export const createEmptyLocalCanvas = (
    name: string,
    description?: string,
    icon?: string,
    cardLayout?: CardLayout
): LocalCanvas => {
    return {
        name,
        description: description ?? "",
        icon: icon ?? "",
        cardLayout: cardLayout ?? DEFAULT_CARD_LAYOUT,
        drafts: [],
        connections: [],
        groups: [],
        annotations: [],
        pools: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: new Date().toISOString()
    };
};

/**
 * The stored local canvas as the canvas RESOURCE shape the views consume.
 *
 * Extracted because this mapping had already rotted: the anonymous canvas
 * resource carried a hardcoded `annotations: []` while every sibling field read
 * from `local`, so a local canvas painted no notes until some later mutation
 * happened to call `refreshFromLocal`. The notes were never lost — the write
 * path was fine — but on reload they were simply not read back. The second copy
 * of this mapping, after creating a draft, omitted the key entirely and did the
 * same thing.
 *
 * One mapper, one test, one call site each. A field added to `LocalCanvas` and
 * forgotten here now fails a test rather than silently rendering as empty.
 */
export const localCanvasResource = (canvas: LocalCanvas) => ({
    id: "local" as const,
    name: canvas.name,
    description: canvas.description ?? null,
    icon: canvas.icon ?? null,
    cardLayout: canvas.cardLayout ?? DEFAULT_CARD_LAYOUT,
    drafts: canvas.drafts,
    annotations: canvas.annotations,
    pools: canvas.pools,
    connections: canvas.connections,
    groups: canvas.groups,
    lastViewport: canvas.viewport,
    userPermissions: "admin" as const
});

export const hasLocalCanvas = (): boolean => {
    return localStorage.getItem(STORAGE_KEY) !== null;
};

export const isLocalCanvasEmpty = (): boolean => {
    const canvas = getLocalCanvas();
    if (!canvas) return true;
    // Data-loss gate: sync returns null when this says empty, after which the
    // caller clears localStorage. An annotation-only canvas is real content.
    const hasContent =
        canvas.drafts.length > 0 ||
        canvas.groups.length > 0 ||
        canvas.annotations.length > 0 ||
        canvas.pools.length > 0;
    const wasRenamed = canvas.name !== "My Canvas";
    return !hasContent && !wasRenamed;
};
