import {
    Component,
    createSignal,
    createEffect,
    createMemo,
    onCleanup,
    For,
    Show,
    createResource
} from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { useUser } from "../userProvider";
import {
    useVersusContext,
    ActiveDraftState,
    DraftCallbacks,
    getSuggestedRole
} from "../workflows/VersusWorkflow";
import { VersusDraft, draft, VersusState } from "../utils/types";
import { getEffectivePickOrder, getPicksArrayIndex } from "../utils/versusPickOrder";
import { VersusTimer } from "../components/VersusTimer";
import { ReadyButton } from "../components/ReadyButton";
import { WinnerDeclarationModal } from "../components/WinnerDeclarationModal";
import { PauseRequestModal } from "../components/PauseRequestModal";
import { GameSettingsGrid } from "../components/GameSettingsGrid";
import { champions, championCategories } from "../utils/constants";
import toast from "solid-toast";
import { useFilterableItems } from "../hooks/useFilterableItems";
import { FilterBar } from "../components/FilterBar";
import BlankSquare from "/src/assets/BlankSquare.webp";
import {
    getRestrictedChampions,
    getRestrictedChampionsByGame
} from "../utils/seriesRestrictions";

const fetchVersusDraft = async (id: string): Promise<VersusDraft> => {
    const response = await fetch(
        `${import.meta.env.VITE_API_URL}/api/versus-drafts/${id}`,
        {
            credentials: "include"
        }
    );
    if (!response.ok) throw new Error("Failed to fetch versus draft");
    return response.json();
};

const fetchDraft = async (id: string): Promise<draft> => {
    const response = await fetch(`${import.meta.env.VITE_API_URL}/api/drafts/${id}`, {
        credentials: "include"
    });
    if (!response.ok) throw new Error("Failed to fetch draft");
    return response.json();
};

