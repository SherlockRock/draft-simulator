import {
    Component,
    createSignal,
    createEffect,
    createMemo,
    onCleanup,
    untrack,
    JSX
} from "solid-js";
import { RouteSectionProps, useLocation, useParams } from "@solidjs/router";
import { z } from "zod";
import toast from "solid-toast";
import {
    NavigatorEventData,
    NavigatorPanRequest,
    NavigatorScenario,
    NavigatorSessionState,
    NavigatorTreeNode,
    NavigatorWorkflowContext,
    NavigatorWorkflowContextValue
} from "../contexts/NavigatorContext";
import {
    NavigatorSocketProvider,
    useNavigatorSocket
} from "../providers/NavigatorSocketProvider";
import { draftEventsToState } from "../utils/draftEventsToState";
import {
    pathIndicesToNodeKeyPath,
    eventsToConfirmedTurns,
    extendSpineOptimistic,
    includeConfirmedDraftStateForScenarios,
    mergeEngineTree,
    pruneInvalidProjection,
    remapScenariosSpine,
    synthesizeFullTree
} from "../utils/treeReconcile";
import type { ConfirmedTurn, ReconcilePriority } from "../utils/treeReconcile";
import { validateSocketEvent } from "../utils/socketValidation";
import { Socket } from "socket.io-client";

const NavigatorDraftDataSchema = z.object({
    id: z.string(),
    session_id: z.string(),
    game_number: z.number(),
    status: z.enum(["active", "completed"]),
    draft_id: z.string().nullable()
});

const NavigatorSessionDataSchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    user_id: z.string(),
    our_side: z.enum(["blue", "red"]),
    display_pool: z.array(z.string()),
    search_pool: z.array(z.string()),
    opponent_pool: z.array(z.string()).nullable(),
    fearless: z.boolean(),
    status: z.enum(["setup", "active", "completed"]),
    NavigatorDrafts: z.array(NavigatorDraftDataSchema).optional(),
    createdAt: z.string(),
    updatedAt: z.string()
});

const NavigatorEventDataSchema = z.object({
    id: z.string(),
    navigator_draft_id: z.string(),
    event_type: z.enum(["ban", "pick", "what_if_pick", "what_if_ban", "engine_result"]),
    slot: z.number(),
    side: z.enum(["blue", "red"]),
    champion_id: z.string(),
    user_injected: z.boolean(),
    createdAt: z.string()
});

const NavigatorScoreSetSchema = z.object({
    composite: z.number(),
    compStrength: z.number(),
    informationValue: z.number(),
    flexRetention: z.number(),
    revealCost: z.number()
});

const NavigatorRoleAssignmentSchema = z.object({
    TOP: z.string(),
    JUNGLE: z.string(),
    MIDDLE: z.string(),
    ADC: z.string(),
    SUPPORT: z.string()
});

const NavigatorWeightedAssignmentSchema = z.object({
    assignment: NavigatorRoleAssignmentSchema,
    weight: z.number()
});

const NavigatorTreeNodeSchema: z.ZodType<NavigatorTreeNode> = z.lazy(() =>
    z.object({
        championIds: z.array(z.string()),
        actionType: z.enum(["ban", "pick"]),
        phase: z.enum(["ban1", "pick1", "ban2", "pick2"]),
        scores: NavigatorScoreSetSchema,
        assignmentDistribution: z.array(NavigatorWeightedAssignmentSchema),
        side: z.enum(["blue", "red"]).nullable(),
        slots: z.array(z.number()),
        userInjected: z.boolean(),
        children: z.array(NavigatorTreeNodeSchema)
    })
);

