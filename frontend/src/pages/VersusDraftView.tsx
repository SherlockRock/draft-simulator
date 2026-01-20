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
    DraftCallbacks
} from "../workflows/VersusWorkflow";
import { VersusDraft, draft, VersusState } from "../utils/types";
import { VERSUS_PICK_ORDER, getPicksArrayIndex } from "../utils/versusPickOrder";
import { VersusTimer } from "../components/VersusTimer";
import { ReadyButton } from "../components/ReadyButton";
import { WinnerDeclarationModal } from "../components/WinnerDeclarationModal";
import { PauseRequestModal } from "../components/PauseRequestModal";
import { RoleSwitcher } from "../components/RoleSwitcher";
import { champions } from "../utils/constants";
import toast from "solid-toast";

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
    const [, , socketAccessor] = accessor();

    // Get role and participant info from context (single source of truth)
    const {
        versusContext,
        registerDraftState,
        unregisterDraftState,
        registerDraftCallbacks,
        unregisterDraftCallbacks
    } = useVersusContext();
    const myRole = createMemo(() => versusContext().myParticipant?.role || null);
    const participantId = createMemo(() => versusContext().myParticipant?.id || null);
    const [versusDraft] = createResource(() => params.id, fetchVersusDraft);
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
        completed: false
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
                winner: data.winner
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
                currentPickIndex: data.currentPickIndex
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
        });
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

        const currentPick = VERSUS_PICK_ORDER[state.currentPickIndex];
        const myTeam = myRole()?.includes("blue") ? "blue" : "red";
        return currentPick?.team === myTeam;
    };

    const isSpectator = () => myRole() === "spectator";

    const getCurrentPickInfo = () => {
        const state = versusState();
        if (state.currentPickIndex >= VERSUS_PICK_ORDER.length) return null;
        return VERSUS_PICK_ORDER[state.currentPickIndex];
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

        const currentPick = VERSUS_PICK_ORDER[state.currentPickIndex];
        if (!currentPick || currentPick.type !== "ban") return false;

        return currentPick.team === team && currentPick.slot === slot;
    };

    // Check if a specific pick slot is the current active pick
    const isPickActive = (team: "blue" | "red", slot: number) => {
        const state = versusState();
        if (!draftStarted() || state.completed) return false;

        const currentPick = VERSUS_PICK_ORDER[state.currentPickIndex];
        if (!currentPick || currentPick.type !== "pick") return false;

        return currentPick.team === team && currentPick.slot === slot;
    };

    const draftStarted = () => versusState().timerStartedAt !== null;

    // Check if the current pick slot has a pending champion selected
    const hasPendingPick = (): boolean => {
        const state = versusState();
        if (state.completed || state.currentPickIndex >= VERSUS_PICK_ORDER.length)
            return false;
        const picks = draft()?.picks || [];
        const picksIndex = getPicksArrayIndex(state.currentPickIndex);
        return !!(picks[picksIndex] && picks[picksIndex] !== "");
    };

    // Get the current pending champion (for highlighting in the grid)
    const getCurrentPendingChampion = () => {
        const state = versusState();
        if (state.completed || state.currentPickIndex >= VERSUS_PICK_ORDER.length)
            return null;
        const picks = draft()?.picks || [];
        const picksIndex = getPicksArrayIndex(state.currentPickIndex);
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
                <div class="flex h-full w-full flex-col bg-slate-900">
                    {/* Streamlined Top Bar */}
                    <div class="flex items-center justify-between border-b border-slate-700 bg-slate-800/50 px-6 py-3 backdrop-blur-sm">
                        <div class="flex items-center gap-4">
                            <button
                                onClick={() => navigate(`/versus/${params.id}`)}
                                class="group flex items-center gap-2 text-slate-400 transition-colors hover:text-slate-200"
                            >
                                <span class="transition-transform group-hover:-translate-x-1">
                                    ←
                                </span>
                                <span class="text-sm font-medium">Back to Series</span>
                            </button>

                            <RoleSwitcher
                                versusDraftId={params.id}
                                currentRole={myRole() || "spectator"}
                            />
                        </div>

                        <VersusTimer
                            timerStartedAt={versusState().timerStartedAt}
                            duration={30}
                            isPaused={versusState().isPaused}
                        />
                    </div>

                    {/* Main Content */}
                    <div class="flex flex-1 overflow-hidden">
                        {/* Drafts Display - now takes full remaining width */}
                        <div class="flex flex-1 flex-col p-6">
                            {/* Team Names */}
                            <div class="mb-4 flex items-center justify-between">
                                {/* Blue Team */}
                                <div class="flex flex-col items-start gap-2">
                                    <div class="text-xl font-bold text-blue-400">
                                        {versusDraft()!.blueTeamName}
                                    </div>
                                    <Show when={!draftStarted()}>
                                        <div
                                            class={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider transition-all duration-300 ${
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
                                <div class="text-slate-500">vs</div>
                                {/* Red Team */}
                                <div class="flex flex-col items-end gap-2">
                                    <div class="text-xl font-bold text-red-400">
                                        {versusDraft()!.redTeamName}
                                    </div>
                                    <Show when={!draftStarted()}>
                                        <div
                                            class={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wider transition-all duration-300 ${
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
                                                    class={`h-12 w-12 rounded border-2 bg-slate-800 transition-all ${
                                                        isBanActive("blue", index())
                                                            ? "animate-pulse border-4 border-yellow-400 ring-4 ring-yellow-400/50"
                                                            : "border-blue-600/30"
                                                    }`}
                                                >
                                                    <Show when={ban && ban !== ""}>
                                                        <img
                                                            src={
                                                                champions[parseInt(ban)]
                                                                    .img
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
                                                    class={`h-12 w-12 rounded border-2 bg-slate-800 transition-all ${
                                                        isBanActive("red", index())
                                                            ? "animate-pulse border-4 border-yellow-400 ring-4 ring-yellow-400/50"
                                                            : "border-red-600/30"
                                                    }`}
                                                >
                                                    <Show when={ban && ban !== ""}>
                                                        <img
                                                            src={
                                                                champions[parseInt(ban)]
                                                                    .img
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
                                                                champions[parseInt(pick)]
                                                                    .img
                                                            }
                                                            alt={
                                                                champions[parseInt(pick)]
                                                                    .name
                                                            }
                                                            class="h-12 w-12 rounded object-cover"
                                                        />
                                                        <span class="text-sm text-slate-200">
                                                            {
                                                                champions[parseInt(pick)]
                                                                    .name
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
                                                                champions[parseInt(pick)]
                                                                    .img
                                                            }
                                                            alt={
                                                                champions[parseInt(pick)]
                                                                    .name
                                                            }
                                                            class="h-12 w-12 rounded object-cover"
                                                        />
                                                        <span class="text-sm text-slate-200">
                                                            {
                                                                champions[parseInt(pick)]
                                                                    .name
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
                                    Current: {getCurrentPickInfo()!.team.toUpperCase()}{" "}
                                    {getCurrentPickInfo()!.type}
                                </div>
                            </Show>
                        </div>

                        {/* Champion Grid */}
                        <div class="w-96 border-l border-slate-700 bg-slate-800 pb-4 pl-0 pr-0 pt-4">
                            <div class="mb-4 px-4 text-lg font-semibold text-slate-200">
                                Champions
                            </div>
                            <div
                                class="grid grid-cols-4 gap-2 overflow-y-auto px-4 py-2"
                                style={{ height: "calc(100vh - 200px)" }}
                            >
                                <For each={champions}>
                                    {(champ, index) => {
                                        const isPicked = () =>
                                            draft()!.picks.includes(String(index()));
                                        const isPendingSelection = () =>
                                            getCurrentPendingChampion() ===
                                                String(index()) && isMyTurn();
                                        const canSelect = () =>
                                            isMyTurn() &&
                                            !isPicked() &&
                                            !versusState().isPaused;

                                        return (
                                            <button
                                                onClick={() =>
                                                    canSelect() &&
                                                    handleChampionSelect(String(index()))
                                                }
                                                class={`relative h-16 w-16 rounded border-2 transition-all ${
                                                    isPicked() && !isPendingSelection()
                                                        ? "cursor-not-allowed border-slate-700 opacity-30"
                                                        : isPendingSelection()
                                                          ? "scale-110 cursor-pointer border-4 border-yellow-400 ring-4 ring-yellow-400/50"
                                                          : canSelect()
                                                            ? "cursor-pointer border-teal-500 hover:scale-105 hover:border-teal-400"
                                                            : "cursor-not-allowed border-slate-700 opacity-50"
                                                }`}
                                            >
                                                <img
                                                    src={champ.img}
                                                    alt={champ.name}
                                                    class="h-full w-full rounded object-cover"
                                                />
                                            </button>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    </div>

                    {/* Modals */}
                    <WinnerDeclarationModal
                        isOpen={showWinnerModal()}
                        blueTeamName={versusDraft()!.blueTeamName}
                        redTeamName={versusDraft()!.redTeamName}
                        onDeclareWinner={handleDeclareWinner}
                        isSpectator={isSpectator()}
                    />

                    <PauseRequestModal
                        isOpen={showPauseRequest()}
                        requestType={pauseRequestType()}
                        requestingTeam={pauseRequestTeam()}
                        blueTeamName={versusDraft()!.blueTeamName}
                        redTeamName={versusDraft()!.redTeamName}
                        onApprove={handleApproveRequest}
                        onReject={handleRejectRequest}
                    />

                    {/* Resume Countdown Overlay */}
                    <Show when={isCountingDown()}>
                        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                            <div class="text-center">
                                <div class="mb-4 animate-pulse text-9xl font-bold text-teal-400">
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
    );
};

export default VersusDraftView;
