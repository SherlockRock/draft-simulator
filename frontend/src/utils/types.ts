// =============================================================================
// UI-only types (not from API, no Zod schema needed)
// These types are used purely for frontend UI state and have no API representation
// =============================================================================

export type CanvasDraft = {
    positionX: number;
    positionY: number;
    is_locked?: boolean;
    group_id?: string | null;
    source_type?: "canvas" | "versus";
    Draft: {
        name: string;
        id: string;
        picks: string[];
        type: "canvas" | "versus";
        versus_draft_id?: string;
        seriesIndex?: number;
        completed?: boolean;
        winner?: "blue" | "red" | null;
        blueSideTeam?: 1 | 2;
        firstPick?: "blue" | "red";
    };
};

import type { VersusDraft, VersusParticipant } from "./schemas";

export type AnchorPoint = {
    type: "top" | "bottom" | "left" | "right";
};

export type AnchorPosition = {
    x: number;
    y: number;
};

export type ContextMenuAction = {
    label: string;
    action: () => void;
    destructive?: boolean;
};

export type ContextMenuPosition = {
    x: number; // Screen coordinates
    y: number; // Screen coordinates
};

export type ChatMessage = {
    username: string;
    role: "blue_captain" | "red_captain" | "spectator";
    message: string;
    timestamp: number;
};

export type VersusPickOrderItem = {
    team: "blue" | "red";
    type: "ban" | "pick";
    slot: number;
};

export type VersusSessionState = {
    versusDraft: VersusDraft | null;
    participants: VersusParticipant[];
    myParticipant: VersusParticipant | null;
    connected: boolean;
    error: string | null;
};