const NavigatorScenarioSchema: z.ZodType<NavigatorScenario> = z.object({
    name: z.string(),
    scores: z.object({
        composite: z.number(),
        compStrength: z.number(),
        informationValue: z.number()
    }),
    description: z.string(),
    bluePicks: z.array(z.string()),
    likelyAssignments: z.array(NavigatorWeightedAssignmentSchema),
    redPicks: z.array(z.string()),
    blueBans: z.array(z.string()),
    redBans: z.array(z.string()),
    treePath: z.array(z.number()),
    perspective: z.enum(["robust", "likely", "off_profile"]),
    indicators: z.array(z.string())
});

const NavigatorSnapshotDataSchema = z.object({
    id: z.string(),
    navigator_draft_id: z.string(),
    after_event_id: z.string().nullable(),
    tree: NavigatorTreeNodeSchema,
    scenarios: z.array(NavigatorScenarioSchema),
    meta: z
        .object({
            nodesEvaluated: z.number(),
            computeTimeMs: z.number(),
            pruningRate: z.number(),
            depthReached: z.number(),
            transpositionsFound: z.number()
        })
        .nullable(),
    createdAt: z.string()
});

const NavigatorJoinResponseSchema = z.object({
    success: z.boolean(),
    session: NavigatorSessionDataSchema.nullable().optional(),
    draft: NavigatorDraftDataSchema.nullable().optional(),
    events: z.array(NavigatorEventDataSchema).optional(),
    snapshot: NavigatorSnapshotDataSchema.nullable().optional()
});

const NavigatorDraftUpdateSchema = z.object({
    session: NavigatorSessionDataSchema.optional(),
    draft: NavigatorDraftDataSchema.nullable().optional(),
    events: z.array(NavigatorEventDataSchema).optional(),
    snapshot: NavigatorSnapshotDataSchema.nullable().optional()
});

const NavigatorErrorSchema = z.object({
    error: z.string()
});

const initialNavigatorState = (): NavigatorSessionState => ({
    session: null,
    draft: null,
    events: [],
    snapshot: null,
    connected: false,
    error: null
});

const NavigatorWorkflow: Component<RouteSectionProps> = (props) => {
    return (
        <NavigatorSocketProvider>
            <NavigatorWorkflowInner>{props.children}</NavigatorWorkflowInner>
        </NavigatorSocketProvider>
    );
};

