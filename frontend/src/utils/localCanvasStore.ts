import { CanvasDraft, Connection, CanvasGroup, Viewport } from "./schemas";

const STORAGE_KEY = "draft-sim:local-canvas";

export type LocalCanvas = {
    name: string;
    description: string;
    icon: string;
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
        return JSON.parse(raw) as LocalCanvas;
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

export const createEmptyLocalCanvas = (name: string, description?: string, icon?: string): LocalCanvas => {
    return {
        name,
        description: description ?? "",
        icon: icon ?? "",
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