const VersusDraftView: Component = () => {
    const params = useParams<{ id: string; draftId: string }>();
    const navigate = useNavigate();
    const accessor = useUser();
    const [, , socketAccessor, connectionStatusAccessor] = accessor();

    // Track disconnection state for reconnection handling
    const [wasDisconnected, setWasDisconnected] = createSignal(false);

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
    const myRole = createMemo(() => versusContext().myParticipant?.role || null);
    const participantId = createMemo(() => versusContext().myParticipant?.id || null);
    const [versusDraft] = createResource(() => params.id, fetchVersusDraft);

    // Per-game role re-prompt: track whether user needs to confirm role for this game
    const [needsGameConfirm, setNeedsGameConfirm] = createSignal(false);

    createEffect(() => {
        const role = myRole();
        const draftId = params.draftId;
        const identity = myTeamIdentity();
        const d = draft();
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

    // Optimistic handlers for game settings in the confirmation overlay
    const handleConfirmSetFirstPick = (id: string, fp: "blue" | "red") => {
        setVersusState((prev) => ({ ...prev, firstPick: fp }));
        setGameSettings(id, { firstPick: fp });
    };
    const handleConfirmSetBlueSideTeam = (id: string, bst: 1 | 2) => {
        setVersusState((prev) => ({ ...prev, blueSideTeam: bst }));
        setGameSettings(id, { blueSideTeam: bst });
    };

    // Compute suggested role for re-prompt overlay
    const gameSuggestedRole = createMemo(() => {
        const vd = versusDraft();
        const identity = myTeamIdentity();
        if (!vd || !identity) return null;
        const bst = versusState().blueSideTeam || draft()?.blueSideTeam || 1;
        return getSuggestedRole(identity, bst, vd.blueTeamName, vd.redTeamName);
    });
    const [draft, { mutate: mutateDraft }] = createResource(
        () => params.draftId,
        fetchDraft
    );
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
    const [showWinnerModal, setShowWinnerModal] = createSignal(false);
    const [showPauseRequest, setShowPauseRequest] = createSignal(false);
    const [pauseRequestType, setPauseRequestType] = createSignal<"pause" | "resume">(
        "pause"
    );
    const [pauseRequestTeam, setPauseRequestTeam] = createSignal<"blue" | "red">("blue");
    const [isCountingDown, setIsCountingDown] = createSignal(false);
    const [countdownValue, setCountdownValue] = createSignal(3);
    const [pendingPickChangeRequest, setPendingPickChangeRequest] =
        createSignal<any>(null);
    const [activeTab, setActiveTab] = createSignal<"pick" | "restricted">("pick");

    // Champion filtering
    const {
        searchText,
        setSearchText,
        selectedCategory,
        setSelectedCategory,
        filteredItems: filteredChampions,
        categories: championCategoryList
    } = useFilterableItems({
        items: champions,
        categoryMap: championCategories
    });

    // Socket.IO setup - only run when socket/role/participant change, not when draft updates
    createEffect(() => {
        const socket = socketAccessor();
        const role = myRole();
        const pId = participantId();

        if (!socket) {
            return null;
        }

        // Join versus draft room
        socket.emit("joinVersusDraft", {
            versusDraftId: params.id,
            draftId: params.draftId,
            role,
            participantId: pId
        });

        socket.on("heartbeat", (data: any) => {
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
        socket.on("draftStateSync", (data: any) => {
            mutateDraft((prev) => ({
                ...prev!,
                picks: data.picks,
                completed: data.completed
            }));
            setVersusState({
                draftId: data.draftId,
                currentPickIndex: data.currentPickIndex,
                timerStartedAt: data.timerStartedAt,
                isPaused: data.isPaused,
                readyStatus: data.readyStatus,
                completed: data.completed,
                winner: data.winner,
                firstPick: data.firstPick,
                blueSideTeam: data.blueSideTeam
            });
        });

        // Listen for ready updates
        socket.on("readyUpdate", (data: any) => {
            setVersusState((prev) => ({
                ...prev,
                readyStatus: { blue: data.blueReady, red: data.redReady }
            }));
        });

        // Listen for draft started
        socket.on("draftStarted", (data: any) => {
            setVersusState((prev) => ({
                ...prev,
                timerStartedAt: data.timerStartedAt,
                currentPickIndex: data.currentPickIndex,
                firstPick: data.firstPick
            }));
            toast.success("Draft started!");
        });

        // Listen for draft updates
        socket.on("draftUpdate", (data: any) => {
            mutateDraft((prev) => ({
                ...prev!,
                picks: data.picks,
                completed: data.completed
            }));
            setVersusState((prev) => ({
                ...prev,
                currentPickIndex: data.currentPickIndex,
                timerStartedAt: data.timerStartedAt,
                isPaused: data.isPaused,
                completed: data.completed
            }));
        });

        // Listen for pause requests
        socket.on("pauseRequested", (data: any) => {
            const myTeam = role?.includes("blue") ? "blue" : "red";
            // Only show modal if it's NOT your team requesting
            if (data.team !== myTeam) {
                setPauseRequestType("pause");
                setPauseRequestTeam(data.team);
                setShowPauseRequest(true);
            }
        });

        // Listen for resume requests
        socket.on("resumeRequested", (data: any) => {
            const myTeam = role?.includes("blue") ? "blue" : "red";
            // Only show modal if it's NOT your team requesting
            if (data.team !== myTeam) {
                setPauseRequestType("resume");
                setPauseRequestTeam(data.team);
                setShowPauseRequest(true);
            }
        });

        // Listen for resume countdown
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

        // Listen for resume rejection
        socket.on("resumeRejected", () => {
            toast.error("Resume request was rejected");
            setShowPauseRequest(false);
        });

        // Listen for pick change requests
        socket.on("pickChangeRequested", (data: any) => {
            setPendingPickChangeRequest(data);
            toast(
                `${data.team === "blue" ? versusDraft()?.blueTeamName : versusDraft()?.redTeamName} requested a pick change`
            );
        });

        // Listen for pick change rejections
        socket.on("pickChangeRejected", () => {
            toast.error("Pick change request was rejected");
            setPendingPickChangeRequest(null);
        });

        // Listen for role availability
        socket.on("roleAvailable", (data: any) => {
            toast(`${data.role.replace("_", " ")} is now available`, {
                duration: 5000
            });
        });

        // Listen for game settings updates (firstPick, blueSideTeam)
        socket.on("gameSettingsUpdate", (data: any) => {
            if (data.draftId === params.draftId) {
                setVersusState((prev) => ({
                    ...prev,
                    firstPick: data.firstPick,
                    blueSideTeam: data.blueSideTeam
                }));
            }
        });

        // Listen for winner updates
        socket.on(
            "versusWinnerUpdate",
            (data: { draftId: string; winner: "blue" | "red" }) => {
                if (data.draftId === params.draftId) {
                    mutateDraft((prev) => ({
                        ...prev!,
                        winner: data.winner
                    }));
                    setVersusState((prev) => ({
                        ...prev,
                        winner: data.winner
                    }));
                }
            }
        );

        onCleanup(() => {
            socket.emit("leaveVersusDraft", {
                versusDraftId: params.id,
                participantId: pId
            });
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

    // Track disconnection and rejoin draft room on reconnect
    createEffect(() => {
        const status = connectionStatusAccessor();

        if (status === "disconnected" || status === "connecting") {
            setWasDisconnected(true);
        } else if (status === "connected" && wasDisconnected()) {
            setWasDisconnected(false);

            // Reconnected - rejoin the draft room
            const socket = socketAccessor();
            if (socket) {
                socket.emit("joinVersusDraft", {
                    versusDraftId: params.id,
                    draftId: params.draftId,
                    role: myRole(),
                    participantId: participantId()
                });
            }
        }
    });

    // Register draft state with workflow context for FlowPanel
    createEffect(() => {
        const draftData = draft();
        const state = versusState();

        if (draftData && state) {
            const activeState: ActiveDraftState = {
                draftId: params.draftId,
                currentPickIndex: state.currentPickIndex,
                timerStartedAt: state.timerStartedAt,
                isPaused: state.isPaused,
                readyStatus: state.readyStatus,
                completed: state.completed,
                winner: state.winner,
                draft: draftData
            };
            registerDraftState(activeState);
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
        const myTeam = myRole()?.includes("blue") ? "blue" : "red";
        return currentPick?.team === myTeam;
    };

    const isSpectator = () => myRole() === "spectator";

    const getCurrentPickInfo = () => {
        const state = versusState();
        const effectiveOrder = getEffectivePickOrder(state.firstPick || "blue");
        if (state.currentPickIndex >= effectiveOrder.length) return null;
        return effectiveOrder[state.currentPickIndex];
    };

    // Actions
    const handleReady = () => {
        socketAccessor().emit("captainReady", {
            draftId: params.draftId,
            role: myRole()
        });
    };

    const handleUnready = () => {
        socketAccessor().emit("captainUnready", {
            draftId: params.draftId,
            role: myRole()
        });
    };

    const handleLockIn = () => {
        socketAccessor().emit("lockInPick", {
            draftId: params.draftId,
            role: myRole()
        });
    };

    const handleChampionSelect = (championIndex: string) => {
        if (!isMyTurn() || isSpectator()) return;

        // Clicking a champion saves it as pending pick (visible to all)
        // User must click "Lock In" button to advance to next pick
        socketAccessor().emit("versusPick", {
            draftId: params.draftId,
            champion: championIndex,
            role: myRole()
        });
    };

    const handleDeclareWinner = async (winner: "blue" | "red" | null) => {
        try {
            const response = await fetch(
                `${import.meta.env.VITE_API_URL}/api/drafts/${params.draftId}/complete`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ winner })
                }
            );

            if (!response.ok) throw new Error("Failed to declare winner");

            toast.success("Winner declared!");
            setShowWinnerModal(false);

            // Navigate back to series overview
            setTimeout(() => {
                navigate(`/versus/${params.id}`);
            }, 1000);
        } catch (error) {
            console.error("Error declaring winner:", error);
            toast.error("Failed to declare winner");
        }
    };

    const handlePause = () => {
        const state = versusState();
        const isCompetitive = versusDraft()?.competitive;

        socketAccessor().emit("requestPause", {
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
        if (pauseRequestType() === "pause") {
            socketAccessor().emit("approvePause", {
                draftId: params.draftId,
                role: myRole()
            });
        } else {
            socketAccessor().emit("approveResume", {
                draftId: params.draftId,
                role: myRole()
            });
        }
        setShowPauseRequest(false);
    };

    const handleRejectRequest = () => {
        if (pauseRequestType() === "resume") {
            socketAccessor().emit("rejectResume", {
                draftId: params.draftId,
                role: myRole()
            });
        }
        setShowPauseRequest(false);
    };

    const handleRequestPickChange = (pickIndex: number, newChampion: string) => {
        socketAccessor().emit("requestPickChange", {
            draftId: params.draftId,
            pickIndex,
            newChampion,
            role: myRole()
        });

        if (!versusDraft()?.competitive) {
            toast.success("Pick changed!");
        } else {
            toast("Pick change request sent, waiting for approval...");
        }
    };

    const handleApprovePickChange = (requestId: string) => {
        socketAccessor().emit("respondPickChange", {
            draftId: params.draftId,
            requestId,
            approved: true,
            role: myRole()
        });
        setPendingPickChangeRequest(null);
        toast.success("Pick change approved!");
    };

    const handleRejectPickChange = (requestId: string) => {
        socketAccessor().emit("respondPickChange", {
            draftId: params.draftId,
            requestId,
            approved: false,
            role: myRole()
        });
        setPendingPickChangeRequest(null);
        toast("Pick change rejected");
    };

    const getTeamPicks = (team: "blue" | "red") => {
        const picks = draft()?.picks || [];
        const startIndex = team === "blue" ? 10 : 15;
        return [0, 1, 2, 3, 4].map((slot) => picks[startIndex + slot]);
    };

    const getTeamBans = (team: "blue" | "red") => {
        const picks = draft()?.picks || [];
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
        const vd = versusDraft();
        const bst = versusState().blueSideTeam ?? draft()?.blueSideTeam ?? 1;
        if (!vd) return "Blue Team";
        return bst === 1 ? vd.blueTeamName : vd.redTeamName;
    };

    const redSideTeamName = () => {
        const vd = versusDraft();
        const bst = versusState().blueSideTeam ?? draft()?.blueSideTeam ?? 1;
        if (!vd) return "Red Team";
        return bst === 1 ? vd.redTeamName : vd.blueTeamName;
    };

    // Compute restricted champions for Fearless/Ironman modes
    const restrictedChampions = createMemo(() => {
        const vd = versusDraft();
        const d = draft();
        if (!vd || !d) return [];
        return getRestrictedChampions(
            vd.type || "standard",
            vd.Drafts || [],
            d.seriesIndex ?? 0
        );
    });

    // Compute restricted champions by game for Restricted tab display
    const restrictedByGame = createMemo(() => {
        const vd = versusDraft();
        const d = draft();
        if (!vd || !d) return [];
        return getRestrictedChampionsByGame(
            vd.type || "standard",
            vd.Drafts || [],
            d.seriesIndex ?? 0
        );
    });

    // Check if Restricted tab should be shown (not Standard mode)
    const showRestrictedTab = createMemo(() => {
        const vd = versusDraft();
        return vd && vd.type && vd.type !== "standard";
    });

    // Get the next game in the series (if any)
    const nextGame = createMemo(() => {
        const vd = versusDraft();
        const d = draft();
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
        const picks = draft()?.picks || [];
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
        const picks = draft()?.picks || [];
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
            when={!versusDraft.loading && !draft.loading}
            fallback={<div class="p-8">Loading...</div>}
        >
            <Show when={versusDraft() && draft()}>
                {/* Per-game role confirmation overlay */}
                <Show when={needsGameConfirm()}>
                    <div class="flex h-full min-w-0 flex-1 flex-col items-center justify-center bg-slate-900">
                        <div class="w-full max-w-md overflow-hidden rounded-2xl border border-slate-700/50 bg-slate-800/90 shadow-2xl">
                            <div class="p-8 text-center">
                                <div class="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-500">
                                    Game {(draft()?.seriesIndex ?? 0) + 1}
                                </div>
                                <Show when={myTeamIdentity() && gameSuggestedRole()}>
                                    <p class="text-sm text-slate-300">
                                        You are on{" "}
                                        <span class="font-semibold text-slate-100">
                                            {myTeamIdentity()}
                                        </span>
                                        . This game, your team is on{" "}
                                        <span
                                            class={`font-semibold ${
                                                gameSuggestedRole() === "blue_captain"
                                                    ? "text-blue-400"
                                                    : "text-red-400"
                                            }`}
                                        >
                                            {gameSuggestedRole()?.includes("blue")
                                                ? "blue"
                                                : "red"}{" "}
                                            side
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
                                    teamOneName={versusDraft()?.blueTeamName ?? ""}
                                    teamTwoName={versusDraft()?.redTeamName ?? ""}
                                    blueSideTeam={
                                        (versusState().blueSideTeam || 1) as 1 | 2
                                    }
                                    firstPick={versusState().firstPick || "blue"}
                                    canEdit={true}
                                    onSetBlueSideTeam={handleConfirmSetBlueSideTeam}
                                    onSetFirstPick={handleConfirmSetFirstPick}
                                />
                            </div>
                            <div class="border-t border-slate-700/50 px-8 pb-8 pt-4 text-center">
                                <button
                                    class="w-full rounded-lg bg-orange-600 px-6 py-2.5 text-sm font-semibold text-slate-50 transition-colors hover:bg-orange-500"
                                    onClick={handleConfirmGame}
                                >
                                    Continue as{" "}
                                    {gameSuggestedRole()?.includes("blue")
                                        ? "Blue"
                                        : "Red"}{" "}
                                    Captain
                                </button>
                                <button
                                    class="mt-2 block w-full text-xs text-slate-500 transition-colors hover:text-slate-400"
                                    onClick={() => {
                                        const vd = versusContext().versusDraft;
                                        if (vd) navigate(`/versus/join/${vd.shareLink}`);
                                    }}
                                >
                                    Switch teams or spectate
                                </button>
                            </div>
                        </div>
                    </div>
                </Show>
                <Show when={!needsGameConfirm()}>
                    <div class="flex h-full min-w-0 flex-1 flex-col bg-slate-900">
                        {/* Streamlined Top Bar */}
                        <div class="flex items-center justify-between border-b border-slate-700 bg-slate-800/50 px-6 py-3 backdrop-blur-sm">
                            <div class="flex items-center gap-4">
                                <button
                                    onClick={() => navigate(`/versus/${params.id}`)}
                                    class="group flex items-center gap-2 text-orange-400 transition-colors hover:text-orange-300"
                                >
                                    <span class="transition-transform group-hover:-translate-x-1">
                                        ←
                                    </span>
                                    <span class="text-sm font-medium">
                                        Back to Series
                                    </span>
                                </button>
                            </div>

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
                                            class="group flex items-center gap-2 text-orange-400 transition-colors hover:text-orange-300"
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
                                    timerStartedAt={versusState().timerStartedAt}
                                    duration={30}
                                    isPaused={versusState().isPaused}
                                />
                            </Show>
                        </div>

                        {/* Main Content */}
                        <div class="flex flex-1 overflow-hidden">
                            {/* Drafts Display - now takes full remaining width */}
                            <div class="flex flex-1 flex-col p-6">
                                {/* Team Names */}
                                <div class="mb-4 flex items-center justify-between">
                                    {/* Blue Team */}
                                    <div class="flex flex-col items-start gap-2">
                                        <div class="flex items-center text-xl font-bold text-blue-400">
                                            {blueSideTeamName()}
                                            <Show
                                                when={
                                                    (versusState().firstPick ||
                                                        "blue") === "blue"
                                                }
                                            >
                                                <span class="ml-2 rounded border border-amber-500/30 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                                                    1st Pick
                                                </span>
                                            </Show>
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
                                        <span class="rounded bg-slate-700 px-2 py-0.5 text-xs font-semibold text-slate-300">
                                            Game {(draft()?.seriesIndex ?? 0) + 1}
                                        </span>
                                        <span class="text-slate-500">vs</span>
                                    </div>
                                    {/* Red Team */}
                                    <div class="flex flex-col items-end gap-2">
                                        <div class="flex items-center text-xl font-bold text-red-400">
                                            {redSideTeamName()}
                                            <Show
                                                when={
                                                    (versusState().firstPick ||
                                                        "blue") === "red"
                                                }
                                            >
                                                <span class="ml-2 rounded border border-amber-500/30 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-400">
                                                    1st Pick
                                                </span>
                                            </Show>
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
                                <div class="mb-6">
                                    <div class="mb-2 text-sm font-semibold text-slate-400">
                                        Bans
                                    </div>
                                    <div class="flex justify-between gap-4">
                                        <div class="flex gap-2">
                                            <For each={getTeamBans("blue")}>
                                                {(ban, index) => (
                                                    <div
                                                        class={`h-14 w-14 rounded border-2 bg-slate-800 transition-all ${
                                                            isBanActive("blue", index())
                                                                ? "animate-pulse border-4 border-yellow-400 ring-4 ring-yellow-400/50"
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
                                                                class="h-full w-full rounded object-cover opacity-50"
                                                            />
                                                        </Show>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                        <div class="flex gap-2">
                                            <For each={getTeamBans("red")}>
                                                {(ban, index) => (
                                                    <div
                                                        class={`h-14 w-14 rounded border-2 bg-slate-800 transition-all ${
                                                            isBanActive("red", index())
                                                                ? "animate-pulse border-4 border-yellow-400 ring-4 ring-yellow-400/50"
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
                                                                class="h-full w-full rounded object-cover opacity-50"
                                                            />
                                                        </Show>
                                                    </div>
                                                )}
                                            </For>
                                        </div>
                                    </div>
                                </div>

                                {/* Picks */}
                                <div class="mb-6 flex gap-8">
                                    {/* Blue Picks */}
                                    <div class="flex-1">
                                        <div class="mb-2 text-sm font-semibold text-blue-400">
                                            Blue Picks
                                        </div>
                                        <div class="space-y-2">
                                            <For each={getTeamPicks("blue")}>
                                                {(pick, index) => (
                                                    <div
                                                        class={`flex h-16 items-center gap-3 rounded border-2 bg-slate-800 p-2 transition-all ${
                                                            isPickActive("blue", index())
                                                                ? "animate-pulse border-4 border-yellow-400 ring-4 ring-yellow-400/50"
                                                                : "border-blue-600/30"
                                                        }`}
                                                    >
                                                        <Show when={pick && pick !== ""}>
                                                            <img
                                                                src={
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].img
                                                                }
                                                                alt={
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                }
                                                                class="h-14 w-14 rounded object-cover"
                                                            />
                                                            <span class="text-sm text-slate-200">
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
                                    <div class="flex-1">
                                        <div class="mb-2 text-sm font-semibold text-red-400">
                                            Red Picks
                                        </div>
                                        <div class="space-y-2">
                                            <For each={getTeamPicks("red")}>
                                                {(pick, index) => (
                                                    <div
                                                        class={`flex h-16 items-center gap-3 rounded border-2 bg-slate-800 p-2 transition-all ${
                                                            isPickActive("red", index())
                                                                ? "animate-pulse border-4 border-yellow-400 ring-4 ring-yellow-400/50"
                                                                : "border-red-600/30"
                                                        }`}
                                                    >
                                                        <Show when={pick && pick !== ""}>
                                                            <img
                                                                src={
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].img
                                                                }
                                                                alt={
                                                                    champions[
                                                                        parseInt(pick)
                                                                    ].name
                                                                }
                                                                class="h-14 w-14 rounded object-cover"
                                                            />
                                                            <span class="text-sm text-slate-200">
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

                                {/* Ready/Lock In Button */}
                                <Show when={!versusState().completed}>
                                    <div class="flex justify-center">
                                        <ReadyButton
                                            isReady={
                                                myRole()?.includes("blue")
                                                    ? versusState().readyStatus.blue
                                                    : versusState().readyStatus.red
                                            }
                                            opponentReady={
                                                myRole()?.includes("blue")
                                                    ? versusState().readyStatus.red
                                                    : versusState().readyStatus.blue
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
                                    </div>
                                </Show>

                                {/* Current Pick Info */}
                                <Show when={getCurrentPickInfo()}>
                                    <div class="mt-4 text-center text-sm text-slate-400">
                                        Current:{" "}
                                        {getCurrentPickInfo()?.team?.toUpperCase() ?? ""}{" "}
                                        {getCurrentPickInfo()?.type ?? ""}
                                    </div>
                                </Show>
                            </div>

                            {/* Champion Panel with Tabs */}
                            <div class="flex w-96 flex-col border-l border-slate-700 bg-slate-800">
                                {/* Tab Buttons */}
                                <div class="flex border-b border-slate-700">
                                    <button
                                        onClick={() => setActiveTab("pick")}
                                        class={`flex-1 px-4 py-3 text-sm font-semibold transition-colors ${
                                            activeTab() === "pick"
                                                ? "border-b-2 border-orange-400 bg-slate-700/50 text-orange-400"
                                                : "text-slate-400 hover:bg-slate-700/30 hover:text-slate-200"
                                        }`}
                                    >
                                        Pick
                                    </button>
                                    <Show when={showRestrictedTab()}>
                                        <button
                                            onClick={() => setActiveTab("restricted")}
                                            class={`flex-1 px-4 py-3 text-sm font-semibold transition-colors ${
                                                activeTab() === "restricted"
                                                    ? "border-b-2 border-orange-400 bg-slate-700/50 text-orange-400"
                                                    : "text-slate-400 hover:bg-slate-700/30 hover:text-slate-200"
                                            }`}
                                        >
                                            Restricted
                                        </button>
                                    </Show>
                                </div>

                                {/* Pick Tab Content */}
                                <Show when={activeTab() === "pick"}>
                                    <div class="flex flex-1 flex-col overflow-hidden pb-4 pt-4">
                                        <div class="px-4 pb-2">
                                            <FilterBar
                                                searchText={searchText}
                                                onSearchChange={setSearchText}
                                                selectedCategory={selectedCategory}
                                                onCategoryChange={setSelectedCategory}
                                                categories={championCategoryList}
                                                searchPlaceholder="Search champions..."
                                                categoryPlaceholder="Role"
                                            />
                                        </div>
                                        <div
                                            class="grid grid-cols-5 gap-2 overflow-y-auto px-4 py-2"
                                            style={{ height: "calc(100vh - 300px)" }}
                                        >
                                            <For each={filteredChampions()}>
                                                {({ item: champ, originalIndex }) => {
                                                    const isPicked = () =>
                                                        (draft()?.picks ?? []).includes(
                                                            String(originalIndex)
                                                        );
                                                    const isSeriesRestricted = () =>
                                                        restrictedChampions().includes(
                                                            String(originalIndex)
                                                        );
                                                    const isPendingSelection = () =>
                                                        getCurrentPendingChampion() ===
                                                            String(originalIndex) &&
                                                        isMyTurn();
                                                    const canSelect = () =>
                                                        isMyTurn() &&
                                                        !isPicked() &&
                                                        !isSeriesRestricted() &&
                                                        !versusState().isPaused;

                                                    return (
                                                        <button
                                                            onClick={() =>
                                                                canSelect() &&
                                                                handleChampionSelect(
                                                                    String(originalIndex)
                                                                )
                                                            }
                                                            class={`relative h-14 w-14 overflow-hidden rounded border-2 transition-all ${
                                                                (isPicked() ||
                                                                    isSeriesRestricted()) &&
                                                                !isPendingSelection()
                                                                    ? "cursor-not-allowed border-slate-700 opacity-30"
                                                                    : isPendingSelection()
                                                                      ? "scale-110 cursor-pointer border-4 border-yellow-400 ring-4 ring-yellow-400/50"
                                                                      : canSelect()
                                                                        ? "cursor-pointer border-orange-500 hover:scale-105 hover:border-orange-400"
                                                                        : "cursor-not-allowed border-slate-700 opacity-50"
                                                            }`}
                                                            title={champ.name}
                                                        >
                                                            <img
                                                                src={champ.img}
                                                                alt={champ.name}
                                                                class="h-full w-full object-cover"
                                                            />
                                                        </button>
                                                    );
                                                }}
                                            </For>
                                        </div>
                                    </div>
                                </Show>

                                {/* Restricted Tab Content */}
                                <Show when={activeTab() === "restricted"}>
                                    <div
                                        class="flex-1 overflow-y-auto px-4 py-4"
                                        style={{ height: "calc(100vh - 300px)" }}
                                    >
                                        <Show
                                            when={restrictedByGame().length > 0}
                                            fallback={
                                                <div class="flex h-full items-center justify-center text-sm text-slate-500">
                                                    No previous games
                                                </div>
                                            }
                                        >
                                            <For each={restrictedByGame()}>
                                                {(game, index) => (
                                                    <div class="mb-4">
                                                        <Show when={index() > 0}>
                                                            <div class="mb-4 border-t border-slate-700" />
                                                        </Show>
                                                        <div class="mb-3 text-sm font-semibold text-slate-300">
                                                            Game {game.gameNumber}
                                                        </div>

                                                        {/* Bans (Ironman only) */}
                                                        <Show
                                                            when={
                                                                versusDraft()?.type ===
                                                                "ironman"
                                                            }
                                                        >
                                                            <div class="mb-3">
                                                                <div class="mb-2 text-sm font-medium text-blue-400">
                                                                    Blue Bans
                                                                </div>
                                                                <div class="grid grid-cols-5 gap-2">
                                                                    <For
                                                                        each={
                                                                            game.blueBans
                                                                        }
                                                                    >
                                                                        {(champId) => (
                                                                            <div class="relative h-14 w-14 overflow-hidden rounded border-2 border-blue-600/30 bg-slate-700">
                                                                                <Show
                                                                                    when={
                                                                                        champId &&
                                                                                        champId !==
                                                                                            ""
                                                                                    }
                                                                                    fallback={
                                                                                        <img
                                                                                            src={
                                                                                                BlankSquare
                                                                                            }
                                                                                            alt="Empty"
                                                                                            class="h-full w-full object-cover"
                                                                                        />
                                                                                    }
                                                                                >
                                                                                    <img
                                                                                        src={
                                                                                            champions[
                                                                                                parseInt(
                                                                                                    champId
                                                                                                )
                                                                                            ]
                                                                                                .img
                                                                                        }
                                                                                        alt={
                                                                                            champions[
                                                                                                parseInt(
                                                                                                    champId
                                                                                                )
                                                                                            ]
                                                                                                .name
                                                                                        }
                                                                                        class="h-full w-full object-cover opacity-50"
                                                                                        title={
                                                                                            champions[
                                                                                                parseInt(
                                                                                                    champId
                                                                                                )
                                                                                            ]
                                                                                                .name
                                                                                        }
                                                                                    />
                                                                                    <div class="absolute inset-0 flex items-center justify-center bg-black/30">
                                                                                        <span class="text-lg text-red-500">
                                                                                            ✕
                                                                                        </span>
                                                                                    </div>
                                                                                </Show>
                                                                            </div>
                                                                        )}
                                                                    </For>
                                                                </div>
                                                            </div>
                                                            <div class="mb-3">
                                                                <div class="mb-2 text-sm font-medium text-red-400">
                                                                    Red Bans
                                                                </div>
                                                                <div class="grid grid-cols-5 gap-2">
                                                                    <For
                                                                        each={
                                                                            game.redBans
                                                                        }
                                                                    >
                                                                        {(champId) => (
                                                                            <div class="relative h-14 w-14 overflow-hidden rounded border-2 border-red-600/30 bg-slate-700">
                                                                                <Show
                                                                                    when={
                                                                                        champId &&
                                                                                        champId !==
                                                                                            ""
                                                                                    }
                                                                                    fallback={
                                                                                        <img
                                                                                            src={
                                                                                                BlankSquare
                                                                                            }
                                                                                            alt="Empty"
                                                                                            class="h-full w-full object-cover"
                                                                                        />
                                                                                    }
                                                                                >
                                                                                    <img
                                                                                        src={
                                                                                            champions[
                                                                                                parseInt(
                                                                                                    champId
                                                                                                )
                                                                                            ]
                                                                                                .img
                                                                                        }
                                                                                        alt={
                                                                                            champions[
                                                                                                parseInt(
                                                                                                    champId
                                                                                                )
                                                                                            ]
                                                                                                .name
                                                                                        }
                                                                                        class="h-full w-full object-cover opacity-50"
                                                                                        title={
                                                                                            champions[
                                                                                                parseInt(
                                                                                                    champId
                                                                                                )
                                                                                            ]
                                                                                                .name
                                                                                        }
                                                                                    />
                                                                                    <div class="absolute inset-0 flex items-center justify-center bg-black/30">
                                                                                        <span class="text-lg text-red-500">
                                                                                            ✕
                                                                                        </span>
                                                                                    </div>
                                                                                </Show>
                                                                            </div>
                                                                        )}
                                                                    </For>
                                                                </div>
                                                            </div>
                                                        </Show>

                                                        {/* Picks (always shown for Fearless/Ironman) */}
                                                        <div class="mb-3">
                                                            <div class="mb-2 text-sm font-medium text-blue-400">
                                                                Blue Picks
                                                            </div>
                                                            <div class="grid grid-cols-5 gap-2">
                                                                <For
                                                                    each={game.bluePicks}
                                                                >
                                                                    {(champId) => (
                                                                        <div class="h-14 w-14 overflow-hidden rounded border-2 border-blue-600/30 bg-slate-700">
                                                                            <Show
                                                                                when={
                                                                                    champId &&
                                                                                    champId !==
                                                                                        ""
                                                                                }
                                                                                fallback={
                                                                                    <img
                                                                                        src={
                                                                                            BlankSquare
                                                                                        }
                                                                                        alt="Empty"
                                                                                        class="h-full w-full object-cover"
                                                                                    />
                                                                                }
                                                                            >
                                                                                <img
                                                                                    src={
                                                                                        champions[
                                                                                            parseInt(
                                                                                                champId
                                                                                            )
                                                                                        ]
                                                                                            .img
                                                                                    }
                                                                                    alt={
                                                                                        champions[
                                                                                            parseInt(
                                                                                                champId
                                                                                            )
                                                                                        ]
                                                                                            .name
                                                                                    }
                                                                                    class="h-full w-full object-cover"
                                                                                    title={
                                                                                        champions[
                                                                                            parseInt(
                                                                                                champId
                                                                                            )
                                                                                        ]
                                                                                            .name
                                                                                    }
                                                                                />
                                                                            </Show>
                                                                        </div>
                                                                    )}
                                                                </For>
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <div class="mb-2 text-sm font-medium text-red-400">
                                                                Red Picks
                                                            </div>
                                                            <div class="grid grid-cols-5 gap-2">
                                                                <For each={game.redPicks}>
                                                                    {(champId) => (
                                                                        <div class="h-14 w-14 overflow-hidden rounded border-2 border-red-600/30 bg-slate-700">
                                                                            <Show
                                                                                when={
                                                                                    champId &&
                                                                                    champId !==
                                                                                        ""
                                                                                }
                                                                                fallback={
                                                                                    <img
                                                                                        src={
                                                                                            BlankSquare
                                                                                        }
                                                                                        alt="Empty"
                                                                                        class="h-full w-full object-cover"
                                                                                    />
                                                                                }
                                                                            >
                                                                                <img
                                                                                    src={
                                                                                        champions[
                                                                                            parseInt(
                                                                                                champId
                                                                                            )
                                                                                        ]
                                                                                            .img
                                                                                    }
                                                                                    alt={
                                                                                        champions[
                                                                                            parseInt(
                                                                                                champId
                                                                                            )
                                                                                        ]
                                                                                            .name
                                                                                    }
                                                                                    class="h-full w-full object-cover"
                                                                                    title={
                                                                                        champions[
                                                                                            parseInt(
                                                                                                champId
                                                                                            )
                                                                                        ]
                                                                                            .name
                                                                                    }
                                                                                />
                                                                            </Show>
                                                                        </div>
                                                                    )}
                                                                </For>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </For>
                                        </Show>
                                    </div>
                                </Show>
                            </div>
                        </div>

                        {/* Modals */}
                        <WinnerDeclarationModal
                            isOpen={showWinnerModal()}
                            blueTeamName={versusDraft()?.blueTeamName ?? ""}
                            redTeamName={versusDraft()?.redTeamName ?? ""}
                            onDeclareWinner={handleDeclareWinner}
                            isSpectator={isSpectator()}
                        />

                        <PauseRequestModal
                            isOpen={showPauseRequest()}
                            requestType={pauseRequestType()}
                            requestingTeam={pauseRequestTeam()}
                            blueTeamName={versusDraft()?.blueTeamName ?? ""}
                            redTeamName={versusDraft()?.redTeamName ?? ""}
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
