import type { JSX } from "solid-js";
import type { VersusDraft, VersusParticipant } from "./schemas";

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

/**
 * A row that renders its own content instead of a label button. `close` is the
 * same closer the text rows get, handed in so a swatch click dismisses the menu
 * exactly like an action row does rather than re-plumbing it in every caller.
 */
export type ContextMenuCustomRow = {
    render: (close: () => void) => JSX.Element;
};

export type ContextMenuEntry = ContextMenuAction | ContextMenuCustomRow;

export type ContextMenuPosition = {
    x: number; // Screen coordinates
    y: number; // Screen coordinates
};

export type ChatMessage = {
    username: string;
    role: "team1_captain" | "team2_captain" | "spectator";
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
