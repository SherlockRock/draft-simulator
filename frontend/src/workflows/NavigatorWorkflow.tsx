import {
    Component,
    createSignal,
    createEffect,
    createMemo,
    onCleanup,
    untrack,
    batch,
    JSX
} from "solid-js";
import { RouteSectionProps, useLocation, useParams } from "@solidjs/router";
import { z } from "zod";
import toast from "solid-toast";
import { TeamPoolSchema, type TeamPool } from "@draft-sim/shared-types";
import {
    NavigatorAlgorithm,
    NavigatorEventData,
    NavigatorPanRequest,
    NavigatorScenario,
    NavigatorScenarioPathStep,
    NavigatorSessionState,
    NavigatorSnapshotData,
    NavigatorTreeNode,
    NavigatorWorkflowContext,
    NavigatorWorkflowContextValue,
    NodeLayoutOverride
} from "../contexts/NavigatorContext";
import {
    NavigatorSocketProvider,
    useNavigatorSocket
} from "../providers/NavigatorSocketProvider";
import { draftEventsToState } from "../utils/draftEventsToState";
import {
    pathStepsToIndexPath,
    pathStepsToNodeKeyPath,
    eventsToConfirmedTurns,
    extendSpineOptimistic,
    includeConfirmedDraftStateForScenarios,
    mergeEngineTree,
    pruneInvalidProjection,
    remapScenariosSpine,
    spineNodeCount,
    synthesizeFullTree
} from "../utils/treeReconcile";
import type { ReconcilePriority } from "../utils/treeReconcile";
import { validateSocketEvent } from "../utils/socketValidation";
import { hashNavigatorEvents, makeCacheKey } from "../utils/navigatorEventHash";
import { TURN_SEQUENCE } from "../utils/turnSequence";
import { Socket } from "socket.io-client";

const NavigatorDraftDataSchema = z.object({
    id: z.string(),
    session_id: z.string(),
    game_number: z.number(),
    status: z.enum(["active", "completed"]),
    our_side_override: z.enum(["blue", "red"]).nullable(),
    draft_id: z.string().nullable()
});

const NavigatorSessionDataSchema = z.object({
    id: z.string(),
    name: z.string().nullable(),
    user_id: z.string(),
    our_side: z.enum(["blue", "red"]),
    blue_pool: TeamPoolSchema,
    red_pool: TeamPoolSchema,
    opponent_pool: z.array(z.string()).nullable(),
    draft_mode: z.enum(["standard", "fearless", "ironman"]),
    series_length: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]),
    side_swap_mode: z.enum(["auto", "manual"]),
    status: z.enum(["setup", "active", "completed"]),
    config_version: z.number(),
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

const NavigatorMctsExtrasSchema = z.object({
    visits: z.number().int().nonnegative(),
    visitShare: z.number().min(0).max(1),
    paretoOnFrontier: z.boolean().optional()
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
        children: z.array(NavigatorTreeNodeSchema),
        confirmedChampionIds: z.array(z.string()).optional(),
        mctsExtras: NavigatorMctsExtrasSchema.optional()
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
    redPicks: z.array(z.string()),
    blueBans: z.array(z.string()),
    redBans: z.array(z.string()),
    blueLikelyAssignments: z.array(NavigatorWeightedAssignmentSchema),
    redLikelyAssignments: z.array(NavigatorWeightedAssignmentSchema),
    treePath: z.array(
        z.object({
            slot: z.number().int().nonnegative(),
            championIds: z.array(z.string())
        })
    ),
    perspective: z.enum(["robust", "likely", "off_profile"]),
    indicators: z.array(z.string())
});

const NavigatorMctsMetaSchema = z.object({
    algorithm: z.literal("mcts"),
    iterations: z.number().int().nonnegative(),
    isExperimental: z.literal(true),
    truncated: z.boolean().default(false)
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
            transpositionsFound: z.number(),
            mctsMeta: NavigatorMctsMetaSchema.optional(),
            partial: z.boolean().optional(),
            rootPath: z.array(z.array(z.string())).optional(),
            persistOnPause: z.boolean().optional()
        })
        .nullable(),
    createdAt: z.string()
});

const NavigatorPartialSnapshotEnvelopeSchema = z.object({
    sessionId: z.string(),
    draftId: z.string(),
    version: z.number().int().nonnegative(),
    afterEventId: z.string().nullable(),
    snapshot: NavigatorSnapshotDataSchema
});

const NavigatorRerootErrorSchema = z.object({
    sessionId: z.string(),
    draftId: z.string(),
    rerootId: z.number().int().nonnegative(),
    attemptedPath: z.array(z.array(z.string())),
    error: z.string()
});