const NavigatorWorkflowInner: Component<{ children?: JSX.Element }> = (props) => {
    const params = useParams();
    const location = useLocation();
    const {
        socket: socketAccessor,
        connectionStatus: connectionStatusAccessor,
        justReconnected,
        clearReconnected
    } = useNavigatorSocket();

    const [navigatorContext, setNavigatorContext] = createSignal<NavigatorSessionState>(
        initialNavigatorState()
    );
    const [pendingJoin, setPendingJoin] = createSignal<string | null>(null);
    const [currentSocket, setCurrentSocket] = createSignal<Socket | undefined>(undefined);
    const [currentSessionId, setCurrentSessionId] = createSignal<string | null>(null);
    const [selectedScenarioIndex, setSelectedScenarioIndex] = createSignal<number | null>(
        null
    );
    const [panRequest, setPanRequest] = createSignal<NavigatorPanRequest | null>(null);
    const [manualExpansionKeys, setManualExpansionKeysSignal] = createSignal<
        ReadonlySet<string>
    >(new Set<string>());
    const [manualCollapseKeys, setManualCollapseKeysSignal] = createSignal<
        ReadonlySet<string>
    >(new Set<string>());
    const [syntheticTreeSignal, setSyntheticTreeSignal] =
        createSignal<NavigatorTreeNode | null>(null);
    const [lastEventIdSeen, setLastEventIdSeen] = createSignal<string | null>(null);
    const isComputing = createMemo(() => {
        const ctx = navigatorContext();
        const snapshot = ctx.snapshot;
        const events = ctx.events;
        if (events.length === 0) return false;
        const latestEventId = lastEventIdSeen() ?? events[events.length - 1].id;
        if (!snapshot) return true;
        return snapshot.after_event_id !== latestEventId;
    });

    const setManualExpansionKeys = (
        updater: (prev: ReadonlySet<string>) => ReadonlySet<string>
    ) => setManualExpansionKeysSignal((prev) => updater(prev));
    const setManualCollapseKeys = (
        updater: (prev: ReadonlySet<string>) => ReadonlySet<string>
    ) => setManualCollapseKeysSignal((prev) => updater(prev));
    const requestScenarioPan = (treePath: number[]) => {
        setPanRequest({ path: treePath });
    };
    let socketWithListeners: Socket | undefined = undefined;

    const getActiveSessionId = () =>
        navigatorContext().session?.id ?? params.sessionId ?? null;

    const resetNavigatorContext = () => {
        setSyntheticTreeSignal(null);
        setLastEventIdSeen(null);
        setNavigatorContext(initialNavigatorState());
    };

    const joinSession = (sessionId: string) => {
        const sock = currentSocket();
        if (!sock || !sock.connected) {
            return;
        }

        setPendingJoin(sessionId);
        sock.emit("navigatorJoin", { sessionId });
    };

    const leaveSession = () => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (sock && sessionId) {
            sock.emit("navigatorLeave", { sessionId });
        }

        setPendingJoin(null);
        resetNavigatorContext();
    };

    const handleJoinResponse = (rawData: unknown) => {
        const response = validateSocketEvent(
            "navigatorJoinResponse",
            rawData,
            NavigatorJoinResponseSchema
        );
        if (!response) return;

        if (!response.success || !response.session) {
            resetNavigatorContext();
            setNavigatorContext((prev) => ({
                ...prev,
                error: "Failed to join navigator session"
            }));
            setPendingJoin(null);
            toast.error("Failed to join navigator session");
            return;
        }

        const confirmedTurns = eventsToConfirmedTurns(response.events ?? []);
        const draftState = draftEventsToState(response.events ?? []);
        const scenarios = response.snapshot
            ? remapScenariosSpine(
                  includeConfirmedDraftStateForScenarios(
                      response.snapshot.scenarios,
                      draftState
                  ),
                  confirmedTurns.length
              )
            : [];
        setNavigatorContext({
            session: response.session,
            draft: response.draft ?? null,
            events: response.events ?? [],
            snapshot: response.snapshot ? { ...response.snapshot, scenarios } : null,
            connected: true,
            error: null
        });
        setSyntheticTreeSignal(
            response.snapshot
                ? synthesizeFullTree(response.snapshot.tree, confirmedTurns)
                : null
        );
        setLastEventIdSeen(
            response.events && response.events.length > 0
                ? response.events[response.events.length - 1].id
                : null
        );
        setCurrentSessionId(response.session.id);
        setPendingJoin(null);
    };

    const handleDraftUpdate = (rawData: unknown) => {
        const data = validateSocketEvent(
            "navigatorDraftUpdate",
            rawData,
            NavigatorDraftUpdateSchema
        );
        if (!data) return;

        const activeSessionId = untrack(currentSessionId);
        const payloadSessionId = data.session?.id ?? data.draft?.session_id ?? null;

        if (activeSessionId && payloadSessionId && payloadSessionId !== activeSessionId) {
            return;
        }

        const prev = untrack(navigatorContext);
        const prevEvents = prev.events;
        const prevSynthetic = untrack(syntheticTreeSignal);
        const prevSnapshot = prev.snapshot;

        const nextEvents = data.events ?? prevEvents;
        const nextSnapshot = data.snapshot === undefined ? prevSnapshot : data.snapshot;

        const eventsChanged = nextEvents !== prevEvents;
        const snapshotChanged =
            nextSnapshot !== prevSnapshot && nextSnapshot !== undefined;

        let nextSynthetic = prevSynthetic;
        if (eventsChanged && prevSynthetic) {
            const newTurns = diffTurns(prevEvents, nextEvents);
            const prevSpineLength = eventsToConfirmedTurns(prevEvents).length;
            let working = prevSynthetic;
            let spineLength = prevSpineLength;
            for (const turn of newTurns) {
                working = extendSpineOptimistic(working, turn, spineLength);
                spineLength += 1;
            }
            nextSynthetic = working;
        }

        let nextScenarios = nextSnapshot?.scenarios ?? [];
        if (snapshotChanged && nextSnapshot) {
            const confirmedTurns = eventsToConfirmedTurns(nextEvents);
            const spineLength = confirmedTurns.length;
            const draftState = draftEventsToState(nextEvents);
            const priority = buildPriority(nextSynthetic, prevSnapshot);

            if (nextSynthetic) {
                const merged = mergeEngineTree(
                    nextSynthetic,
                    nextSnapshot.tree,
                    spineLength,
                    draftState,
                    priority,
                    5
                );
                nextSynthetic = pruneInvalidProjection(merged, draftState, spineLength);
            } else {
                nextSynthetic = synthesizeFullTree(nextSnapshot.tree, confirmedTurns);
            }

            nextScenarios = remapScenariosSpine(
                includeConfirmedDraftStateForScenarios(
                    nextSnapshot.scenarios,
                    draftState
                ),
                spineLength
            );
        } else if (!prevSynthetic && nextSnapshot) {
            const confirmedTurns = eventsToConfirmedTurns(nextEvents);
            const draftState = draftEventsToState(nextEvents);
            nextSynthetic = synthesizeFullTree(nextSnapshot.tree, confirmedTurns);
            nextScenarios = remapScenariosSpine(
                includeConfirmedDraftStateForScenarios(
                    nextSnapshot.scenarios,
                    draftState
                ),
                confirmedTurns.length
            );
        }

        if (nextSynthetic !== prevSynthetic) {
            setSyntheticTreeSignal(nextSynthetic);
        }

        const finalSnapshot = nextSnapshot
            ? { ...nextSnapshot, scenarios: nextScenarios }
            : prevSnapshot;

        setNavigatorContext((p) => ({
            session: data.session ?? p.session,
            draft: data.draft === undefined ? p.draft : data.draft,
            events: nextEvents,
            snapshot: finalSnapshot ?? null,
            connected: true,
            error: null
        }));

        setLastEventIdSeen(
            nextEvents.length > 0 ? nextEvents[nextEvents.length - 1].id : null
        );

        if (snapshotChanged && prevSnapshot && finalSnapshot) {
            remapSelectedScenarioIndex(prevSnapshot.scenarios, finalSnapshot.scenarios);
        }
    };

    function diffTurns(
        prevEvents: NavigatorEventData[],
        nextEvents: NavigatorEventData[]
    ): ConfirmedTurn[] {
        const prevTurns = eventsToConfirmedTurns(prevEvents);
        const nextTurns = eventsToConfirmedTurns(nextEvents);
        return nextTurns.slice(prevTurns.length);
    }

    function buildPriority(
        currentSynthetic: NavigatorTreeNode | null,
        snapshot: NavigatorSessionState["snapshot"]
    ): ReconcilePriority {
        const idx = untrack(selectedScenarioIndex);
        const selectedScenario =
            idx !== null && snapshot ? (snapshot.scenarios[idx] ?? null) : null;
        const selectedKeyPath =
            selectedScenario && currentSynthetic
                ? pathIndicesToNodeKeyPath(currentSynthetic, selectedScenario.treePath)
                : null;
        return {
            selectedScenarioKeyPath: selectedKeyPath,
            manualExpansionKeyPaths: untrack(manualExpansionKeys)
        };
    }

    function remapSelectedScenarioIndex(
        prevScenarios: NavigatorScenario[],
        nextScenarios: NavigatorScenario[]
    ) {
        const idx = untrack(selectedScenarioIndex);
        if (idx === null) return;
        const prevName = prevScenarios[idx]?.name ?? null;
        if (!prevName) {
            setSelectedScenarioIndex(null);
            return;
        }
        const newIdx = nextScenarios.findIndex((scenario) => scenario.name === prevName);
        setSelectedScenarioIndex(newIdx >= 0 ? newIdx : null);
    }

    const handleError = (rawData: unknown) => {
        const data = validateSocketEvent("navigatorError", rawData, NavigatorErrorSchema);
        if (!data) return;

        setPendingJoin(null);
        setNavigatorContext((prev) => ({
            ...prev,
            error: data.error
        }));
        toast.error(data.error);
    };

    createEffect(() => {
        const sock = socketAccessor();
        const connectionStatus = connectionStatusAccessor();

        if (!sock) {
            setCurrentSocket(undefined);
            return;
        }

        if (!sock.connected || connectionStatus !== "connected") {
            return;
        }

        setCurrentSocket(sock);

        if (socketWithListeners === sock) {
            return;
        }

        sock.on("navigatorJoinResponse", handleJoinResponse);
        sock.on("navigatorDraftUpdate", handleDraftUpdate);
        sock.on("navigatorError", handleError);

        socketWithListeners = sock;

        onCleanup(() => {
            if (socketWithListeners === sock) {
                socketWithListeners = undefined;
            }

            sock.off("navigatorJoinResponse");
            sock.off("navigatorDraftUpdate");
            sock.off("navigatorError");
        });
    });

    createEffect(() => {
        const sessionId = params.sessionId ?? null;
        const previousSessionId = untrack(currentSessionId);

        if (previousSessionId && previousSessionId !== sessionId) {
            const sock = untrack(currentSocket);
            if (sock) {
                sock.emit("navigatorLeave", { sessionId: previousSessionId });
            }

            setPendingJoin(null);
            resetNavigatorContext();
        }

        setCurrentSessionId(sessionId);
    });

    createEffect(() => {
        if (!justReconnected()) return;

        const sessionId = currentSessionId();
        if (sessionId) {
            joinSession(sessionId);
        }
        clearReconnected();
    });

    createEffect(() => {
        const sessionId = params.sessionId;
        const sock = currentSocket();
        const connectionStatus = connectionStatusAccessor();
        const context = navigatorContext();

        if (!sessionId || !sock || !sock.connected || connectionStatus !== "connected") {
            return;
        }

        if (pendingJoin() === sessionId) {
            return;
        }

        if (context.connected && context.session?.id === sessionId) {
            return;
        }

        joinSession(sessionId);
    });

    createEffect(() => {
        const isNavigatorRoute = location.pathname.startsWith("/navigator");

        if (!isNavigatorRoute && navigatorContext().connected) {
            leaveSession();
        }
    });

    const emitPick = (draftId: string, championId: string, slot: number) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorPick", {
            sessionId,
            draftId,
            championId,
            slot
        });
    };

    const emitBan = (draftId: string, championId: string, slot: number) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorBan", {
            sessionId,
            draftId,
            championId,
            slot
        });
    };

    const emitUndo = (draftId: string) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorUndo", {
            sessionId,
            draftId
        });
    };

    const startDraft = () => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorStartDraft", { sessionId });
    };

    const nextGame = () => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        sock.emit("navigatorNextGame", { sessionId });
    };

    const contextValue: NavigatorWorkflowContextValue = {
        navigatorContext,
        syntheticTree: syntheticTreeSignal,
        isComputing,
        joinSession,
        leaveSession,
        emitPick,
        emitBan,
        emitUndo,
        startDraft,
        nextGame,
        selectedScenarioIndex,
        setSelectedScenarioIndex,
        panRequest,
        setPanRequest,
        requestScenarioPan,
        manualExpansionKeys,
        manualCollapseKeys,
        setManualExpansionKeys,
        setManualCollapseKeys
    };

    return (
        <NavigatorWorkflowContext.Provider value={contextValue}>
            {props.children}
        </NavigatorWorkflowContext.Provider>
    );
};

export default NavigatorWorkflow;
