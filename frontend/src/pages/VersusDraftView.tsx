import {
    Component,
    createSignal,
    createEffect,
    createMemo,
    onCleanup,
    For,
    Show
} from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/solid-query";
import { useVersusSocket } from "../providers/VersusSocketProvider";
import {
    useVersusContext,
    type ActiveDraftState,
    type DraftCallbacks
} from "../contexts/VersusContext";
import { getSuggestedRole } from "../workflows/VersusWorkflow";
import {
    draft,
    VersusDraft,
    VersusState,
    PickChangeRequested,
    HeartbeatSchema,
    DraftStateSyncSchema,
    ReadyUpdateSchema,
    DraftStartedSchema,
    DraftUpdateSchema,
    PauseRequestedSchema,
    ResumeRequestedSchema,
    PickChangeRequestedSchema,
    RoleAvailableSchema,
    GameSettingsUpdateSchema,
    WinnerUpdateSchema
} from "../utils/schemas";
import { getEffectiveSide } from "@draft-sim/shared-types";
import { fetchVersusDraft, fetchDraft, completeDraft } from "../utils/actions";
import { Socket } from "socket.io-client";
import { validateSocketEvent } from "../utils/socketValidation";
import { getEffectivePickOrder, getPicksArrayIndex } from "../utils/versusPickOrder";
import { VersusTimer } from "../components/VersusTimer";
import { ReadyButton } from "../components/ReadyButton";
import { WinnerDeclarationModal } from "../components/WinnerDeclarationModal";
import { PauseRequestModal } from "../components/PauseRequestModal";
import { GameSettingsGrid } from "../components/GameSettingsGrid";
import { champions, gameTextColors, getSplashUrl } from "../utils/constants";
import toast from "solid-toast";
import { ChampionPanel } from "../components/ChampionPanel";
import {
    getRestrictedChampions,
    getRestrictedChampionsByGame
} from "../utils/seriesRestrictions";

