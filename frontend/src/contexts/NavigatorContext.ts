import { createContext, useContext, Accessor } from "solid-js";
import type { TeamPool } from "@draft-sim/shared-types";

export interface NavigatorScoreSet {
    composite: number;
    compStrength: number;
    informationValue: number;
    flexRetention: number;
    revealCost: number;
}

export interface NavigatorRoleAssignment {
    TOP: string;
    JUNGLE: string;
    MIDDLE: string;
    ADC: string;
    SUPPORT: string;
}

export interface NavigatorWeightedAssignment {
    assignment: NavigatorRoleAssignment;
    weight: number;
}

export interface NavigatorTreeNode {
    championIds: string[];
    actionType: "ban" | "pick";
    phase: "ban1" | "pick1" | "ban2" | "pick2";
    scores: NavigatorScoreSet;
    assignmentDistribution: NavigatorWeightedAssignment[];
    side: "blue" | "red" | null;
    slots: number[];
    userInjected: boolean;
    children: NavigatorTreeNode[];
    /** Subset of championIds locked in by a confirmed event.
     *  Used for pair-pending rendering: one of the pair's champions is confirmed,
     *  the other is still projected. Undefined or empty means all champions are
     *  projected (or the node is on the spine where everything is confirmed by
     *  position). */
    confirmedChampionIds?: string[];
}

export interface NavigatorScenario {
    name: string;
    scores: Pick<NavigatorScoreSet, "composite" | "compStrength" | "informationValue">;
    description: string;
    bluePicks: string[];
    likelyAssignments: NavigatorWeightedAssignment[];
    redPicks: string[];
    blueBans: string[];
    redBans: string[];
    treePath: number[];
    perspective: "robust" | "likely" | "off_profile";
    indicators: string[];
}

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
    blue_pool: TeamPool;
    red_pool: TeamPool;
    opponent_pool: string[] | null;
    draft_mode: "standard" | "fearless" | "ironman";
    status: "setup" | "active" | "completed";
    config_version: number;
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
    tree: NavigatorTreeNode;
    scenarios: NavigatorScenario[];
    meta: {
        nodesEvaluated: number;
        computeTimeMs: number;
        pruningRate: number;
        depthReached: number;
        transpositionsFound: number;
    } | null;
    createdAt: string;
}

export interface NavigatorPanRequest {
    path: number[];
}

export interface NavigatorWorkflowContextValue {
    navigatorContext: Accessor<NavigatorSessionState>;
    syntheticTree: Accessor<NavigatorTreeNode | null>;
    isComputing: Accessor<boolean>;
    joinSession: (sessionId: string) => void;
    leaveSession: () => void;
    emitPick: (draftId: string, championId: string, slot: number) => void;
    emitBan: (draftId: string, championId: string, slot: number) => void;
    emitUndo: (draftId: string) => void;
    startDraft: () => void;
    nextGame: () => void;
    selectedScenarioIndex: Accessor<number | null>;
    setSelectedScenarioIndex: (index: number | null) => void;
    panRequest: Accessor<NavigatorPanRequest | null>;
    setPanRequest: (request: NavigatorPanRequest | null) => void;
    requestScenarioPan: (treePath: number[]) => void;
    manualExpansionKeys: Accessor<ReadonlySet<string>>;
    manualCollapseKeys: Accessor<ReadonlySet<string>>;
    setManualExpansionKeys: (
        updater: (prev: ReadonlySet<string>) => ReadonlySet<string>
    ) => void;
    setManualCollapseKeys: (
        updater: (prev: ReadonlySet<string>) => ReadonlySet<string>
    ) => void;
}

export const NavigatorWorkflowContext = createContext<NavigatorWorkflowContextValue>();

export function useNavigatorContext() {
    const ctx = useContext(NavigatorWorkflowContext);
    if (!ctx) {
        throw new Error("useNavigatorContext must be used within NavigatorWorkflow");
    }
    return ctx;
}
