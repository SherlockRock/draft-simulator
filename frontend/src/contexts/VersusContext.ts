import { createContext, useContext } from "solid-js";
import { Socket } from "socket.io-client";
import { Draft } from "../utils/schemas";
import { VersusSessionState, ChatMessage } from "../utils/types";

// Pick change request type
export type PickChangeRequest = {
    requestId: string;
    team: "blue" | "red";
    pickIndex: number;
    oldChampion: string;
    newChampion: string;
} | null;

// Draft-specific state types for callback registration pattern
export type ActiveDraftState = {
    draftId: string;
    currentPickIndex: number;
    timerStartedAt: number | null;
    isPaused: boolean;
    readyStatus: { blue: boolean; red: boolean };
    completed: boolean;
    winner?: "blue" | "red" | null;
    draft: Draft;
};

export type DraftCallbacks = {
    handlePause: () => void;
    handleReady: () => void;
    handleUnready: () => void;
    handleLockIn: () => void;
    isMyTurn: () => boolean;
    hasPendingPick: () => boolean;
    draftStarted: () => boolean;
    // Pick change functionality
    handleRequestPickChange: (pickIndex: number, newChampion: string) => void;
    handleApprovePickChange: (requestId: string) => void;
    handleRejectPickChange: (requestId: string) => void;
    pendingPickChangeRequest: () => PickChangeRequest;
};

// Versus workflow context type definition
export type VersusWorkflowContextValue = {
    versusContext: () => VersusSessionState;
    selectRole: (role: "blue_captain" | "red_captain" | "spectator") => void;
    leaveSession: () => void;
    releaseRole: () => void;
    socket: () => Socket | undefined;

    // Draft-specific state registration
    activeDraftState: () => ActiveDraftState | null;
    registerDraftState: (state: ActiveDraftState) => void;
    unregisterDraftState: () => void;

    // Draft control callbacks
    draftCallbacks: () => DraftCallbacks | null;
    registerDraftCallbacks: (callbacks: DraftCallbacks) => void;
    unregisterDraftCallbacks: () => void;

    // Chat state (lifted to context to persist across FlowPanel open/close)
    chatMessages: () => ChatMessage[];
    addChatMessage: (message: ChatMessage) => void;
    chatUserCount: () => number;

    // Winner reporting with optimistic update
    reportWinner: (draftId: string, winner: "blue" | "red") => void;

    // Game settings (first pick, side assignment)
    setGameSettings: (
        draftId: string,
        settings: { firstPick?: "blue" | "red"; blueSideTeam?: 1 | 2 }
    ) => void;

    // Team identity tracking for per-game role re-prompt
    myTeamIdentity: () => string | null;

    // Per-game role confirmation tracking
    isNewGame: (draftId: string) => boolean;
    confirmGameRole: (draftId: string) => void;
};

export const VersusWorkflowContext = createContext<VersusWorkflowContextValue>();

export const useVersusContext = () => {
    const context = useContext(VersusWorkflowContext);
    if (!context) {
        throw new Error("useVersusContext must be used within VersusWorkflow");
    }
    return context;
};
