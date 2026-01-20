import {
    Component,
    createSignal,
    createEffect,
    createContext,
    useContext,
    onCleanup,
    Show,
    untrack
} from "solid-js";
import { useParams, useNavigate, RouteSectionProps } from "@solidjs/router";
import { useUser } from "../userProvider";
import FlowPanel from "../components/FlowPanel";
import VersusFlowPanelContent from "../components/VersusFlowPanelContent";
import {
    VersusDraft,
    VersusParticipant,
    VersusSessionState,
    VersusJoinResponse,
    VersusRoleSelectResponse,
    ChatMessage
} from "../utils/types";
import { saveVersusRole, getVersusRole } from "../utils/versusStorage";
import { Socket } from "socket.io-client";
import toast from "solid-toast";

// Draft-specific state types for callback registration pattern
export type ActiveDraftState = {
    draftId: string;
    currentPickIndex: number;
    timerStartedAt: number | null;
    isPaused: boolean;
    readyStatus: { blue: boolean; red: boolean };
    completed: boolean;
    winner?: "blue" | "red" | null;
    draft: any; // The draft resource data
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
    pendingPickChangeRequest: () => any;
};

// Create context for sharing versus state with children
type VersusWorkflowContextValue = {
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
};

const VersusWorkflowContext = createContext<VersusWorkflowContextValue>();

export const useVersusContext = () => {
    const context = useContext(VersusWorkflowContext);
    if (!context) {
        throw new Error("useVersusContext must be used within VersusWorkflow");
    }
    return context;
};