const NavigatorCompletedGameSchema = z.object({
    draft: NavigatorDraftDataSchema,
    events: z.array(NavigatorEventDataSchema),
    snapshot: NavigatorSnapshotDataSchema.nullable()
});

const NavigatorJoinResponseSchema = z.object({
    success: z.boolean(),
    session: NavigatorSessionDataSchema.nullable().optional(),
    draft: NavigatorDraftDataSchema.nullable().optional(),
    events: z.array(NavigatorEventDataSchema).optional(),
    snapshot: NavigatorSnapshotDataSchema.nullable().optional(),
    completedGames: z.array(NavigatorCompletedGameSchema).optional(),
    engineToggleEnabled: z.boolean().optional(),
    currentAlgorithm: z.enum(["ab", "mcts"]).optional()
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
    completedGames: [],
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

    // Auto-select scenarios[0] (Robust) when a snapshot arrives with scenarios
    // but no current selection. Keyed on snapshot.id (per-snapshot UUID set by
    // backend) — NOT navigator_draft_id (stable per-draft, won't change across
    // recomputes). Cache snapshots use id="cache" which still triggers correctly.
    //
    // Effect ordering: snapshot-update events run remapSelectedScenarioIndex
    // synchronously inside the handler, so this effect always sees post-remap
    // selection state. The "only set when null" guard preserves user clicks
    // (and remap's name-match results) across recomputes.
    const currentSnapshotId = createMemo(() => navigatorContext().snapshot?.id ?? null);
    createEffect(() => {
        const snapId = currentSnapshotId();
        if (snapId === null) return;
        const scenarios = navigatorContext().snapshot?.scenarios ?? [];
        if (scenarios.length === 0) return;
        if (selectedScenarioIndex() === null) {
            setSelectedScenarioIndex(0);
        }
    });
    const [panRequest, setPanRequest] = createSignal<NavigatorPanRequest | null>(null);
    const [manualExpansionKeys, setManualExpansionKeysSignal] = createSignal<
        ReadonlySet<string>
    >(new Set<string>());
    const [manualCollapseKeys, setManualCollapseKeysSignal] = createSignal<
        ReadonlySet<string>
    >(new Set<string>());
    const [layoutOverrides, setLayoutOverridesSignal] = createSignal<
        ReadonlyMap<string, NodeLayoutOverride>
    >(new Map());
    const [syntheticTreeSignal, setSyntheticTreeSignal] =
        createSignal<NavigatorTreeNode | null>(null);
    const [lastEventIdSeen, setLastEventIdSeen] = createSignal<string | null>(null);
    const [viewingGameNumber, setViewingGameNumberSignal] = createSignal<number | null>(
        null
    );

    // v5 phase 4: dev-only experimental engine toggle. Gated behind the
    // backend's NAV_ENGINE_TOGGLE_ENABLED env var — when off, the engineToggleEnabled
    // accessor is false and the toggle UI is hidden. Frontend emits
    // `navigatorSetAlgorithm` on user toggle and the backend recomputes.
    const [engineToggleEnabled, setEngineToggleEnabled] = createSignal(false);
    const [currentAlgorithm, setCurrentAlgorithmSignal] =
        createSignal<NavigatorAlgorithm>("ab");

    // Phase 7b T13: streaming partial snapshot wiring. `partialSnapshot` is
    // the latest envelope-delivered (incomplete) tree from the MCTS engine;
    // T14 layers overlay precedence (below) so the canvas prefers
    // `partialSnapshot` over the persisted final snapshot while a compute
    // is active.
    // `displayedRootPath` is the path the UI has optimistically rerooted to;
    // engine confirmation arrives in subsequent partials' meta.rootPath. The
    // `pendingReroots` map tracks in-flight reroot requests so a server-side
    // rejection can roll back the optimistic state (Decision 8).
    // `nextRerootId` is consumed by `onReroot` (T16) as a monotonic counter.
    const [partialSnapshot, setPartialSnapshot] =
        createSignal<NavigatorSnapshotData | null>(null);
    const [latestVersionSeen, setLatestVersionSeen] = createSignal<number>(0);
    const [displayedRootPath, setDisplayedRootPath] = createSignal<string[][]>([]);
    const [isSessionActive, setIsSessionActive] = createSignal<boolean>(false);
    // Phase 7b T15: optimistic stopping state. Flipped true when the user
    // clicks Stop (so the indicator can swap to "Stopping…" before the engine
    // observes the cooperative cancel), cleared in the final-arrives batch
    // alongside `isSessionActive` so a subsequent trigger starts fresh.
    const [isStopping, setIsStopping] = createSignal<boolean>(false);
    const pendingReroots = new Map<
        number,
        { delta: string[][]; priorPath: string[][] }
    >();

    let nextRerootId = 0;

    interface CachedResult {
        tree: NavigatorTreeNode;
        scenarios: NavigatorScenario[];
        syntheticTree: NavigatorTreeNode | null;
        timestamp: number;
    }

    const snapshotCache = new Map<string, CachedResult>();

    const writeCacheEntry = (
        configVersion: number,
        events: NavigatorEventData[],
        tree: NavigatorTreeNode,
        scenarios: NavigatorScenario[],
        synthetic: NavigatorTreeNode | null
    ) => {
        const key = makeCacheKey(configVersion, hashNavigatorEvents(events));
        snapshotCache.set(key, {
            tree,
            scenarios,
            syntheticTree: synthetic,
            timestamp: Date.now()
        });
    };

    const applyCacheEntry = (entry: CachedResult, nextEvents: NavigatorEventData[]) => {
        const finalSnapshot: NavigatorSessionState["snapshot"] = {
            id: "cache",
            navigator_draft_id:
                untrack(navigatorContext).snapshot?.navigator_draft_id ?? "",
            after_event_id:
                nextEvents.length > 0 ? nextEvents[nextEvents.length - 1].id : null,
            tree: entry.tree,
            scenarios: entry.scenarios,
            meta: null,
            createdAt: new Date().toISOString()
        };
        setSyntheticTreeSignal(entry.syntheticTree);
        setNavigatorContext((p) => ({
            ...p,
            events: nextEvents,
            snapshot: finalSnapshot,
            error: null
        }));
        setLastEventIdSeen(
            nextEvents.length > 0 ? nextEvents[nextEvents.length - 1].id : null
        );
        console.log("[nav] cache hit — restored prior snapshot from local cache");
    };

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
    const setLayoutOverride = (nodeKey: string, override: NodeLayoutOverride | null) => {
        setLayoutOverridesSignal((prev) => {
            const next = new Map(prev);
            if (override === null) {
                next.delete(nodeKey);
            } else {
                next.set(nodeKey, override);
            }
            return next;
        });
    };
    const clearAllLayoutOverrides = () => {
        setLayoutOverridesSignal(new Map());
    };
    const requestScenarioPan = (treePath: NavigatorScenarioPathStep[]) => {
        const synth = syntheticTreeSignal();
        if (!synth) return;
        const indexPath = pathStepsToIndexPath(synth, treePath);
        if (!indexPath) return;
        setPanRequest({ path: indexPath });
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
                  confirmedTurns
              )
            : [];
        setNavigatorContext({
            session: response.session,
            draft: response.draft ?? null,
            events: response.events ?? [],
            snapshot: response.snapshot ? { ...response.snapshot, scenarios } : null,
            completedGames: response.completedGames ?? [],
            connected: true,
            error: null
        });
        const joinSynthetic = response.snapshot
            ? synthesizeFullTree(response.snapshot.tree, confirmedTurns)
            : null;
        setSyntheticTreeSignal(joinSynthetic);
        if (response.snapshot && response.session) {
            writeCacheEntry(
                response.session.config_version,
                response.events ?? [],
                response.snapshot.tree,
                scenarios,
                joinSynthetic
            );
        }
        setLastEventIdSeen(
            response.events && response.events.length > 0
                ? response.events[response.events.length - 1].id
                : null
        );
        setCurrentSessionId(response.session.id);
        setEngineToggleEnabled(response.engineToggleEnabled === true);
        if (response.currentAlgorithm) {
            setCurrentAlgorithmSignal(response.currentAlgorithm);
        }
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
        const incomingDraft = data.draft;
        if (
            incomingDraft &&
            prev.draft &&
            incomingDraft.id !== prev.draft.id &&
            (data.events ?? []).length === 0
        ) {
            setSyntheticTreeSignal(null);
            setLastEventIdSeen(null);
            // Snapshot cache is keyed by (config_version, event-tuple hash) and
            // has no draft/game scope. Without clearing it here, Game N+1's
            // first pick can hit Game N's cached snapshot (same hash, same
            // config_version) and paint a stale tree that mergeEngineTree
            // preserves as projection even after the server's correctly-
            // excluded snapshot arrives.
            snapshotCache.clear();
        }
        const prevEvents = prev.events;
        const prevSynthetic = untrack(syntheticTreeSignal);
        const prevSnapshot = prev.snapshot;

        const nextEvents = data.events ?? prevEvents;
        const nextSnapshot = data.snapshot === undefined ? prevSnapshot : data.snapshot;

        const eventsChanged = nextEvents !== prevEvents;
        const snapshotChanged =
            nextSnapshot !== prevSnapshot && nextSnapshot !== undefined;

        let nextSynthetic = prevSynthetic;

        const prevTurns = eventsToConfirmedTurns(prevEvents);
        const nextTurns = eventsToConfirmedTurns(nextEvents);

        if (eventsChanged && prevSynthetic) {
            const isPromote =
                prevTurns.length === nextTurns.length &&
                prevTurns.length > 0 &&
                prevTurns[prevTurns.length - 1].pairState === "pair-pending" &&
                nextTurns[nextTurns.length - 1].pairState === "pair-complete";

            if (isPromote && prevSnapshot) {
                // Pair-pending -> pair-complete transition. Rebuild the whole
                // synthetic tree from scratch using the last snapshot's engine
                // tree - simpler and less error-prone than threading a "promote"
                // code path through extendSpineOptimistic.
                nextSynthetic = synthesizeFullTree(prevSnapshot.tree, nextTurns);
            } else {
                const newTurns = nextTurns.slice(prevTurns.length);
                let working = prevSynthetic;
                let spineLength = spineNodeCount(prevTurns);
                for (const turn of newTurns) {
                    working = extendSpineOptimistic(working, turn, spineLength);
                    if (turn.pairState !== "pair-pending") spineLength += 1;
                }
                nextSynthetic = working;
            }
        }

        let nextScenarios = nextSnapshot?.scenarios ?? [];
        if (snapshotChanged && nextSnapshot) {
            const confirmedTurns = eventsToConfirmedTurns(nextEvents);
            const spineLength = spineNodeCount(confirmedTurns);
            const draftState = draftEventsToState(nextEvents);
            const priority = buildPriority(nextSynthetic, prevSnapshot, spineLength);
            const tailTurn = confirmedTurns.at(-1);
            const isPairPending = tailTurn?.pairState === "pair-pending";

            if (nextSynthetic) {
                if (isPairPending) {
                    // Skip mergeEngineTree: the engine's fresh tree is rooted
                    // at post-half-pair state with solo completion children
                    // that do not share identity with the filtered pair
                    // fanout. Still prune to remove any nodes referencing
                    // newly-used champions elsewhere in the draft.
                    nextSynthetic = pruneInvalidProjection(
                        nextSynthetic,
                        draftState,
                        spineLength
                    );
                } else {
                    const merged = mergeEngineTree(
                        nextSynthetic,
                        nextSnapshot.tree,
                        spineLength,
                        draftState,
                        priority,
                        5
                    );
                    nextSynthetic = pruneInvalidProjection(
                        merged,
                        draftState,
                        spineLength
                    );
                }
            } else {
                nextSynthetic = synthesizeFullTree(nextSnapshot.tree, confirmedTurns);
            }

            if (isPairPending && tailTurn && prevSnapshot && nextSynthetic) {
                // Engine currently returns a degenerate tree for pair-pending
                // root states (search.ts bails on turn.pairEnd), which makes
                // extractScenarios emit a single empty scenario. Until that
                // is fixed engine-side, preserve the previous snapshot's
                // scenarios filtered to those whose pair side includes the
                // just-clicked champion.
                //
                // Each preserved scenario's treePath is content-addressed
                // (post-remap), so it walks to the same nodes in the new
                // (filtered) fanout without index recomputation — the pair
                // step's `championIds` match the surviving pair node by
                // sorted-set equality.
                const enteredChamp = tailTurn.championIds[0];
                const side = tailTurn.side;
                const preTurnPicks =
                    (side === "blue"
                        ? draftState.bluePicks.length
                        : draftState.redPicks.length) - 1;

                const preserved: NavigatorScenario[] = [];
                for (const s of prevSnapshot.scenarios) {
                    const picks = side === "blue" ? s.bluePicks : s.redPicks;
                    const pairA = picks[preTurnPicks];
                    const pairB = picks[preTurnPicks + 1];
                    if (pairA === undefined || pairB === undefined) continue;
                    if (pairA !== enteredChamp && pairB !== enteredChamp) continue;
                    preserved.push(s);
                }

                nextScenarios = preserved;
            } else {
                nextScenarios = remapScenariosSpine(
                    includeConfirmedDraftStateForScenarios(
                        nextSnapshot.scenarios,
                        draftState
                    ),
                    confirmedTurns
                );
            }
        } else if (!prevSynthetic && nextSnapshot) {
            const confirmedTurns = eventsToConfirmedTurns(nextEvents);
            const draftState = draftEventsToState(nextEvents);
            nextSynthetic = synthesizeFullTree(nextSnapshot.tree, confirmedTurns);
            nextScenarios = remapScenariosSpine(
                includeConfirmedDraftStateForScenarios(
                    nextSnapshot.scenarios,
                    draftState
                ),
                confirmedTurns
            );
        }

        const finalSnapshot = nextSnapshot
            ? { ...nextSnapshot, scenarios: nextScenarios }
            : prevSnapshot;

        let nextCompletedGames = prev.completedGames;
        const prevDraft = prev.draft;
        const nextDraft = data.draft === undefined ? prev.draft : data.draft;
        if (
            prevDraft &&
            nextDraft &&
            prevDraft.id === nextDraft.id &&
            prevDraft.status !== "completed" &&
            nextDraft.status === "completed"
        ) {
            const archive = {
                draft: nextDraft,
                events: nextEvents,
                snapshot: finalSnapshot ?? null
            };
            nextCompletedGames = [...nextCompletedGames, archive];
        } else if (nextDraft && prevDraft && nextDraft.id !== prevDraft.id) {
            // Safety net: new game started before the completion update
            // arrived — archive the prior draft if it was completed.
            const alreadyArchived = nextCompletedGames.some(
                (c) => c.draft.id === prevDraft.id
            );
            if (!alreadyArchived && prevDraft.status === "completed") {
                nextCompletedGames = [
                    ...nextCompletedGames,
                    {
                        draft: prevDraft,
                        events: prev.events,
                        snapshot: prev.snapshot
                    }
                ];
            }
        }

        // Phase 7b T14 (Opus R2-NIT-5): wrap final-snapshot state updates in
        // `batch` so the partial → final transition lands in a single frame.
        // Without batch, the tree memo would briefly reactively re-evaluate
        // between `setPartialSnapshot(null)` (overlay clear) and
        // `setNavigatorContext(...)` (new authoritative snapshot installed),
        // flashing the previous final's tree.
        // T15 will extend this batch with `setIsStopping(false)`.
        batch(() => {
            if (nextSynthetic !== prevSynthetic) {
                setSyntheticTreeSignal(nextSynthetic);
            }
            setNavigatorContext((p) => ({
                session: data.session ?? p.session,
                draft: data.draft === undefined ? p.draft : data.draft,
                events: nextEvents,
                snapshot: finalSnapshot ?? null,
                completedGames: nextCompletedGames,
                connected: true,
                error: null
            }));
            setLastEventIdSeen(
                nextEvents.length > 0 ? nextEvents[nextEvents.length - 1].id : null
            );
            if (snapshotChanged) {
                // Authoritative final arrived for the active compute — clear
                // the streaming overlay and mark the session inactive so the
                // next user trigger can flip it back on. Gated on
                // `snapshotChanged` because `handleDraftUpdate` also fires on
                // event-only updates that don't supersede the partial.
                // T15: also clear `isStopping` here — whether the final landed
                // organically or because of a user Stop, the optimistic
                // "Stopping…" state has served its purpose.
                setPartialSnapshot(null);
                setIsSessionActive(false);
                setIsStopping(false);
            }
        });

        if (finalSnapshot && (data.session ?? untrack(navigatorContext).session)) {
            const sess = data.session ?? untrack(navigatorContext).session;
            if (sess) {
                writeCacheEntry(
                    sess.config_version,
                    nextEvents,
                    finalSnapshot.tree,
                    finalSnapshot.scenarios,
                    nextSynthetic
                );
            }
        }

        if (snapshotChanged && prevSnapshot && finalSnapshot) {
            remapSelectedScenarioIndex(prevSnapshot.scenarios, finalSnapshot.scenarios);
        }
    };

    // Phase 7b T13: deep equality for path-of-path-steps (each outer entry is
    // a turn's championIds tuple). Used to gate stale partials and to confirm
    // pending reroots once the engine echoes the new root in meta.rootPath.
    function pathsEqual(a: string[][], b: string[][]): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].length !== b[i].length) return false;
            for (let j = 0; j < a[i].length; j++) {
                if (a[i][j] !== b[i][j]) return false;
            }
        }
        return true;
    }

    // Phase 7b T13 / Decision 8: optimistic reroot rollback. Called when the
    // backend reports `navigatorRerootError` for an in-flight reroot. Only
    // rolls back when `displayedRootPath` still ends with the pending delta —
    // a subsequent successful reroot or a session change may have moved past
    // this point, in which case the bookkeeping is dropped silently.
    function rollbackReroot(rerootId: number) {
        const pending = pendingReroots.get(rerootId);
        if (!pending) return;
        const cur = displayedRootPath();
        const startIdx = pending.priorPath.length;
        const stillPresent = pending.delta.every(
            (step, i) =>
                cur[startIdx + i] !== undefined &&
                step.length === cur[startIdx + i].length &&
                step.every((id, j) => id === cur[startIdx + i][j])
        );
        if (stillPresent && cur.length === startIdx + pending.delta.length) {
            setDisplayedRootPath(pending.priorPath);
        }
        pendingReroots.delete(rerootId);
    }

    function buildPriority(
        currentSynthetic: NavigatorTreeNode | null,
        snapshot: NavigatorSessionState["snapshot"],
        spineLength: number
    ): ReconcilePriority {
        // Resolve every scenario's content-addressed treePath to a nodeKey
        // path, dropping ones that don't resolve against the current
        // synthetic. `trimChildrenByPriority` rank-0-protects each, so all
        // surviving lanes render in the tree visualization (not just the
        // auto-selected one).
        //
        // `mergeChildren` passes `keyPath` relative to the fanout parent
        // (starts empty, grows as recursion descends past the fanout). The
        // scenarios' nodeKey paths come back from `pathStepsToNodeKeyPath`
        // relative to the synthetic ROOT, so the first `spineLength` keys
        // are the confirmed-turn spine. Slice those off so the path the
        // trim sees aligns with `keyPath.length` at each merge level.
        const scenarioKeyPaths: string[] = [];
        if (currentSynthetic && snapshot) {
            for (const scenario of snapshot.scenarios) {
                const keyPath = pathStepsToNodeKeyPath(
                    currentSynthetic,
                    scenario.treePath
                );
                if (keyPath === null) continue;
                const segs = keyPath === "" ? [] : keyPath.split(">");
                const fanoutRelativeSegs = segs.slice(spineLength);
                scenarioKeyPaths.push(fanoutRelativeSegs.join(">"));
            }
        }
        return {
            scenarioKeyPaths,
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

        // Phase 7b T13: streaming partial snapshots from the MCTS engine
        // arrive on `navigatorPartialSnapshot`. Stale guards (session,
        // draft, active flag, monotonic version, root identity) prevent
        // late-arriving partials from clobbering a fresh session or
        // overwriting a different rerooted view.
        sock.on("navigatorPartialSnapshot", (raw) => {
            const parsed = NavigatorPartialSnapshotEnvelopeSchema.safeParse(raw);
            if (!parsed.success) return;
            const env = parsed.data;
            if (env.sessionId !== untrack(currentSessionId)) return;
            if (env.draftId !== untrack(navigatorContext).draft?.id) return;
            if (env.version < untrack(latestVersionSeen)) return;
            const envelopeRootPath = env.snapshot.meta?.rootPath ?? [];
            if (!pathsEqual(envelopeRootPath, untrack(displayedRootPath))) return;
            if (!untrack(isSessionActive)) {
                // v4 R4-M3 self-heal: a partial passed all other gates but session
                // is "inactive". This happens for backend-driven recomputes that
                // didn't go through emitPick/Ban/Undo/setAlgorithm/onReroot (e.g.
                // a navigatorSetAlgorithm-triggered compute, or initial compute on
                // an existing in-flight session via join). Self-heal so subsequent
                // partials accept normally. Only on strictly-newer version + when
                // not paused/stopping.
                if (untrack(isStopping)) return;
                if (env.version <= untrack(latestVersionSeen)) return;
                const ctx = untrack(navigatorContext);
                const paused = ctx.snapshot?.meta?.persistOnPause === true
                    && ctx.snapshot?.after_event_id === (ctx.events.length > 0 ? ctx.events[ctx.events.length - 1].id : null);
                if (paused) return;
                setIsSessionActive(true);
            }
            setLatestVersionSeen(env.version);
            setPartialSnapshot(env.snapshot);
            for (const [rerootId, pending] of pendingReroots) {
                const expected = [...pending.priorPath, ...pending.delta];
                if (pathsEqual(expected, envelopeRootPath)) {
                    pendingReroots.delete(rerootId);
                }
            }
        });

        sock.on("navigatorRerootError", (raw) => {
            const parsed = NavigatorRerootErrorSchema.safeParse(raw);
            if (!parsed.success) return;
            if (parsed.data.sessionId !== untrack(currentSessionId)) return;
            rollbackReroot(parsed.data.rerootId);
        });

        socketWithListeners = sock;

        onCleanup(() => {
            if (socketWithListeners === sock) {
                socketWithListeners = undefined;
            }

            sock.off("navigatorJoinResponse");
            sock.off("navigatorDraftUpdate");
            sock.off("navigatorError");
            sock.off("navigatorPartialSnapshot");
            sock.off("navigatorRerootError");
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

    // Phase 7b T13 (Opus R1-#24): reset all streaming/reroot bookkeeping
    // when the session changes. Prevents partials and pending-reroot state
    // from one session leaking into the next.
    createEffect(() => {
        currentSessionId();
        setPartialSnapshot(null);
        setLatestVersionSeen(0);
        setDisplayedRootPath([]);
        setIsSessionActive(false);
        // T15: include the optimistic stopping flag so a session swap doesn't
        // leave the next session indicating "Stopping…".
        setIsStopping(false);
        pendingReroots.clear();
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

    const lookupCachePick = (
        championId: string,
        slot: number,
        eventType: "pick" | "ban"
    ): {
        entry: CachedResult | undefined;
        nextEvents: NavigatorEventData[];
    } => {
        const ctx = untrack(navigatorContext);
        const session = ctx.session;
        if (!session) return { entry: undefined, nextEvents: ctx.events };
        const turn = TURN_SEQUENCE[slot];
        const side = turn ? turn.side : "blue";
        const syntheticEvent: NavigatorEventData = {
            id: `optimistic-${slot}`,
            navigator_draft_id: ctx.draft?.id ?? "",
            event_type: eventType,
            slot,
            side,
            champion_id: championId,
            user_injected: false,
            createdAt: new Date().toISOString()
        };
        const nextEvents = [...ctx.events, syntheticEvent];
        const key = makeCacheKey(session.config_version, hashNavigatorEvents(nextEvents));
        return { entry: snapshotCache.get(key), nextEvents };
    };

    const lookupCacheUndo = (): {
        entry: CachedResult | undefined;
        nextEvents: NavigatorEventData[];
    } => {
        const ctx = untrack(navigatorContext);
        const session = ctx.session;
        if (!session || ctx.events.length === 0)
            return { entry: undefined, nextEvents: ctx.events };
        const nextEvents = ctx.events.slice(0, -1);
        const key = makeCacheKey(session.config_version, hashNavigatorEvents(nextEvents));
        return { entry: snapshotCache.get(key), nextEvents };
    };

    const emitPick = (draftId: string, championId: string, slot: number) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        const { entry, nextEvents } = lookupCachePick(championId, slot, "pick");
        if (entry) {
            applyCacheEntry(entry, nextEvents);
        }

        // Phase 7b T14: any compute-triggering user action opens the gate
        // for streaming partials. The handler's existing guards (session,
        // draft, version, rootPath) still reject stale envelopes.
        setIsSessionActive(true);
        sock.emit("navigatorPick", {
            sessionId,
            draftId,
            championId,
            slot
        });
    };

    const swapChampion: NavigatorWorkflowContextValue["swapChampion"] = ({
        path,
        targetSlot,
        newChampionId
    }) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();
        const draftId = navigatorContext().draft?.id;
        if (!sock || !sessionId || !draftId) return;
        sock.emit("navigatorSwapChampion", {
            sessionId,
            draftId,
            path,
            targetSlot,
            championId: newChampionId
        });
    };

    const createBranch: NavigatorWorkflowContextValue["createBranch"] = ({
        path,
        targetSlot,
        newChampionId
    }) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();
        const draftId = navigatorContext().draft?.id;
        if (!sock || !sessionId || !draftId) return;
        sock.emit("navigatorBranch", {
            sessionId,
            draftId,
            path,
            targetSlot,
            championId: newChampionId
        });
    };

    const emitBan = (draftId: string, championId: string, slot: number) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;

        const { entry, nextEvents } = lookupCachePick(championId, slot, "ban");
        if (entry) {
            applyCacheEntry(entry, nextEvents);
        }

        // Phase 7b T14: see emitPick — opens the streaming-partial gate.
        setIsSessionActive(true);
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

        const { entry, nextEvents } = lookupCacheUndo();
        if (entry) {
            applyCacheEntry(entry, nextEvents);
        }

        // Phase 7b T14: undo retriggers compute; open the partial gate.
        setIsSessionActive(true);
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

    const viewGame = (gameNumber: number | null) => {
        setViewingGameNumberSignal(gameNumber);
    };

    const startNextGame = (ourSideOverride?: "blue" | "red") => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();
        if (!sock || !sessionId) return;

        sock.emit("navigatorNextGame", {
            sessionId,
            ourSideOverride: ourSideOverride ?? null
        });
        setViewingGameNumberSignal(null);
    };

    const updateSessionPools = (bluePool: TeamPool, redPool: TeamPool) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();
        if (!sock || !sessionId) return;

        sock.emit("navigatorUpdatePools", {
            sessionId,
            blue_pool: bluePool,
            red_pool: redPool
        });
    };

    const setAlgorithm = (algorithm: NavigatorAlgorithm) => {
        if (!engineToggleEnabled()) return;
        const sock = currentSocket();
        const sessionId = getActiveSessionId();
        if (!sock || !sessionId) return;
        // Optimistic local set so UI flips immediately; backend confirms via
        // the recompute that follows. If the backend rejects (env-var off, bad
        // value) it silently ignores; the next snapshot will still show the
        // prior engine's output, which is the correct visual signal.
        setCurrentAlgorithmSignal(algorithm);
        // Phase 7b T14: switching algorithms supersedes the prior compute and
        // triggers a new one — open the partial gate so MCTS partials are
        // accepted as they arrive.
        setIsSessionActive(true);
        sock.emit("navigatorSetAlgorithm", { sessionId, algorithm });
    };

    // Phase 7b T14 (Decision 11): partial fast-path. Partials arrive ~5-10 Hz
    // and are already full trees (meta.partial=true), so running the
    // synthesizeFullTree / mergeEngineTree / pruneInvalidProjection pipeline
    // on every partial would cause reactive churn that [contain:content]
    // paint isolation can't hide. Bypass synthesis when a partial is present;
    // fall through to the existing pipeline output (syntheticTreeSignal) on
    // finals or when no MCTS session is streaming.
    const effectiveTree = createMemo(() => {
        const partial = partialSnapshot();
        if (partial) return partial.tree;
        return syntheticTreeSignal();
    });
    const effectiveScenarios = createMemo<NavigatorScenario[]>(() => {
        const partial = partialSnapshot();
        if (partial) return partial.scenarios;
        return navigatorContext().snapshot?.scenarios ?? [];
    });

    // Phase 7b T15: meta block the Computing indicator should read for
    // iter / elapsed counters. The streaming partial's meta is preferred
    // because it carries the live-updating mctsMeta.iterations and
    // computeTimeMs — the persisted snapshot's meta only refreshes on
    // finals (and αβ snapshots never carry mctsMeta at all, in which case
    // the readout gracefully renders nothing).
    const currentMeta = createMemo<NavigatorSnapshotData["meta"]>(() => {
        const partial = partialSnapshot();
        if (partial) return partial.meta;
        return navigatorContext().snapshot?.meta ?? null;
    });

    // Phase 7b T15: cooperative stop. Emit the socket event for the active
    // session id; the backend's `navigatorStopCompute` handler short-circuits
    // the iterate loop, which then produces a final snapshot that lands via
    // `handleDraftUpdate` and clears `isStopping` in the batch. Setting
    // `isStopping` here gives users immediate visual feedback during the
    // latency_budget_ms gap before the final arrives.
    const onStop = () => {
        const sock = currentSocket();
        const sid = currentSessionId();
        if (!sock || !sid) return;
        sock.emit("navigatorStopCompute", { sessionId: sid });
        setIsStopping(true);
    };

    // Phase 7b T16 (Decision 8): optimistic reroot. Caller (DecisionTree
    // hover-button) builds `delta` by walking the rendered tree from its
    // root down to the clicked node, collecting each step's championIds.
    // Bookkeeping order matters: record into `pendingReroots` BEFORE
    // mutating `displayedRootPath` so a hypothetical instantly-arriving
    // partial-snapshot listener (same tick, different microtask) sees the
    // pending entry. The partial gate also gets re-opened — a reroot
    // triggers fresh iteration on the new subtree.
    const onReroot = (delta: string[][]) => {
        const sock = currentSocket();
        const sid = currentSessionId();
        const draftId = untrack(navigatorContext).draft?.id;
        if (!sock || !sid || !draftId) return;
        if (delta.length === 0) return;

        const priorPath = displayedRootPath();
        const rerootId = ++nextRerootId;
        pendingReroots.set(rerootId, { delta, priorPath });
        // Optimistic: extend the displayed root immediately so the next
        // arriving partial whose meta.rootPath echoes priorPath + delta
        // passes the identity gate in handleDraftUpdate's partial listener.
        setDisplayedRootPath([...priorPath, ...delta]);
        // Clear the prior root's streaming overlay — the next partial
        // under the new root will replace it; until then, fall through to
        // the persisted snapshot's tree (rooted at session start, so visually
        // stale but never wrong).
        setPartialSnapshot(null);
        setIsSessionActive(true);

        sock.emit("navigatorReroot", {
            sessionId: sid,
            draftId,
            rerootId,
            rerootStep: delta
        });
    };

    const contextValue: NavigatorWorkflowContextValue = {
        navigatorContext,
        engineToggleEnabled,
        currentAlgorithm,
        setAlgorithm,
        syntheticTree: effectiveTree,
        effectiveScenarios,
        isComputing,
        isSessionActive,
        isStopping,
        onStop,
        currentMeta,
        joinSession,
        leaveSession,
        emitPick,
        emitBan,
        emitUndo,
        startDraft,
        nextGame,
        startNextGame,
        updateSessionPools,
        viewingGameNumber,
        viewGame,
        selectedScenarioIndex,
        setSelectedScenarioIndex,
        panRequest,
        setPanRequest,
        requestScenarioPan,
        manualExpansionKeys,
        manualCollapseKeys,
        setManualExpansionKeys,
        setManualCollapseKeys,
        layoutOverrides,
        setLayoutOverride,
        clearAllLayoutOverrides,
        swapChampion,
        createBranch,
        onReroot
    };

    return (
        <NavigatorWorkflowContext.Provider value={contextValue}>
            {props.children}
        </NavigatorWorkflowContext.Provider>
    );
};

export default NavigatorWorkflow;
