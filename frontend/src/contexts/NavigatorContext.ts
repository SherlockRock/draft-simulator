import { createContext, useContext, Accessor } from "solid-js";

export interface NavigatorSessionState {
    session: NavigatorSessionData | null;
    draft: NavigatorDraftData | null;
    events: NavigatorEventData[];
    snapshot: NavigatorSnapshotData | null;
    connected: boolean;
    error: string | null;
}

export interface NavigatorSessionData {
    id: string;
    name: string | null;
    user_id: string;
    our_side: "blue" | "red";
    display_pool: string[];
    search_pool: string[];
    opponent_pool: string[] | null;
    fearless: boolean;
    status: "setup" | "active" | "completed";
    NavigatorDrafts?: NavigatorDraftData[];
    createdAt: string;
    updatedAt: string;
}

export interface NavigatorDraftData {
    id: string;
    session_id: string;
    game_number: number;
    status: "active" | "completed";
    draft_id: string | null;
}

export interface NavigatorEventData {
    id: string;
    navigator_draft_id: string;
    event_type: "ban" | "pick" | "what_if_pick" | "what_if_ban" | "engine_result";
    slot: number;
    side: "blue" | "red";
    champion_id: string;
    user_injected: boolean;
    createdAt: string;
}

export interface NavigatorSnapshotData {
    id: string;
    navigator_draft_id: string;
    after_event_id: string | null;
    tree: unknown;
    scenarios: unknown[];
    meta: {
        nodesEvaluated: number;
        computeTimeMs: number;
        pruningRate: number;
        depthReached: number;
        transpositionsFound: number;
    } | null;
    createdAt: string;
}

export interface NavigatorWorkflowContextValue {
    navigatorContext: Accessor<NavigatorSessionState>;
    joinSession: (sessionId: string) => void;
    leaveSession: () => void;
    emitPick: (draftId: string, championId: string, slot: number) => void;
    emitBan: (draftId: string, championId: string, slot: number) => void;
    emitUndo: (draftId: string) => void;
    startDraft: () => void;
    nextGame: () => void;
}

export const NavigatorWorkflowContext =
    createContext<NavigatorWorkflowContextValue>();

export function useNavigatorContext() {
    const ctx = useContext(NavigatorWorkflowContext);
    if (!ctx) {
        throw new Error("useNavigatorContext must be used within NavigatorWorkflow");
    }
    return ctx;
}