const VersusDraftView: Component = () => {
    const params = useParams<{ id: string; draftId: string }>();
    const navigate = useNavigate();
    const { socket: socketAccessor, connectionStatus: connectionStatusAccessor } =
        useVersusSocket();

    // Get role and participant info from context (single source of truth)
    const {
        versusContext,
        registerDraftState,
        unregisterDraftState,
        registerDraftCallbacks,
        unregisterDraftCallbacks,
        setGameSettings,
        isNewGame,
        confirmGameRole,
        myTeamIdentity
    } = useVersusContext();
    const queryClient = useQueryClient();
    // versusState must be declared before createMemos that reference it
    // (createMemo runs eagerly on creation — TDZ if declared after)
    const [versusState, setVersusState] = createSignal<VersusState>({
        draftId: params.draftId,
        currentPickIndex: 0,
        timerStartedAt: null,
        isPaused: false,
        readyStatus: { blue: false, red: false },
        completed: false,
        firstPick: "blue",
        blueSideTeam: 1
    });
    const myRole = createMemo(() => versusContext().myParticipant?.role || null);
    const myEffectiveSide = createMemo(() => {
        const role = myRole();
        if (!role || role === "spectator") return null;
        return getEffectiveSide(role, versusState().blueSideTeam ?? 1);
    });
    const participantId = createMemo(() => versusContext().myParticipant?.id || null);
    const versusDraftQuery = useQuery(() => ({
        queryKey: ["versusDraft", params.id],
        queryFn: () => fetchVersusDraft(params.id),
        enabled: !!params.id
    }));
    const draftQuery = useQuery(() => ({
        queryKey: ["draft", params.draftId],
        queryFn: () => fetchDraft(params.draftId),
        enabled: !!params.draftId
    }));
    // Gate panel registration on first socket sync to prevent stale/pre-sync data flash
    const [hasSynced, setHasSynced] = createSignal(false);

    // Sync context's versusDraft (updated via sockets) to query cache
    createEffect(() => {
        const contextVD = versusContext().versusDraft;
        if (contextVD) {
            queryClient.setQueryData(["versusDraft", params.id], contextVD);
        }
    });

    // Reset versusState when navigating between games in the series
    // (socket draftStateSync will update with real values shortly after)
    createEffect(() => {
        const draftId = params.draftId;
        setHasSynced(false);
        setVersusState({
            draftId,
            currentPickIndex: 0,
            timerStartedAt: null,
            isPaused: false,
            readyStatus: { blue: false, red: false },
            completed: false,
            firstPick: "blue",
            blueSideTeam: 1
        });
    });

    // Per-game role re-prompt: track whether user needs to confirm role for this game
    const [needsGameConfirm, setNeedsGameConfirm] = createSignal(false);

    createEffect(() => {
        const role = myRole();
        const draftId = params.draftId;
        const identity = myTeamIdentity();
        const d = draftQuery.data;
        const state = versusState();

        // Never show confirmation for completed or already-started games
        if (d?.completed || state.completed || state.timerStartedAt !== null) {
            setNeedsGameConfirm(false);
            return;
        }

        // Only prompt captains (not spectators) who have a team identity
        // (meaning they've played at least one game in the series)
        if (!role || role === "spectator" || !draftId || !identity) {
            setNeedsGameConfirm(false);
            return;
        }

        if (isNewGame(draftId)) {
            setNeedsGameConfirm(true);
        } else {
            setNeedsGameConfirm(false);
        }
    });

    const handleConfirmGame = () => {
        confirmGameRole(params.draftId);
        setNeedsGameConfirm(false);
    };

    // Optimistic handler for game settings in the confirmation overlay
    const handleConfirmSettingsChange = (
        id: string,
        settings: { firstPick?: "blue" | "red"; blueSideTeam?: 1 | 2 }
    ) => {
        setVersusState((prev) => ({ ...prev, ...settings }));
        queryClient.setQueryData(["draft", params.draftId], (prev: draft | undefined) =>
            prev ? { ...prev, ...settings } : prev
        );
        setGameSettings(id, settings);
    };

    // Compute suggested role for re-prompt overlay
    const gameSuggestedRole = createMemo(() => {
        const vd = versusDraftQuery.data;
        const identity = myTeamIdentity();
        if (!vd || !identity) return null;
        return getSuggestedRole(identity, vd.blueTeamName, vd.redTeamName);
    });

    // Compute the effective side for the suggested role (for the confirmation overlay)
    const gameSuggestedSide = createMemo(() => {
        const suggested = gameSuggestedRole();
        if (!suggested) return null;
        const bst = versusState().blueSideTeam ?? draftQuery.data?.blueSideTeam ?? 1;
        return getEffectiveSide(suggested, bst);
    });

    const [showWinnerModal, setShowWinnerModal] = createSignal(false);
    const [showPauseRequest, setShowPauseRequest] = createSignal(false);
    const [pauseRequestType, setPauseRequestType] = createSignal<"pause" | "resume">(
        "pause"
    );
    const [pauseRequestTeam, setPauseRequestTeam] = createSignal<"blue" | "red">("blue");
    const [isCountingDown, setIsCountingDown] = createSignal(false);
    const [countdownValue, setCountdownValue] = createSignal(3);
    const [pendingPickChangeRequest, setPendingPickChangeRequest] =
        createSignal<PickChangeRequested | null>(null);

    // Track slots that are currently animating (just got locked in)
    const [animatingSlots, setAnimatingSlots] = createSignal<Set<string>>(new Set());
    let prevPickIndex = 0;

    // Watch for lock-ins (when currentPickIndex advances)
    createEffect(() => {
        const state = versusState();
        const currentIndex = state.currentPickIndex;

        // If index advanced, the previous slot was just locked in
        if (currentIndex > prevPickIndex && state.timerStartedAt !== null) {
            const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
            const lockedPick = effectiveOrder[prevPickIndex];

            if (lockedPick) {
                const slotKey = `${lockedPick.team}-${lockedPick.type}-${lockedPick.slot}`;
                setAnimatingSlots((prev) => new Set(prev).add(slotKey));

                // Remove after animation completes (300ms)
                setTimeout(() => {
                    setAnimatingSlots((prev) => {
                        const next = new Set(prev);
                        next.delete(slotKey);
                        return next;
                    });
                }, 300);
            }
        }
        prevPickIndex = currentIndex;
    });

    const isSlotAnimating = (
        team: "blue" | "red",
        type: "pick" | "ban",
        slot: number
    ) => {
        return animatingSlots().has(`${team}-${type}-${slot}`);
    };

    // Socket listener registration - only re-runs when socket instance changes
    // Follows VersusWorkflow's deduplication pattern to avoid tearing down listeners
    // when unrelated dependencies (role, participantId) change.
    let draftSocketWithListeners: Socket | undefined = undefined;

    createEffect(() => {
        const socket = socketAccessor();
        const connectionStatus = connectionStatusAccessor();

        if (!socket || !socket.connected || connectionStatus !== "connected") {
            return;
        }

        // Skip if this socket already has listeners registered
        if (draftSocketWithListeners === socket) {
            return;
        }

        socket.on("heartbeat", (rawData: unknown) => {
            const data = validateSocketEvent("heartbeat", rawData, HeartbeatSchema);
            if (!data) return;
            if (
                data.timerStartedAt !== versusState().timerStartedAt ||
                data.currentPickIndex !== versusState().currentPickIndex
            ) {
                setVersusState((prev) => ({
                    ...prev,
                    timerStartedAt: data.timerStartedAt,
                    currentPickIndex: data.currentPickIndex
                }));
            }
            socket.emit("heartbeatAck", { role: myRole() });
        });

        // Listen for state sync
        socket.on("draftStateSync", (rawData: unknown) => {
            const data = validateSocketEvent(
                "draftStateSync",
                rawData,
                DraftStateSyncSchema
            );
            if (!data) return;
            queryClient.setQueryData(
                ["draft", params.draftId],
                (prev: draft | undefined) =>
                    prev
                        ? {
                              ...prev,
                              picks: data.picks,
                              completed: data.completed,
                              completedAt: data.completedAt
                          }
                        : prev
            );
            // Also sync picks into versusDraft.Drafts[] so restriction computation stays current
            queryClient.setQueryData(
                ["versusDraft", params.id],
                (prev: VersusDraft | undefined) => {
                    if (!prev?.Drafts) return prev;
                    return {
                        ...prev,
                        Drafts: prev.Drafts.map((d) =>
                            d.id === data.draftId
                                ? {
                                      ...d,
                                      picks: data.picks,
                                      completed: data.completed,
                                      completedAt: data.completedAt
                                  }
                                : d
                        )
                    };
                }
            );
            setVersusState({
                draftId: data.draftId,
                currentPickIndex: data.currentPickIndex,
                timerStartedAt: data.timerStartedAt,
                isPaused: data.isPaused,
                readyStatus: data.readyStatus,
                completed: data.completed,
                completedAt: data.completedAt,
                winner: data.winner,
                firstPick: data.firstPick,
                blueSideTeam: data.blueSideTeam
            });
            setHasSynced(true);
        });

        // Listen for ready updates
        socket.on("readyUpdate", (rawData: unknown) => {
            const data = validateSocketEvent("readyUpdate", rawData, ReadyUpdateSchema);
            if (!data) return;
            setVersusState((prev) => ({
                ...prev,
                readyStatus: { blue: data.blueReady, red: data.redReady }
            }));
        });

        // Listen for draft started
        socket.on("draftStarted", (rawData: unknown) => {
            const data = validateSocketEvent("draftStarted", rawData, DraftStartedSchema);
            if (!data) return;
            setVersusState((prev) => ({
                ...prev,
                timerStartedAt: data.timerStartedAt,
                currentPickIndex: data.currentPickIndex,
                firstPick: data.firstPick
            }));
            toast.success("Draft started!");
        });

        // Listen for draft updates
        socket.on("draftUpdate", (rawData: unknown) => {
            const data = validateSocketEvent("draftUpdate", rawData, DraftUpdateSchema);
            if (!data) return;
            queryClient.setQueryData(
                ["draft", params.draftId],
                (prev: draft | undefined) =>
                    prev
                        ? {
                              ...prev,
                              picks: data.picks,
                              completed: data.completed,
                              completedAt: data.completedAt
                          }
                        : prev
            );
            // Also sync picks into versusDraft.Drafts[] so restriction computation stays current
            queryClient.setQueryData(
                ["versusDraft", params.id],
                (prev: VersusDraft | undefined) => {
                    if (!prev?.Drafts) return prev;
                    return {
                        ...prev,
                        Drafts: prev.Drafts.map((d) =>
                            d.id === data.draftId
                                ? {
                                      ...d,
                                      picks: data.picks,
                                      completed: data.completed,
                                      completedAt: data.completedAt
                                  }
                                : d
                        )
                    };
                }
            );
            setVersusState((prev) => ({
                ...prev,
                currentPickIndex: data.currentPickIndex,
                timerStartedAt: data.timerStartedAt,
                isPaused: data.isPaused,
                completed: data.completed,
                completedAt: data.completedAt
            }));
        });

        // Listen for pause requests
        socket.on("pauseRequested", (rawData: unknown) => {
            const data = validateSocketEvent(
                "pauseRequested",
                rawData,
                PauseRequestedSchema
            );
            if (!data) return;
            // Only show modal if it's NOT your team requesting
            if (data.team !== myEffectiveSide()) {
                setPauseRequestType("pause");
                setPauseRequestTeam(data.team);
                setShowPauseRequest(true);
            }
        });

        // Listen for resume requests
        socket.on("resumeRequested", (rawData: unknown) => {
            const data = validateSocketEvent(
                "resumeRequested",
                rawData,
                ResumeRequestedSchema
            );
            if (!data) return;
            // Only show modal if it's NOT your team requesting
            if (data.team !== myEffectiveSide()) {
                setPauseRequestType("resume");
                setPauseRequestTeam(data.team);
                setShowPauseRequest(true);
            }
        });

        // Listen for resume countdown (no payload)
        socket.on("resumeCountdownStarted", () => {
            setShowPauseRequest(false);
            setIsCountingDown(true);
            setCountdownValue(3);

            // Show toast for requesting captain
            toast.success("Resume approved! Starting countdown...");

            // Countdown animation
            const interval = setInterval(() => {
                setCountdownValue((prev) => {
                    if (prev <= 1) {
                        clearInterval(interval);
                        setIsCountingDown(false);
                        return 3;
                    }
                    return prev - 1;
                });
            }, 1000);
        });

        // Listen for resume rejection (no payload)
        socket.on("resumeRejected", () => {
            toast.error("Resume request was rejected");
            setShowPauseRequest(false);
        });

        // Listen for pick change requests
        socket.on("pickChangeRequested", (rawData: unknown) => {
            const data = validateSocketEvent(
                "pickChangeRequested",
                rawData,
                PickChangeRequestedSchema
            );
            if (!data) return;
            setPendingPickChangeRequest(data);
            toast(
                `${data.team === "blue" ? versusDraftQuery.data?.blueTeamName : versusDraftQuery.data?.redTeamName} requested a pick change`
            );
        });

        // Listen for pick change rejections (no payload)
        socket.on("pickChangeRejected", () => {
            toast.error("Pick change request was rejected");
            setPendingPickChangeRequest(null);
        });

        // Listen for role availability
        socket.on("roleAvailable", (rawData: unknown) => {
            const data = validateSocketEvent(
                "roleAvailable",
                rawData,
                RoleAvailableSchema
            );
            if (!data) return;
            const vd = versusDraftQuery.data;
            const roleName =
                data.role === "team1_captain"
                    ? `${vd?.blueTeamName ?? "Team 1"} Captain`
                    : `${vd?.redTeamName ?? "Team 2"} Captain`;
            toast(`${roleName} is now available`, {
                duration: 5000
            });
        });

        // Listen for game settings updates (firstPick, blueSideTeam)
        socket.on("gameSettingsUpdate", (rawData: unknown) => {
            const data = validateSocketEvent(
                "gameSettingsUpdate",
                rawData,
                GameSettingsUpdateSchema
            );
            if (!data) return;
            if (data.draftId === params.draftId) {
                setVersusState((prev) => ({
                    ...prev,
                    firstPick: data.firstPick,
                    blueSideTeam: data.blueSideTeam
                }));
                queryClient.setQueryData(
                    ["draft", params.draftId],
                    (prev: draft | undefined) =>
                        prev
                            ? {
                                  ...prev,
                                  firstPick: data.firstPick,
                                  blueSideTeam: data.blueSideTeam
                              }
                            : prev
                );
            }
        });

        // Listen for winner updates
        socket.on("versusWinnerUpdate", (rawData: unknown) => {
            const data = validateSocketEvent(
                "versusWinnerUpdate",
                rawData,
                WinnerUpdateSchema
            );
            if (!data) return;
            if (data.draftId === params.draftId) {
                queryClient.setQueryData(
                    ["draft", params.draftId],
                    (prev: draft | undefined) =>
                        prev ? { ...prev, winner: data.winner } : prev
                );
                setVersusState((prev) => ({
                    ...prev,
                    winner: data.winner
                }));
            }
        });

        draftSocketWithListeners = socket;

        onCleanup(() => {
            if (draftSocketWithListeners === socket) {
                draftSocketWithListeners = undefined;
            }
            socket.off("heartbeat");
            socket.off("draftStateSync");
            socket.off("readyUpdate");
            socket.off("draftStarted");
            socket.off("draftUpdate");
            socket.off("pauseRequested");
            socket.off("resumeRequested");
            socket.off("resumeCountdownStarted");
            socket.off("resumeRejected");
            socket.off("pickChangeRequested");
            socket.off("pickChangeRejected");
            socket.off("roleAvailable");
            socket.off("versusWinnerUpdate");
            socket.off("gameSettingsUpdate");
        });
    });

    // Draft room membership - re-runs when socket, connection, role, or participant changes.
    // Handles initial join, role changes, and reconnection (no separate reconnection effect needed).
    createEffect(() => {
        const socket = socketAccessor();
        const connectionStatus = connectionStatusAccessor();
        const role = myRole();
        const pId = participantId();

        if (!socket || !socket.connected || connectionStatus !== "connected") {
            return;
        }

        socket.emit("joinVersusDraft", {
            versusDraftId: params.id,
            draftId: params.draftId,
            role,
            participantId: pId
        });

        onCleanup(() => {
            socket.emit("leaveVersusDraft", {
                versusDraftId: params.id,
                participantId: pId
            });
        });
    });

    // Register draft state with workflow context for FlowPanel
    // Before socket sync: use draftQuery.data for completed/winner (instant for completed drafts)
    // After socket sync: use versusState (real-time authoritative source)
    createEffect(() => {
        const draftData = draftQuery.data;
        const state = versusState();
        const synced = hasSynced();

        if (draftData && state) {
            const activeState: ActiveDraftState = {
                draftId: params.draftId,
                currentPickIndex: state.currentPickIndex,
                timerStartedAt: state.timerStartedAt,
                isPaused: state.isPaused,
                readyStatus: state.readyStatus,
                completed: synced ? state.completed : (draftData.completed ?? false),
                completedAt: synced ? state.completedAt : draftData.completedAt,
                winner: synced ? state.winner : draftData.winner,
                draft: draftData
            };
            registerDraftState(activeState);
        } else {
            unregisterDraftState();
        }

        onCleanup(() => {
            unregisterDraftState();
        });
    });

    // Helper functions
    const isMyTurn = () => {
        const state = versusState();
        if (state.completed || !state.timerStartedAt) return false;

        const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
        const currentPick = effectiveOrder[state.currentPickIndex];
        return currentPick?.team === myEffectiveSide();
    };

    const isSpectator = () => !myRole() || myRole() === "spectator";

    // Actions
    const handleReady = () => {
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("captainReady", {
            draftId: params.draftId,
            role: myRole()
        });
    };

    const handleUnready = () => {
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("captainUnready", {
            draftId: params.draftId,
            role: myRole()
        });
    };

    const handleLockIn = () => {
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("lockInPick", {
            draftId: params.draftId,
            role: myRole()
        });
    };

    const handleChampionSelect = (championIndex: string) => {
        if (!isMyTurn() || isSpectator()) return;
        const socket = socketAccessor();
        if (!socket) return;

        const state = versusState();
        const picksIndex = getPicksArrayIndex(
            state.currentPickIndex,
            state.firstPick || "blue"
        );

        // Optimistic: update cache immediately so highlight appears instantly
        queryClient.setQueryData(["draft", params.draftId], (prev: draft | undefined) =>
            prev
                ? {
                      ...prev,
                      picks: prev.picks.map((p: string, i: number) =>
                          i === picksIndex ? championIndex : p
                      )
                  }
                : prev
        );

        // Clicking a champion saves it as pending pick (visible to all)
        // User must click "Lock In" button to advance to next pick
        socket.emit(
            "versusPick",
            {
                draftId: params.draftId,
                champion: championIndex,
                role: myRole()
            },
            (response: { success: boolean; message?: string }) => {
                if (!response.success) {
                    // Rollback: clear the optimistic pick
                    queryClient.setQueryData(
                        ["draft", params.draftId],
                        (prev: draft | undefined) =>
                            prev
                                ? {
                                      ...prev,
                                      picks: prev.picks.map((p: string, i: number) =>
                                          i === picksIndex ? "" : p
                                      )
                                  }
                                : prev
                    );
                    toast.error(response.message || "Pick rejected");
                }
            }
        );
    };

    const declareWinnerMutation = useMutation(() => ({
        mutationFn: (winner: "blue" | "red" | null) =>
            completeDraft(params.draftId, { winner }),
        onSuccess: () => {
            toast.success("Winner declared!");
            setShowWinnerModal(false);
            setTimeout(() => navigate(`/versus/${params.id}`), 1000);
        },
        onError: (error: Error) => {
            console.error("Error declaring winner:", error);
            toast.error("Failed to declare winner");
        }
    }));

    const handleDeclareWinner = (winner: "blue" | "red" | null) => {
        declareWinnerMutation.mutate(winner);
    };

    const handlePause = () => {
        const state = versusState();
        const isCompetitive = versusDraftQuery.data?.competitive;
        const socket = socketAccessor();
        if (!socket) return;

        socket.emit("requestPause", {
            draftId: params.draftId,
            role: myRole()
        });

        // Show feedback in competitive mode
        if (isCompetitive) {
            if (state.isPaused) {
                toast("Resume request sent, waiting for other team's approval...", {
                    icon: "⏱️"
                });
            } else {
                toast("Pause request sent, waiting for other team's approval...", {
                    icon: "⏸️"
                });
            }
        }
    };

    const handleApproveRequest = () => {
        const socket = socketAccessor();
        if (!socket) return;
        if (pauseRequestType() === "pause") {
            socket.emit("approvePause", {
                draftId: params.draftId,
                role: myRole()
            });
        } else {
            socket.emit("approveResume", {
                draftId: params.draftId,
                role: myRole()
            });
        }
        setShowPauseRequest(false);
    };

    const handleRejectRequest = () => {
        const socket = socketAccessor();
        if (!socket) return;
        if (pauseRequestType() === "resume") {
            socket.emit("rejectResume", {
                draftId: params.draftId,
                role: myRole()
            });
        }
        setShowPauseRequest(false);
    };

    const handleRequestPickChange = (pickIndex: number, newChampion: string) => {
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("requestPickChange", {
            draftId: params.draftId,
            pickIndex,
            newChampion,
            role: myRole()
        });

        if (!versusDraftQuery.data?.competitive) {
            toast.success("Pick changed!");
        } else {
            toast("Pick change request sent, waiting for approval...");
        }
    };

    const handleApprovePickChange = (requestId: string) => {
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("respondPickChange", {
            draftId: params.draftId,
            requestId,
            approved: true,
            role: myRole()
        });
        setPendingPickChangeRequest(null);
        toast.success("Pick change approved!");
    };

    const handleRejectPickChange = (requestId: string) => {
        const socket = socketAccessor();
        if (!socket) return;
        socket.emit("respondPickChange", {
            draftId: params.draftId,
            requestId,
            approved: false,
            role: myRole()
        });
        setPendingPickChangeRequest(null);
        toast("Pick change rejected");
    };

    const getTeamPicks = (team: "blue" | "red") => {
        const picks = draftQuery.data?.picks || [];
        const startIndex = team === "blue" ? 10 : 15;
        return [0, 1, 2, 3, 4].map((slot) => picks[startIndex + slot]);
    };

    const getTeamBans = (team: "blue" | "red") => {
        const picks = draftQuery.data?.picks || [];
        const startIndex = team === "blue" ? 0 : 5;
        return [0, 1, 2, 3, 4].map((slot) => picks[startIndex + slot]);
    };

    // Check if a specific ban slot is the current active pick
    const isBanActive = (team: "blue" | "red", slot: number) => {
        const state = versusState();
        if (!draftStarted() || state.completed) return false;

        const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
        const currentPick = effectiveOrder[state.currentPickIndex];
        if (!currentPick || currentPick.type !== "ban") return false;

        return currentPick.team === team && currentPick.slot === slot;
    };

    // Check if a specific pick slot is the current active pick
    const isPickActive = (team: "blue" | "red", slot: number) => {
        const state = versusState();
        if (!draftStarted() || state.completed) return false;

        const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
        const currentPick = effectiveOrder[state.currentPickIndex];
        if (!currentPick || currentPick.type !== "pick") return false;

        return currentPick.team === team && currentPick.slot === slot;
    };

    const draftStarted = () => versusState().timerStartedAt !== null;

    const blueSideTeamName = () => {
        const vd = versusDraftQuery.data;
        const bst = versusState().blueSideTeam ?? draftQuery.data?.blueSideTeam ?? 1;
        if (!vd) return "Team 1";
        return bst === 1 ? vd.blueTeamName : vd.redTeamName;
    };

    const redSideTeamName = () => {
        const vd = versusDraftQuery.data;
        const bst = versusState().blueSideTeam ?? draftQuery.data?.blueSideTeam ?? 1;
        if (!vd) return "Team 2";
        return bst === 1 ? vd.redTeamName : vd.blueTeamName;
    };

    // Compute restricted champions for Fearless/Ironman modes (game-based restrictions only)
    const restrictedChampions = createMemo(() => {
        const vd = versusDraftQuery.data;
        const d = draftQuery.data;
        if (!vd || !d) return [];
        return getRestrictedChampions(
            vd.type || "standard",
            vd.Drafts || [],
            d.seriesIndex ?? 0
        );
    });

    // Compute restricted champions by game for Restricted tab display
    const restrictedByGame = createMemo(() => {
        const vd = versusDraftQuery.data;
        const d = draftQuery.data;
        if (!vd || !d) return [];
        return getRestrictedChampionsByGame(
            vd.type || "standard",
            vd.Drafts || [],
            d.seriesIndex ?? 0
        );
    });

    // Map champion ID → { gameNumber, pickIndex } for overlay badges
    const restrictedChampionGameMap = createMemo(() => {
        const map = new Map<string, { gameNumber: number; pickIndex: number }>();
        for (const game of restrictedByGame()) {
            // blueBans → picks indices 0-4, redBans → 5-9
            // bluePicks → 10-14, redPicks → 15-19
            const entries: [string[], number][] = [
                [game.blueBans, 0],
                [game.redBans, 5],
                [game.bluePicks, 10],
                [game.redPicks, 15]
            ];
            for (const [arr, offset] of entries) {
                arr.forEach((id, i) => {
                    if (id && id !== "")
                        map.set(id, {
                            gameNumber: game.gameNumber,
                            pickIndex: offset + i
                        });
                });
            }
        }
        return map;
    });

    // Get the next game in the series (if any)
    const nextGame = createMemo(() => {
        const vd = versusDraftQuery.data;
        const d = draftQuery.data;
        if (!vd || !d || !vd.Drafts) return null;

        const currentIndex = d.seriesIndex ?? 0;
        const nextIndex = currentIndex + 1;

        // No next game if we're at the end of the series
        if (nextIndex >= vd.length) return null;

        // Find the next game by seriesIndex
        return vd.Drafts.find((game) => game.seriesIndex === nextIndex) || null;
    });

    // Check if the current pick slot has a pending champion selected
    const hasPendingPick = (): boolean => {
        const state = versusState();
        const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
        if (state.completed || state.currentPickIndex >= effectiveOrder.length)
            return false;
        const picks = draftQuery.data?.picks || [];
        const picksIndex = getPicksArrayIndex(
            state.currentPickIndex,
            versusState().firstPick || "blue"
        );
        return !!(picks[picksIndex] && picks[picksIndex] !== "");
    };

    // Get the current pending champion (for highlighting in the grid)
    const getCurrentPendingChampion = () => {
        const state = versusState();
        const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
        if (state.completed || state.currentPickIndex >= effectiveOrder.length)
            return null;
        const picks = draftQuery.data?.picks || [];
        const picksIndex = getPicksArrayIndex(
            state.currentPickIndex,
            versusState().firstPick || "blue"
        );
        return picks[picksIndex] || null;
    };

    // Register draft callbacks with workflow context for FlowPanel controls
    createEffect(() => {
        const callbacks: DraftCallbacks = {
            handlePause,
            handleReady,
            handleUnready,
            handleLockIn,
            isMyTurn,
            hasPendingPick,
            draftStarted,
            handleRequestPickChange,
            handleApprovePickChange,
            handleRejectPickChange,
            pendingPickChangeRequest
        };
        registerDraftCallbacks(callbacks);

        onCleanup(() => {
            unregisterDraftCallbacks();
        });
    });

    return (
        <Show
            when={!versusDraftQuery.isPending && !draftQuery.isPending}
            fallback={<div class="p-8">Loading...</div>}
        >
            <Show when={versusDraftQuery.data && draftQuery.data}>
                {/* Per-game role confirmation overlay */}
                <Show when={needsGameConfirm()}>
                    <div class="flex h-full min-w-0 flex-1 flex-col items-center justify-center bg-slate-900">
                        <div class="w-full max-w-md overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-800/90 shadow-2xl">
                            <div class="p-8 text-center">
                                <div
                                    class={`mb-4 text-sm font-semibold uppercase tracking-wider ${gameTextColors[(draftQuery.data?.seriesIndex ?? 0) + 1] ?? "text-slate-500"}`}
                                >
                                    Game {(draftQuery.data?.seriesIndex ?? 0) + 1}
                                </div>
                                <Show when={myTeamIdentity() && gameSuggestedSide()}>
                                    <p class="text-sm text-slate-300">
                                        You are on{" "}
                                        <span class="font-semibold text-slate-100">
                                            {myTeamIdentity()}
                                        </span>
                                        . This game, your team is on{" "}
                                        <span
                                            class={`font-semibold ${
                                                gameSuggestedSide() === "blue"
                                                    ? "text-blue-400"
                                                    : "text-red-400"
                                            }`}
                                        >
                                            {gameSuggestedSide()} side
                                        </span>
                                        .
                                    </p>
                                </Show>
                            </div>
                            <div class="border-t border-slate-700/50 px-8 py-4">
                                <div class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                    Game Settings
                                </div>
                                <GameSettingsGrid
                                    draftId={params.draftId}
                                    teamOneName={
                                        versusDraftQuery.data?.blueTeamName ?? ""
                                    }
                                    teamTwoName={versusDraftQuery.data?.redTeamName ?? ""}
                                    blueSideTeam={
                                        (versusState().blueSideTeam || 1) as 1 | 2
                                    }
                                    firstPick={versusState().firstPick || "blue"}
                                    canEdit={true}
                                    onSettingsChange={handleConfirmSettingsChange}
                                />
                            </div>
                            <div class="border-t border-slate-700/50 px-8 pb-8 pt-4 text-center">
                                <button
                                    class="w-full rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-semibold text-slate-50 transition-colors hover:bg-orange-500"
                                    onClick={handleConfirmGame}
                                >
                                    Continue as {myTeamIdentity()} Captain
                                </button>
                                <button
                                    class="mt-2 block w-full text-xs text-slate-500 transition-colors hover:text-slate-400"
                                    onClick={() => {
                                        const vd = versusContext().versusDraft;
                                        if (vd) navigate(`/versus/join/${vd.shareLink}`);
                                    }}
                                >
                                    Switch teams
                                </button>
                            </div>
                        </div>
                    </div>
                </Show>
                <Show when={!needsGameConfirm()}>
                    <div class="flex h-full min-w-0 flex-1 flex-col bg-slate-900">
                        {/* Main Content */}
                        <div class="flex flex-1 overflow-hidden">
                            {/* Drafts Display - now takes full remaining width */}
                            <div class="flex min-w-0 flex-1 flex-col p-6">
                                {/* Team Names */}
                                <div class="mb-4 flex items-center">
                                    {/* Blue Team */}
                                    <div class="flex min-w-0 flex-1 flex-col items-start gap-1">
                                        <div class="h-5">
                                            <Show
                                                when={
                                                    (versusState().firstPick ||
                                                        "blue") === "blue"
                                                }
                                            >
                                                <span class="rounded border border-amber-500/30 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                                                    1st Pick
                                                </span>
                                            </Show>
                                        </div>
                                        <div class="text-xl font-bold text-blue-400">
                                            {blueSideTeamName()}
                                        </div>
                                        <Show when={!draftStarted()}>
                                            <div
                                                class={`flex items-center gap-2 rounded px-3 py-1 text-xs font-semibold uppercase tracking-wider transition-all duration-300 ${
                                                    versusState().readyStatus.blue
                                                        ? "border border-emerald-500/50 bg-emerald-500/20 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                                                        : "border border-slate-600/50 bg-slate-700/50 text-slate-500"
                                                }`}
                                            >
                                                <div
                                                    class={`h-2 w-2 rounded-full transition-all duration-300 ${
                                                        versusState().readyStatus.blue
                                                            ? "animate-pulse bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                                                            : "bg-slate-500"
                                                    }`}
                                                />
                                                <span>
                                                    {versusState().readyStatus.blue
                                                        ? "Ready"
                                                        : "Not Ready"}
                                                </span>
                                            </div>
                                        </Show>
                                    </div>
                                    <div class="flex flex-col items-center gap-1">
                                        <span
                                            class={`rounded bg-slate-700 px-2 py-0.5 text-xs font-semibold ${gameTextColors[(draftQuery.data?.seriesIndex ?? 0) + 1] ?? "text-slate-300"}`}
                                        >
                                            Game {(draftQuery.data?.seriesIndex ?? 0) + 1}
                                        </span>
                                        <span class="text-slate-500">vs</span>
                                        <Show
                                            when={!versusState().completed}
                                            fallback={
                                                <Show when={nextGame()}>
                                                    <button
                                                        onClick={() =>
                                                            navigate(
                                                                `/versus/${params.id}/draft/${nextGame()?.id ?? ""}`
                                                            )
                                                        }
                                                        class="group mt-1 flex items-center gap-2 text-orange-400 transition-colors hover:text-orange-300"
                                                    >
                                                        <span class="text-sm font-medium">
                                                            Next Game
                                                        </span>
                                                        <span class="transition-transform group-hover:translate-x-1">
                                                            →
                                                        </span>
                                                    </button>
                                                </Show>
                                            }
                                        >
                                            <VersusTimer
                                                timerStartedAt={
                                                    versusState().timerStartedAt
                                                }
                                                duration={30}
                                                isPaused={versusState().isPaused}
                                            />
                                        </Show>
                                    </div>
                                    {/* Red Team */}
                                    <div class="flex min-w-0 flex-1 flex-col items-end gap-1">
                                        <div class="h-5">
                                            <Show
                                                when={
                                                    (versusState().firstPick ||
                                                        "blue") === "red"
                                                }
                                            >
                                                <span class="rounded border border-amber-500/30 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                                                    1st Pick
                                                </span>
                                            </Show>
                                        </div>
                                        <div class="text-xl font-bold text-red-400">
                                            {redSideTeamName()}
                                        </div>
                                        <Show when={!draftStarted()}>
                                            <div
                                                class={`flex items-center gap-2 rounded px-3 py-1 text-xs font-semibold uppercase tracking-wider transition-all duration-300 ${
                                                    versusState().readyStatus.red
                                                        ? "border border-emerald-500/50 bg-emerald-500/20 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                                                        : "border border-slate-600/50 bg-slate-700/50 text-slate-500"
                                                }`}
                                            >
                                                <div
                                                    class={`h-2 w-2 rounded-full transition-all duration-300 ${
                                                        versusState().readyStatus.red
                                                            ? "animate-pulse bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.6)]"
                                                            : "bg-slate-500"
                                                    }`}
                                                />
                                                <span>
                                                    {versusState().readyStatus.red
                                                        ? "Ready"
                                                        : "Not Ready"}
                                                </span>
                                            </div>
                                        </Show>
                                    </div>
                                </div>

                                {/* Bans */}
                                <div class="mb-6 mt-2">
                                    <div class="flex justify-between gap-[clamp(1rem,5vw,6rem)]">
                                        <div class="flex min-w-0 flex-1 gap-2">
                                            <For each={getTeamBans("blue")}>
                                                {(ban, index) => (
                                                    <div
                                                        class={`relative aspect-square flex-1 overflow-hidden rounded border-2 bg-slate-800 transition-all ${
                                                            isBanActive("blue", index())
                                                                ? "animate-pulse border-orange-400 ring-4 ring-orange-400/50"
                                                                : "border-blue-600/30"
                                                        }`}
                                                    >
                                                        <Show when={ban && ban !== ""}>
                                                            <img
                                                                src={
                                                                    champions[
                                                                        parseInt(ban)
                                                                    ].img
                                                                }
                                                                alt=""
                                                                class="h-full w-full object-cover"
                                                            />
                                                            <div class="absolute inset-0 flex items-center justify-center">
                                                                <div class="h-[100%] w-1 -rotate-45 bg-slate-200" />
                                                            </div>
                                                        </Show>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                        <div class="flex min-w-0 flex-1 gap-2">
                                            <For each={getTeamBans("red")}>
                                                {(ban, index) => (
                                                    <div
                                                        class={`relative aspect-square flex-1 overflow-hidden rounded border-2 bg-slate-800 transition-all ${
                                                            isBanActive("red", index())
                                                                ? "animate-pulse border-orange-400 ring-4 ring-orange-400/50"
                                                                : "border-red-600/30"
                                                        }`}
                                                    >
                                                        <Show when={ban && ban !== ""}>
                                                            <img
                                                                src={
                                                                    champions[
                                                                        parseInt(ban)
                                                                    ].img
                                                                }
                                                                alt=""
                                                                class="h-full w-full object-cover"
                                                            />
                                                            <div class="absolute inset-0 flex items-center justify-center">
                                                                <div class="h-[100%] w-1 -rotate-45 bg-slate-200" />
                                                            </div>
                                                        </Show>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </div>
                                </div>

                                {/* Picks */}
                                <div class="mb-6 flex min-h-0 flex-1 gap-[clamp(1rem,4vw,6rem)]">
                                    {/* Blue Picks */}
                                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                                        <div class="flex min-h-0 flex-1 flex-col gap-2">
                                            <For each={getTeamPicks("blue")}>
                                                {(pick, index) => (
                                                    <div
                                                        class={`relative min-h-0 flex-1 overflow-hidden rounded border-2 bg-slate-900 transition-all ${
                                                            isPickActive("blue", index())
                                                                ? "animate-pulse border-orange-400 ring-4 ring-orange-400/50"
                                                                : "border-blue-600/30"
                                                        } ${isSlotAnimating("blue", "pick", index()) ? "animate-pop" : ""}`}
                                                    >
                                                        <Show when={pick && pick !== ""}>
                                                            <img
                                                                src={getSplashUrl(
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                )}
                                                                alt={
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                }
                                                                class="h-full w-full -translate-x-[15%] scale-[1.25] object-cover object-[center_25%]"
                                                            />
                                                            <div class="absolute inset-0 bg-gradient-to-r from-transparent via-transparent via-50% to-black" />
                                                            <span class="absolute bottom-2 right-3 text-lg font-semibold tracking-wide text-slate-100 drop-shadow-lg">
                                                                {
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                }
                                                            </span>
                                                        </Show>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </div>

                                    {/* Red Picks */}
                                    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                                        <div class="flex min-h-0 flex-1 flex-col gap-2">
                                            <For each={getTeamPicks("red")}>
                                                {(pick, index) => (
                                                    <div
                                                        class={`relative min-h-0 flex-1 overflow-hidden rounded border-2 bg-slate-900 transition-all ${
                                                            isPickActive("red", index())
                                                                ? "animate-pulse border-orange-400 ring-4 ring-orange-400/50"
                                                                : "border-red-600/30"
                                                        } ${isSlotAnimating("red", "pick", index()) ? "animate-pop" : ""}`}
                                                    >
                                                        <Show when={pick && pick !== ""}>
                                                            <img
                                                                src={getSplashUrl(
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                )}
                                                                alt={
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                }
                                                                class="h-full w-full translate-x-[15%] scale-[1.25] object-cover object-[center_25%]"
                                                            />
                                                            <div class="absolute inset-0 bg-gradient-to-l from-transparent via-transparent via-50% to-black" />
                                                            <span class="absolute bottom-2 left-3 text-lg font-semibold tracking-wide text-slate-100 drop-shadow-lg">
                                                                {
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                }
                                                            </span>
                                                        </Show>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </div>
                                </div>

                                {/* Ready/Lock In Button or Resume Button */}
                                <Show when={!versusState().completed}>
                                    <div class="flex justify-center">
                                        <Show
                                            when={
                                                versusState().isPaused &&
                                                draftStarted() &&
                                                !isSpectator()
                                            }
                                            fallback={
                                                <ReadyButton
                                                    isReady={
                                                        myEffectiveSide() === "blue"
                                                            ? versusState().readyStatus
                                                                  .blue
                                                            : versusState().readyStatus
                                                                  .red
                                                    }
                                                    opponentReady={
                                                        myEffectiveSide() === "blue"
                                                            ? versusState().readyStatus
                                                                  .red
                                                            : versusState().readyStatus
                                                                  .blue
                                                    }
                                                    draftStarted={draftStarted()}
                                                    isSpectator={isSpectator()}
                                                    onReady={handleReady}
                                                    onUnready={handleUnready}
                                                    onLockIn={handleLockIn}
                                                    disabled={
                                                        !isMyTurn() ||
                                                        !hasPendingPick() ||
                                                        versusState().isPaused
                                                    }
                                                />
                                            }
                                        >
                                            <button
                                                onClick={handlePause}
                                                class="w-52 rounded-lg border-2 border-orange-500/60 bg-orange-500/15 py-4 text-center text-[0.95rem] font-bold uppercase tracking-wider text-orange-400 transition-all duration-300 ease-out hover:scale-105 hover:bg-orange-500/25 active:scale-95"
                                            >
                                                Resume Draft
                                            </button>
                                        </Show>
                                    </div>
                                </Show>
                            </div>

                            {/* Champion Panel */}
                            <ChampionPanel
                                restrictedByGame={restrictedByGame}
                                restrictedChampions={restrictedChampions}
                                restrictedChampionGameMap={restrictedChampionGameMap}
                                disabledChampions={() =>
                                    versusDraftQuery.data?.disabledChampions ?? []
                                }
                                draft={() => draftQuery.data}
                                versusDraft={() => versusDraftQuery.data}
                                isMyTurn={isMyTurn}
                                isPaused={() => versusState().isPaused}
                                getCurrentPendingChampion={getCurrentPendingChampion}
                                onChampionSelect={handleChampionSelect}
                            />
                        </div>

                        {/* Modals */}
                        <WinnerDeclarationModal
                            isOpen={showWinnerModal()}
                            blueTeamName={versusDraftQuery.data?.blueTeamName ?? ""}
                            redTeamName={versusDraftQuery.data?.redTeamName ?? ""}
                            onDeclareWinner={handleDeclareWinner}
                            isSpectator={isSpectator()}
                        />

                        <PauseRequestModal
                            isOpen={showPauseRequest()}
                            requestType={pauseRequestType()}
                            requestingTeam={pauseRequestTeam()}
                            blueSideTeam={
                                versusState().blueSideTeam ??
                                draftQuery.data?.blueSideTeam ??
                                1
                            }
                            blueTeamName={versusDraftQuery.data?.blueTeamName ?? ""}
                            redTeamName={versusDraftQuery.data?.redTeamName ?? ""}
                            onApprove={handleApproveRequest}
                            onReject={handleRejectRequest}
                        />

                        {/* Resume Countdown Overlay */}
                        <Show when={isCountingDown()}>
                            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                                <div class="text-center">
                                    <div class="mb-4 animate-pulse text-9xl font-bold text-orange-400">
                                        {countdownValue()}
                                    </div>
                                    <p class="text-2xl font-semibold text-slate-300">
                                        Resuming...
                                    </p>
                                </div>
                            </div>
                        </Show>
                    </div>
                </Show>
            </Show>
        </Show>
    );
};

export default VersusDraftView;
