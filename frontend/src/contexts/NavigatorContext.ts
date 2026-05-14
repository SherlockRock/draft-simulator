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

/** v5 phase 4: optional MCTS-only per-node metadata. Populated only when the
 *  current snapshot was produced by the experimental MCTS engine. αβ never
 *  emits this.
 *  v5 phase 7a: `paretoOnFrontier` set when the node sits on its sibling
 *  Pareto frontier across (winrate, coverage, flex). Absent or false → no
 *  marker. */
export interface NavigatorMctsExtras {
    visits: number;
    visitShare: number;
    paretoOnFrontier?: boolean;
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
    mctsExtras?: NavigatorMctsExtras;
}

/** Content-addressed path step matching `engine-protocol`'s `PathStep`.
 *  See spec § "Engine Protocol → treePath": each step identifies a hop by the
 *  `(slot, championIds)` tuple of the child node, not by sibling index. */
export interface NavigatorScenarioPathStep {
    slot: number;
    championIds: string[];
}

export interface NavigatorScenario {
    name: string;
    scores: Pick<NavigatorScoreSet, "composite" | "compStrength" | "informationValue">;
    description: string;
    bluePicks: string[];
    redPicks: string[];
    blueBans: string[];
    redBans: string[];
    blueLikelyAssignments: NavigatorWeightedAssignment[];
    redLikelyAssignments: NavigatorWeightedAssignment[];
    treePath: NavigatorScenarioPathStep[];
    perspective: "robust" | "likely" | "off_profile";
    indicators: string[];
}

export interface NavigatorCompletedGame {
    draft: NavigatorDraftData;
    events: NavigatorEventData[];
    snapshot: NavigatorSnapshotData | null;
}

export interface NavigatorSessionState {
    session: NavigatorSessionData | null;
    draft: NavigatorDraftData | null;
    events: NavigatorEventData[];
    snapshot: NavigatorSnapshotData | null;
    completedGames: NavigatorCompletedGame[];
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
    series_length: 1 | 3 | 5 | 7;
    side_swap_mode: "auto" | "manual";
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
    our_side_override: "blue" | "red" | null;
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

/** v5 phase 4: optional metadata returned only when the snapshot was produced
 *  by the experimental MCTS engine. UI uses `algorithm` to decide whether to
 *  render the MCTS banner / per-node visit annotations.
 *  v5 phase 7a: `truncated` indicates the rendered tree was capped by
 *  MAX_NODES during subtree_walk; defaults to false. */
export interface NavigatorMctsMeta {
    algorithm: "mcts";
    iterations: number;
    isExperimental: true;
    truncated: boolean;
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
        mctsMeta?: NavigatorMctsMeta;
        partial?: boolean;
        rootPath?: string[][];
    } | null;
    createdAt: string;
}

export interface NavigatorPanRequest {
    path: number[];
}

export interface NodeLayoutOverride {
    /** Override angle in radians (radial coordinate, before the -π/2 rotation). */
    angle: number;
}

export type NavigatorAlgorithm = "ab" | "mcts";

export interface NavigatorWorkflowContextValue {
    navigatorContext: Accessor<NavigatorSessionState>;
    /** v5 phase 4: dev-only experimental MCTS toggle. False in production
     *  (env var unset on backend). When false, the toggle is hidden. */
    engineToggleEnabled: Accessor<boolean>;
    currentAlgorithm: Accessor<NavigatorAlgorithm>;
    setAlgorithm: (algorithm: NavigatorAlgorithm) => void;
    syntheticTree: Accessor<NavigatorTreeNode | null>;
    isComputing: Accessor<boolean>;
    joinSession: (sessionId: string) => void;
    leaveSession: () => void;
    emitPick: (draftId: string, championId: string, slot: number) => void;
    emitBan: (draftId: string, championId: string, slot: number) => void;
    emitUndo: (draftId: string) => void;
    startDraft: () => void;
    nextGame: () => void;
    startNextGame: (ourSideOverride?: "blue" | "red") => void;
    updateSessionPools: (bluePool: TeamPool, redPool: TeamPool) => void;
    viewingGameNumber: Accessor<number | null>;
    viewGame: (gameNumber: number | null) => void;
    selectedScenarioIndex: Accessor<number | null>;
    setSelectedScenarioIndex: (index: number | null) => void;
    panRequest: Accessor<NavigatorPanRequest | null>;
    setPanRequest: (request: NavigatorPanRequest | null) => void;
    requestScenarioPan: (treePath: NavigatorScenarioPathStep[]) => void;
    manualExpansionKeys: Accessor<ReadonlySet<string>>;
    manualCollapseKeys: Accessor<ReadonlySet<string>>;
    setManualExpansionKeys: (
        updater: (prev: ReadonlySet<string>) => ReadonlySet<string>
    ) => void;
    setManualCollapseKeys: (
        updater: (prev: ReadonlySet<string>) => ReadonlySet<string>
    ) => void;
    layoutOverrides: Accessor<ReadonlyMap<string, NodeLayoutOverride>>;
    setLayoutOverride: (nodeKey: string, override: NodeLayoutOverride | null) => void;
    clearAllLayoutOverrides: () => void;
    swapChampion: (params: {
        path: { slot: number; championIds: string[] }[];
        targetSlot: number;
        newChampionId: string;
    }) => void;
    createBranch: (params: {
        path: { slot: number; championIds: string[] }[];
        targetSlot: number;
        newChampionId: string;
    }) => void;
}

export const NavigatorWorkflowContext = createContext<NavigatorWorkflowContextValue>();

export function useNavigatorContext() {
    const ctx = useContext(NavigatorWorkflowContext);
    if (!ctx) {
        throw new Error("useNavigatorContext must be used within NavigatorWorkflow");
    }
    return ctx;
}
