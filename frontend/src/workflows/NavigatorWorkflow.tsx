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
    NavigatorEventData,
    NavigatorScenario,
    NavigatorSessionState,
    NavigatorSnapshotData,
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
import {
    NavigatorEngineHeartbeatSchema,
    deriveIsComputing,
    eventListChanged,
    heartbeatMatchesState,
    partialMatchesState,
    shouldCacheSnapshot,
    type LiveHeartbeat
} from "../utils/navigatorProgress";
import {
    NavigatorTreeNodeSchema,
    NavigatorWeightedAssignmentSchema
} from "../utils/navigatorTreeSchema";
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

const NavigatorSnapshotDataSchema = z.object({
    source: z.enum(["persisted", "cache", "partial"]),
    id: z.string().nullable(),
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
            inProgress: z.boolean().optional(),
            depthInProgress: z.number().optional(),
            budgetHit: z.boolean().optional()
        })
        .nullable(),
    createdAt: z.string().nullable()
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
    completedGames: z.array(NavigatorCompletedGameSchema).optional()
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
    // but no current selection. Keyed on a composite (source + id-or-after_event_id)
    // so partial/cache snapshots — whose id is null — still trigger the effect.
    // (Pre-PR1: id was a magic string "partial"/"cache"/UUID and the effect
    // triggered on string change. Post-PR1: id is null for partial/cache; we key
    // on source plus a content-fingerprint instead.)
    //
    // Effect ordering: snapshot-update events run remapSelectedScenarioIndex
    // synchronously inside the handler, so this effect always sees post-remap
    // selection state. The "only set when null" guard preserves user clicks
    // (and remap's name-match results) across recomputes.
    const currentSnapshotKey = createMemo(() => {
        const snap = navigatorContext().snapshot;
        if (!snap) return null;
        return `${snap.source}:${snap.id ?? snap.after_event_id ?? ""}`;
    });
    createEffect(() => {
        const key = currentSnapshotKey();
        if (key === null) return;
        const scenarios = navigatorContext().snapshot?.scenarios ?? [];
        if (scenarios.length === 0) return;
        if (selectedScenarioIndex() === null) {
            setSelectedScenarioIndex(0);
        }
    });
    const [syntheticTreeSignal, setSyntheticTreeSignal] =
        createSignal<NavigatorTreeNode | null>(null);
    const [lastEventIdSeen, setLastEventIdSeen] = createSignal<string | null>(null);
    const [engineHeartbeat, setEngineHeartbeat] = createSignal<LiveHeartbeat | null>(
        null
    );
    const [viewingGameNumber, setViewingGameNumberSignal] = createSignal<number | null>(
        null
    );

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
            source: "cache",
            id: null,
            navigator_draft_id:
                untrack(navigatorContext).snapshot?.navigator_draft_id ?? "",
            after_event_id:
                nextEvents.length > 0 ? nextEvents[nextEvents.length - 1].id : null,
            tree: entry.tree,
            scenarios: entry.scenarios,
            meta: null,
            createdAt: new Date().toISOString()
        };
        batch(() => {
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
            setEngineHeartbeat(null);
        });
        console.log("[nav] cache hit — restored prior snapshot from local cache");
    };

    const isComputing = createMemo(() => {
        const ctx = navigatorContext();
        const events = ctx.events;
        return deriveIsComputing({
            eventCount: events.length,
            latestEventId:
                lastEventIdSeen() ??
                (events.length > 0 ? events[events.length - 1].id : null),
            snapshot: ctx.snapshot,
            hasLiveHeartbeat: engineHeartbeat() !== null
        });
    });

    let socketWithListeners: Socket | undefined = undefined;

    const getActiveSessionId = () =>
        navigatorContext().session?.id ?? params.sessionId ?? null;

    const resetNavigatorContext = () => {
        setSyntheticTreeSignal(null);
        setLastEventIdSeen(null);
        setEngineHeartbeat(null);
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
        const joinSynthetic = response.snapshot
            ? synthesizeFullTree(response.snapshot.tree, confirmedTurns)
            : null;
        const session = response.session;
        const snapshot = response.snapshot;
        const events = response.events ?? [];
        batch(() => {
            setNavigatorContext({
                session,
                draft: response.draft ?? null,
                events,
                snapshot: snapshot ? { ...snapshot, scenarios } : null,
                completedGames: response.completedGames ?? [],
                connected: true,
                error: null
            });
            setSyntheticTreeSignal(joinSynthetic);
            setLastEventIdSeen(events.length > 0 ? events[events.length - 1].id : null);
            setCurrentSessionId(session.id);
        });
        if (
            response.snapshot &&
            response.session &&
            shouldCacheSnapshot(response.snapshot.source)
        ) {
            writeCacheEntry(
                response.session.config_version,
                response.events ?? [],
                response.snapshot.tree,
                scenarios,
                joinSynthetic
            );
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

        // Design § 7: drop a stale partial for a state the client has already
        // left — the current-state derivation mirrors handleEngineHeartbeat's
        // exactly so the two gates agree. Checked before anything else touches
        // state so a stale partial's `events` payload is dropped too (Important #1).
        if (data.snapshot) {
            const latestEventIdForGate =
                untrack(lastEventIdSeen) ??
                (prev.events.length > 0 ? prev.events[prev.events.length - 1].id : null);
            if (!partialMatchesState(data.snapshot, latestEventIdForGate)) {
                return;
            }
        }

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

        // An undo removes exactly ONE event and keeps the rest by id
        // (navigatorUndo destroys a single row); a next-game update changes the
        // draft. Anything else shorter — including a vacuously-"prefix" empty
        // list on the same draft — is the stale broadcast this guard defends
        // against. This NARROWS that defence, it does not remove it: the server's
        // version check covers only snapshot-carrying broadcasts.
        const draftChanged = Boolean(
            incomingDraft && prev.draft && incomingDraft.id !== prev.draft.id
        );
        const isUndoOfPrev = (next: NavigatorEventData[]) =>
            next.length === prevEvents.length - 1 &&
            next.every((e, i) => prevEvents[i]?.id === e.id);
        const nextEvents =
            data.events === undefined
                ? prevEvents
                : data.events.length >= prevEvents.length ||
                    draftChanged ||
                    isUndoOfPrev(data.events)
                  ? data.events
                  : prevEvents;
        const nextSnapshot = data.snapshot === undefined ? prevSnapshot : data.snapshot;

        const eventsChanged = nextEvents !== prevEvents;
        // Final review #2: array identity (`eventsChanged`) is true on every
        // partial (a freshly-parsed `events` array rides every
        // navigatorDraftUpdate), which would clear a live heartbeat on every
        // partial. The heartbeat clear below needs an actual change of the
        // event LIST instead; every other use of `eventsChanged` is unchanged.
        const eventListActuallyChanged = eventListChanged(prevEvents, nextEvents);
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

        // Step 3d (execution ruling 2026-09-07): a next-game update carries
        // `snapshot: null` and the server runs no root compute for game ≥ 2, so
        // the previous game's snapshot must not survive the draft change —
        // with the synthetic tree already cleared it read as a false
        // "No legal completion" at 0 events. The archive keeps its own copy.
        const finalSnapshot = nextSnapshot
            ? { ...nextSnapshot, scenarios: nextScenarios }
            : draftChanged
              ? null
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

        // Wrap final-snapshot state updates in `batch` so the synthetic-tree
        // swap and the authoritative snapshot install land in a single frame.
        batch(() => {
            if (nextSynthetic !== prevSynthetic) {
                setSyntheticTreeSignal(nextSynthetic);
            }
            // A final snapshot for this state ends the heartbeat; an events change
            // or a draft change invalidates any heartbeat for the old state.
            // Final review #2: gate on the event LIST actually changing, not
            // array identity — every partial gets a fresh `events` array.
            if (
                eventListActuallyChanged ||
                draftChanged ||
                (finalSnapshot && finalSnapshot.meta?.inProgress !== true)
            ) {
                setEngineHeartbeat(null);
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
        });

        if (
            finalSnapshot &&
            shouldCacheSnapshot(finalSnapshot.source) &&
            (data.session ?? untrack(navigatorContext).session)
        ) {
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
            // The radial tree's manual expansions are gone (design § 1); the
            // reconcile's priority contract keeps the field.
            manualExpansionKeyPaths: new Set<string>()
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

    const handleEngineHeartbeat = (rawData: unknown) => {
        const hb = validateSocketEvent(
            "navigatorEngineHeartbeat",
            rawData,
            NavigatorEngineHeartbeatSchema
        );
        if (!hb) return;
        const ctx = untrack(navigatorContext);
        const latestEventId =
            untrack(lastEventIdSeen) ??
            (ctx.events.length > 0 ? ctx.events[ctx.events.length - 1].id : null);
        if (!heartbeatMatchesState(hb, ctx.draft?.id ?? null, latestEventId)) return;
        setEngineHeartbeat({ ...hb, receivedAt: Date.now() });
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
        sock.on("navigatorEngineHeartbeat", handleEngineHeartbeat);

        socketWithListeners = sock;

        onCleanup(() => {
            if (socketWithListeners === sock) {
                socketWithListeners = undefined;
            }

            sock.off("navigatorJoinResponse");
            sock.off("navigatorDraftUpdate");
            sock.off("navigatorError");
            sock.off("navigatorEngineHeartbeat");
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

    const lookupCachePickStep = (
        championIds: string[],
        firstSlot: number,
        eventType: "pick"
    ): {
        entry: CachedResult | undefined;
        nextEvents: NavigatorEventData[];
    } => {
        const ctx = untrack(navigatorContext);
        const session = ctx.session;
        if (!session) return { entry: undefined, nextEvents: ctx.events };
        const syntheticEvents: NavigatorEventData[] = championIds.map((cid, i) => {
            const slot = firstSlot + i;
            const turn = TURN_SEQUENCE[slot];
            const side = turn ? turn.side : "blue";
            return {
                id: `optimistic-${slot}`,
                navigator_draft_id: ctx.draft?.id ?? "",
                event_type: eventType,
                slot,
                side,
                champion_id: cid,
                user_injected: false,
                createdAt: new Date(Date.now() + i).toISOString()
            };
        });
        const nextEvents = [...ctx.events, ...syntheticEvents];
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

    const emitPickStep = (draftId: string, championIds: string[], firstSlot: number) => {
        const sock = currentSocket();
        const sessionId = getActiveSessionId();

        if (!sock || !sessionId) return;
        if (championIds.length < 1 || championIds.length > 2) return;

        const { entry, nextEvents } = lookupCachePickStep(championIds, firstSlot, "pick");
        if (entry) {
            applyCacheEntry(entry, nextEvents);
        }

        sock.emit("navigatorPick", {
            sessionId,
            draftId,
            championIds,
            firstSlot
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

    const effectiveTree = createMemo(() => {
        return syntheticTreeSignal();
    });
    const effectiveScenarios = createMemo<NavigatorScenario[]>(() => {
        return navigatorContext().snapshot?.scenarios ?? [];
    });

    const currentMeta = createMemo<NavigatorSnapshotData["meta"]>(() => {
        return navigatorContext().snapshot?.meta ?? null;
    });

    const contextValue: NavigatorWorkflowContextValue = {
        navigatorContext,
        syntheticTree: effectiveTree,
        effectiveScenarios,
        isComputing,
        currentMeta,
        engineHeartbeat,
        joinSession,
        leaveSession,
        emitPickStep,
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
        swapChampion,
        createBranch
    };

    return (
        <NavigatorWorkflowContext.Provider value={contextValue}>
            {props.children}
        </NavigatorWorkflowContext.Provider>
    );
};

export default NavigatorWorkflow;
