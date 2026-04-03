import { CanvasDraft, Connection, CanvasGroup, Viewport } from "./schemas";
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
            drafts: parsed.drafts ?? [],
            connections: parsed.connections ?? [],
            groups: parsed.groups ?? [],
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
        viewport: { x: 0, y: 0, zoom: 1 },
        createdAt: new Date().toISOString()
    };
};

export const hasLocalCanvas = (): boolean => {
    return localStorage.getItem(STORAGE_KEY) !== null;
};

export const isLocalCanvasEmpty = (): boolean => {
    const canvas = getLocalCanvas();
    if (!canvas) return true;
    const hasContent = canvas.drafts.length > 0 || canvas.groups.length > 0;
    const wasRenamed = canvas.name !== "My Canvas";
    return !hasContent && !wasRenamed;
};