const VersusWorkflow: Component<RouteSectionProps> = (props) => {
    const params = useParams();
    const navigate = useNavigate();
    const accessor = useUser();
    const [, , socketAccessor, connectionStatusAccessor] = accessor();

    // Versus context state - single source of truth for all components
    const [versusContext, setVersusContext] = createSignal<VersusSessionState>({
        versusDraft: null,
        participants: [],
        myParticipant: null,
        connected: false,
        error: null
    });

    const [pendingJoin, setPendingJoin] = createSignal<string | null>(null);
    const [listenersReady, setListenersReady] = createSignal(false);
    // Store the current socket to ensure all operations use the SAME instance
    const [currentSocket, setCurrentSocket] = createSignal<Socket | undefined>(undefined);
    // Track which socket has listeners registered to prevent duplicate/missing registrations
    let socketWithListeners: Socket | undefined = undefined;
    // Track the current versus draft ID to detect navigation between different series
    const [currentVersusDraftId, setCurrentVersusDraftId] = createSignal<string | null>(
        null
    );

    // Draft-specific state registration (for VersusDraftView to expose its state)
    const [activeDraftState, setActiveDraftState] = createSignal<ActiveDraftState | null>(
        null
    );
    const [draftCallbacks, setDraftCallbacks] = createSignal<DraftCallbacks | null>(null);

    // Chat state (lifted to context to persist across FlowPanel open/close)
    const [chatMessages, setChatMessages] = createSignal<ChatMessage[]>([]);
    const [chatUserCount, setChatUserCount] = createSignal(0);

    const addChatMessage = (message: ChatMessage) => {
        setChatMessages((prev) => [...prev, message]);
    };

    // Join response handler
    const handleJoinResponse = (response: VersusJoinResponse) => {
        if (!response.success) {
            setVersusContext({
                versusDraft: null,
                participants: [],
                myParticipant: null,
                connected: false,
                error: "Failed to join versus session"
            });
            toast.error("Failed to join versus session");
            return;
        }

        setVersusContext({
            versusDraft: response.versusDraft,
            participants: response.participants,
            myParticipant: response.myParticipant,
            connected: true,
            error: null
        });

        setCurrentVersusDraftId(response.versusDraft.id);

        // If auto-joined with a valid role, navigate to series overview
        if (response.autoJoinedRole && response.myParticipant) {
            toast.success(`Reconnected as ${response.autoJoinedRole.replace("_", " ")}`, {
                id: "reconnect-toast",
                duration: 4000
            });

            // Save role data to session storage (with the new rotated token from backend)
            saveVersusRole(response.versusDraft.id, {
                role: response.autoJoinedRole,
                participantId: response.myParticipant.id,
                reclaimToken: response.myParticipant.reclaimToken,
                timestamp: Date.now()
            });
            if (params.linkToken) {
                // No auto-join, stay on role selection page
                navigate(`/versus/${response.versusDraft.id}`);
            }
        }

        setPendingJoin(null);
    };

    // Setup socket listeners - re-runs whenever socket OR connection status changes
    createEffect(() => {
        const sock = socketAccessor();
        const connectionStatus = connectionStatusAccessor();

        const currentRun = { sockId: sock?.id, status: connectionStatus };

        if (!sock) {
            setListenersReady(false);
            setCurrentSocket(undefined);
            return currentRun;
        }

        // Verify socket is actually connected (not just connectionStatus)
        if (!sock.connected || !sock.id) {
            setListenersReady(false);
            // Effect will re-run when connectionStatus changes to "connected"
            return currentRun;
        }

        // If this socket already has listeners registered, don't re-register
        if (socketWithListeners === sock) {
            return currentRun;
        }

        // Only setup listeners when connection status is confirmed connected
        if (connectionStatus !== "connected") {
            setListenersReady(false);
            return currentRun;
        }

        // Temporarily disable listeners while we switch sockets
        setListenersReady(false);

        // Clear pending join so the join effect can retry with new socket if needed
        // Use untrack to avoid creating a reactive dependency on pendingJoin
        const pending = untrack(pendingJoin);
        if (pending) {
            setPendingJoin(null);
        }

        // Only update currentSocket if it's actually a different socket instance
        // Use untrack to read currentSocket without creating a reactive dependency
        const prevSocketValue = untrack(currentSocket);
        if (prevSocketValue !== sock) {
            setCurrentSocket(sock);
        }

        // Participant updated handler
        const handleParticipantUpdate = (data: { participants: VersusParticipant[] }) => {
            setVersusContext((prev) => ({
                ...prev,
                participants: data.participants
            }));
        };

        // Versus draft updated handler
        const handleVersusDraftUpdate = (data: { versusDraft: VersusDraft }) => {
            setVersusContext((prev) => ({
                ...prev,
                versusDraft: data.versusDraft
            }));
        };

        // Error handler
        const handleVersusError = (data: { error: string }) => {
            toast.error(data.error);
        };

        // Chat message handler (lifted to context for persistence)
        const handleNewVersusMessage = (data: ChatMessage) => {
            addChatMessage(data);
        };

        // Chat user count handler
        const handleVersusUserCountUpdate = (count: number) => {
            setChatUserCount(count);
        };

        // Winner update handler
        const handleWinnerUpdate = (data: { draftId: string; winner: "blue" | "red" }) => {
            setVersusContext((prev) => {
                if (!prev.versusDraft?.Drafts) return prev;
                return {
                    ...prev,
                    versusDraft: {
                        ...prev.versusDraft,
                        Drafts: prev.versusDraft.Drafts.map((d) =>
                            d.id === data.draftId ? { ...d, winner: data.winner } : d
                        ),
                    },
                };
            });
        };

        // Draft status update handler (for completion status sync)
        const handleDraftStatusUpdate = (data: { draftId: string; completed: boolean }) => {
            setVersusContext((prev) => {
                if (!prev.versusDraft?.Drafts) return prev;
                return {
                    ...prev,
                    versusDraft: {
                        ...prev.versusDraft,
                        Drafts: prev.versusDraft.Drafts.map((d) =>
                            d.id === data.draftId ? { ...d, completed: data.completed } : d
                        ),
                    },
                };
            });
        };

        // Register listeners
        sock.on("versusJoinResponse", handleJoinResponse);
        sock.on("versusParticipantsUpdate", handleParticipantUpdate);
        sock.on("versusDraftUpdate", handleVersusDraftUpdate);
        sock.on("versusError", handleVersusError);
        sock.on("newVersusMessage", handleNewVersusMessage);
        sock.on("versusUserCountUpdate", handleVersusUserCountUpdate);
        sock.on("versusWinnerUpdate", handleWinnerUpdate);
        sock.on("versusDraftStatusUpdate", handleDraftStatusUpdate);

        // Mark this socket as having listeners
        socketWithListeners = sock;

        setListenersReady(true);

        onCleanup(() => {
            setListenersReady(false);

            // Clear the tracked socket if it's the one being cleaned up
            if (socketWithListeners === sock) {
                socketWithListeners = undefined;
            }

            // Clean up all listeners from this specific socket instance
            sock.off("versusJoinResponse");
            sock.off("versusRoleSelectResponse");
            sock.off("versusParticipantsUpdate");
            sock.off("versusDraftUpdate");
            sock.off("versusError");
            sock.off("newVersusMessage");
            sock.off("versusUserCountUpdate");
            sock.off("versusWinnerUpdate");
            sock.off("versusDraftStatusUpdate");
        });

        return currentRun;
    });

    createEffect(() => {
        const sock = currentSocket();
        if (!sock) return;

        // Role select response handler
        const handleRoleSelectResponse = (response: VersusRoleSelectResponse) => {
            if (!response.success) {
                toast.error("Failed to select role");
                return;
            }

            // Update session state with new participant info
            setVersusContext((prev) => ({
                ...prev,
                myParticipant: response.participant,
                participants: prev.participants.map((p) =>
                    p.id === response.participant.id ? response.participant : p
                )
            }));

            // Save role data
            const versusDraft = versusContext().versusDraft;
            if (versusDraft) {
                saveVersusRole(versusDraft.id, {
                    role: response.participant.role,
                    participantId: response.participant.id,
                    reclaimToken: response.reclaimToken,
                    timestamp: Date.now()
                });

                toast.success(`Joined as ${response.participant.role.replace("_", " ")}`);

                // Navigate to series overview
                navigate(`/versus/${versusDraft.id}`, { replace: true });
            }
        };
        sock.on("versusRoleSelectResponse", handleRoleSelectResponse);
        onCleanup(() => {
            sock.off("versusRoleSelectResponse");
        });
    });

    // Detect navigation between different versus series and reset context
    createEffect(() => {
        const versusDraftId = params.id;
        const previousId = untrack(currentVersusDraftId);

        // Determine the target ID - either directly from params.id or from the connected draft
        const targetId = versusDraftId || null;

        // If we have a previous ID and we're navigating to a different series (or back to dashboard)
        if (previousId && targetId !== previousId) {
            // Leave the old session
            const sock = untrack(currentSocket);
            if (sock) {
                sock.emit("versusLeave", { versusDraftId: previousId });
            }

            // Reset the context
            setVersusContext({
                versusDraft: null,
                participants: [],
                myParticipant: null,
                connected: false,
                error: null
            });

            // Clear chat messages when switching series
            setChatMessages([]);
            setChatUserCount(0);

            // Clear pending join so the new join can happen
            setPendingJoin(null);
        }
        // Update the tracked ID
        setCurrentVersusDraftId(targetId);
    });

    // Handle joining versus session - ONLY after listeners are ready
    // Supports two modes:
    // 1. Via linkToken (share link) - initial join
    // 2. Via versusDraftId (direct navigation) - recovery using stored role data
    createEffect(() => {
        const linkToken = params.linkToken;
        const versusDraftId = params.id;
        const sock = currentSocket();
        const ready = listenersReady();

        const contextConnected = versusContext().connected;

        // Prerequisites for any join
        if (!sock || !ready || pendingJoin() || !sock.connected || contextConnected) {
            return;
        }

        // Mode 1: Join via linkToken (share link)
        if (linkToken) {
            setPendingJoin(linkToken);

            sock.emit("versusJoin", {
                linkToken: linkToken,
                storedRole: null // Can't check storage yet since we don't know the ID
            });

            return;
        } else if (versusDraftId) {
            // Mode 2: Recovery via versusDraftId (direct navigation, e.g., after page refresh)
            // Uses stored role data from browser session storage
            const storedRole = getVersusRole(versusDraftId);

            if (storedRole) {
                setPendingJoin(versusDraftId);

                sock.emit("versusJoin", {
                    versusDraftId: versusDraftId,
                    storedRole: storedRole
                });
            } else {
                // No stored role - join as spectator by default
                setPendingJoin(versusDraftId);

                sock.emit("versusJoin", {
                    versusDraftId: versusDraftId,
                    storedRole: null,
                    defaultToSpectator: true
                });
            }
        }
    });

    // Clear session when leaving versus routes
    createEffect(() => {
        const isVersusRoute = window.location.pathname.startsWith("/versus");

        if (!isVersusRoute && versusContext().connected) {
            leaveSession();
        }
    });

    const selectRole = (role: "blue_captain" | "red_captain" | "spectator") => {
        const sock = currentSocket();
        const versusDraft = versusContext().versusDraft;

        if (!sock || !versusDraft) {
            return;
        }

        sock.emit("versusSelectRole", {
            versusDraftId: versusDraft.id,
            role: role
        });
    };

    const leaveSession = () => {
        const sock = currentSocket();
        const versusDraft = versusContext().versusDraft;

        if (sock && versusDraft) {
            sock.emit("versusLeave", { versusDraftId: versusDraft.id });
        }

        setVersusContext({
            versusDraft: null,
            participants: [],
            myParticipant: null,
            connected: false,
            error: null
        });

        // Clear chat messages when leaving session
        setChatMessages([]);
        setChatUserCount(0);
    };

    const releaseRole = () => {
        const sock = currentSocket();
        const versusDraft = versusContext().versusDraft;

        if (!sock || !versusDraft) {
            return;
        }

        sock.emit("versusReleaseRole", { versusDraftId: versusDraft.id });

        // Clear local participant state but keep session connected
        setVersusContext((prev) => ({
            ...prev,
            myParticipant: null
        }));

        // Navigate to role selection
        navigate(`/versus/join/${versusDraft.shareLink}`);
    };

    const registerDraftState = (state: ActiveDraftState) => {
        setActiveDraftState(state);
    };

    const unregisterDraftState = () => {
        setActiveDraftState(null);
    };

    const registerDraftCallbacks = (callbacks: DraftCallbacks) => {
        setDraftCallbacks(callbacks);
    };

    const unregisterDraftCallbacks = () => {
        setDraftCallbacks(null);
    };

    const contextValue: VersusWorkflowContextValue = {
        versusContext,
        selectRole,
        leaveSession,
        releaseRole,
        socket: currentSocket,
        activeDraftState,
        registerDraftState,
        unregisterDraftState,
        draftCallbacks,
        registerDraftCallbacks,
        unregisterDraftCallbacks,
        chatMessages,
        addChatMessage,
        chatUserCount
    };

    return (
        <VersusWorkflowContext.Provider value={contextValue}>
            <div class="flex flex-1 overflow-hidden">
                {/* FlowPanel - visible in detail view, hidden on dashboard and during role selection */}
                <Show when={!params.linkToken && params.id}>
                    <FlowPanel flow="versus">
                        <VersusFlowPanelContent />
                    </FlowPanel>
                </Show>
                {/* Child routes render here */}
                {props.children}
            </div>
        </VersusWorkflowContext.Provider>
    );
};

export default VersusWorkflow;
