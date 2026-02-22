import {
    Component,
    createSignal,
    createEffect,
    onCleanup,
    Show,
    untrack
} from "solid-js";
import { useParams, useNavigate, RouteSectionProps } from "@solidjs/router";
import FlowPanel from "../components/FlowPanel";
import VersusFlowPanelContent from "../components/VersusFlowPanelContent";
import {
    VersusJoinResponseSchema,
    VersusRoleSelectResponseSchema,
    VersusParticipantsUpdateSchema,
    VersusSeriesUpdateSchema,
    VersusErrorSchema,
    VersusMessageSchema,
    WinnerUpdateSchema,
    DraftStatusUpdateSchema,
    VersusSyncResponseSchema
} from "../utils/schemas";
import { validateSocketEvent } from "../utils/socketValidation";
import { VersusSessionState, ChatMessage } from "../utils/types";
import { saveVersusRole, getVersusRole } from "../utils/versusStorage";
import { Socket } from "socket.io-client";
import toast from "solid-toast";
import {
    VersusWorkflowContext,
    VersusWorkflowContextValue,
    type ActiveDraftState,
    type DraftCallbacks
} from "../contexts/VersusContext";
import { VersusSocketProvider, useVersusSocket } from "../providers/VersusSocketProvider";

// Helper: compute team identity from role + side assignment
const computeTeamIdentity = (
    role: string,
    blueSideTeam: number,
    blueTeamName: string,
    redTeamName: string
): string => {
    const isBlue = role.includes("blue");
    const bst = blueSideTeam || 1;
    if (isBlue) {
        return bst === 1 ? blueTeamName : redTeamName;
    } else {
        return bst === 1 ? redTeamName : blueTeamName;
    }
};

// Helper: compute suggested role for a new game based on team identity + side assignment
export const getSuggestedRole = (
    teamIdentity: string | null,
    blueSideTeam: number,
    blueTeamName: string,
    redTeamName: string
): "blue_captain" | "red_captain" | null => {
    if (!teamIdentity) return null;
    const bst = blueSideTeam || 1;
    const blueTeam = bst === 1 ? blueTeamName : redTeamName;
    return teamIdentity === blueTeam ? "blue_captain" : "red_captain";
};

const VersusWorkflow: Component<RouteSectionProps> = (props) => {
    return (
        <VersusSocketProvider>
            <VersusWorkflowInner {...props} />
        </VersusSocketProvider>
    );
};

const VersusWorkflowInner: Component<RouteSectionProps> = (props) => {
    const params = useParams();
    const navigate = useNavigate();

    // Get socket from VersusSocketProvider instead of useUser
    const { socket: socketAccessor, connectionStatus: connectionStatusAccessor } =
        useVersusSocket();

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
    // Track disconnection state for sync on reconnect
    const [wasDisconnected, setWasDisconnected] = createSignal(false);

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

    // Team identity tracking for per-game role re-prompt
    const [myTeamIdentity, setMyTeamIdentity] = createSignal<string | null>(null);

    // Restore team identity from sessionStorage, scoped to the current series
    createEffect(() => {
        const versusDraftId = params.id || versusContext().versusDraft?.id;
        if (versusDraftId) {
            const storedIdentity = sessionStorage.getItem(
                `teamIdentity:${versusDraftId}`
            );
            setMyTeamIdentity(storedIdentity);
        } else {
            setMyTeamIdentity(null);
        }
    });

    // Per-game role confirmation: check if user needs to re-select for a new game
    const isNewGame = (draftId: string): boolean => {
        const versusDraftId = params.id;
        if (!versusDraftId) return false;
        const lastConfirmed = sessionStorage.getItem(
            `lastConfirmedDraft:${versusDraftId}`
        );
        return lastConfirmed !== draftId;
    };

    const confirmGameRole = (draftId: string) => {
        const versusDraftId = params.id;
        if (versusDraftId) {
            sessionStorage.setItem(`lastConfirmedDraft:${versusDraftId}`, draftId);
        }
    };

    // Join response handler
    const handleJoinResponse = (rawData: unknown) => {
        const response = validateSocketEvent(
            "versusJoinResponse",
            rawData,
            VersusJoinResponseSchema
        );
        if (!response) return;
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

            // Compute and store team identity on auto-join/reconnect
            if (response.autoJoinedRole !== "spectator") {
                const currentDraft = response.versusDraft.Drafts?.[0];
                const identity = computeTeamIdentity(
                    response.autoJoinedRole,
                    currentDraft?.blueSideTeam || 1,
                    response.versusDraft.blueTeamName,
                    response.versusDraft.redTeamName
                );
                setMyTeamIdentity(identity);
                sessionStorage.setItem(
                    `teamIdentity:${response.versusDraft.id}`,
                    identity
                );
            }

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
        const handleParticipantUpdate = (rawData: unknown) => {
            const data = validateSocketEvent(
                "versusParticipantsUpdate",
                rawData,
                VersusParticipantsUpdateSchema
            );
            if (!data) return;
            setVersusContext((prev) => ({
                ...prev,
                participants: data.participants
            }));
        };

        // Versus draft updated handler
        const handleVersusDraftUpdate = (rawData: unknown) => {
            const data = validateSocketEvent(
                "versusSeriesUpdate",
                rawData,
                VersusSeriesUpdateSchema
            );
            if (!data) return;
            setVersusContext((prev) => ({
                ...prev,
                versusDraft: data.versusDraft
            }));
        };

        // Error handler
        const handleVersusError = (rawData: unknown) => {
            const data = validateSocketEvent("versusError", rawData, VersusErrorSchema);
            if (!data) return;
            toast.error(data.error);
        };

        // Chat message handler (lifted to context for persistence)
        const handleNewVersusMessage = (rawData: unknown) => {
            const data = validateSocketEvent(
                "newVersusMessage",
                rawData,
                VersusMessageSchema
            );
            if (!data) return;
            addChatMessage(data);
        };

        // Chat user count handler (simple number, no schema needed)
        const handleVersusUserCountUpdate = (count: number) => {
            setChatUserCount(count);
        };

        // Winner update handler
        const handleWinnerUpdate = (rawData: unknown) => {
            const data = validateSocketEvent(
                "versusWinnerUpdate",
                rawData,
                WinnerUpdateSchema
            );
            if (!data) return;
            setVersusContext((prev) => {
                if (!prev.versusDraft?.Drafts) return prev;
                return {
                    ...prev,
                    versusDraft: {
                        ...prev.versusDraft,
                        Drafts: prev.versusDraft.Drafts.map((d) =>
                            d.id === data.draftId ? { ...d, winner: data.winner } : d
                        )
                    }
                };
            });
        };

        // Draft status update handler (for completion status sync)
        const handleDraftStatusUpdate = (rawData: unknown) => {
            const data = validateSocketEvent(
                "versusDraftStatusUpdate",
                rawData,
                DraftStatusUpdateSchema
            );
            if (!data) return;
            setVersusContext((prev) => {
                if (!prev.versusDraft?.Drafts) return prev;
                return {
                    ...prev,
                    versusDraft: {
                        ...prev.versusDraft,
                        Drafts: prev.versusDraft.Drafts.map((d) =>
                            d.id === data.draftId
                                ? { ...d, completed: data.completed }
                                : d
                        )
                    }
                };
            });
        };

        // Sync response handler (for reconnection sync)
        const handleSyncResponse = (rawData: unknown) => {
            const data = validateSocketEvent(
                "versusSyncResponse",
                rawData,
                VersusSyncResponseSchema
            );
            if (!data) return;
            setVersusContext((prev) => ({
                ...prev,
                versusDraft: data.versusDraft,
                participants: data.participants,
                myParticipant: data.myParticipant ?? prev.myParticipant
            }));

            // Save updated role data with new reclaim token
            if (data.myParticipant && data.myParticipant.reclaimToken) {
                saveVersusRole(data.versusDraft.id, {
                    role: data.myParticipant.role,
                    participantId: data.myParticipant.id,
                    reclaimToken: data.myParticipant.reclaimToken,
                    timestamp: Date.now()
                });
            }
        };

        // Register listeners
        sock.on("versusJoinResponse", handleJoinResponse);
        sock.on("versusParticipantsUpdate", handleParticipantUpdate);
        sock.on("versusDraftUpdate", handleVersusDraftUpdate);
        sock.on("versusSeriesUpdate", handleVersusDraftUpdate);
        sock.on("versusError", handleVersusError);
        sock.on("newVersusMessage", handleNewVersusMessage);
        sock.on("versusUserCountUpdate", handleVersusUserCountUpdate);
        sock.on("versusWinnerUpdate", handleWinnerUpdate);
        sock.on("versusDraftStatusUpdate", handleDraftStatusUpdate);
        sock.on("versusSyncResponse", handleSyncResponse);

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
            // Note: versusRoleSelectResponse is managed by a separate effect
            sock.off("versusJoinResponse");
            sock.off("versusParticipantsUpdate");
            sock.off("versusDraftUpdate");
            sock.off("versusSeriesUpdate");
            sock.off("versusError");
            sock.off("newVersusMessage");
            sock.off("versusUserCountUpdate");
            sock.off("versusWinnerUpdate");
            sock.off("versusDraftStatusUpdate");
            sock.off("versusSyncResponse");
        });

        return currentRun;
    });

    createEffect(() => {
        const sock = currentSocket();
        if (!sock) return;

        // Role select response handler
        const handleRoleSelectResponse = (rawData: unknown) => {
            const response = validateSocketEvent(
                "versusRoleSelectResponse",
                rawData,
                VersusRoleSelectResponseSchema
            );
            if (!response) return;
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

                // Compute and store team identity for per-game role re-prompt
                if (response.participant.role !== "spectator") {
                    // Find the current draft's blueSideTeam from the Drafts array
                    const currentDraftId = params.draftId;
                    const currentDraft = currentDraftId
                        ? versusDraft.Drafts?.find((d) => d.id === currentDraftId)
                        : versusDraft.Drafts?.[0];
                    const identity = computeTeamIdentity(
                        response.participant.role,
                        currentDraft?.blueSideTeam || 1,
                        versusDraft.blueTeamName,
                        versusDraft.redTeamName
                    );
                    setMyTeamIdentity(identity);
                    sessionStorage.setItem(`teamIdentity:${versusDraft.id}`, identity);

                    // Track which draft the user confirmed their role for
                    if (currentDraftId) {
                        confirmGameRole(currentDraftId);
                    }
                }

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

    // Track disconnection and request sync on reconnect
    createEffect(() => {
        const status = connectionStatusAccessor();

        if (status === "disconnected" || status === "connecting") {
            setWasDisconnected(true);
        } else if (status === "connected" && wasDisconnected()) {
            setWasDisconnected(false);

            // Reconnected - request fresh data and re-register participant
            const sock = currentSocket();
            const versusDraft = versusContext().versusDraft;
            if (sock && versusDraft) {
                const storedRole = getVersusRole(versusDraft.id);
                sock.emit("versusRequestSync", {
                    versusDraftId: versusDraft.id,
                    storedRole: storedRole
                });
            }
        }
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

    const reportWinner = (draftId: string, winner: "blue" | "red") => {
        const sock = currentSocket();
        const vd = versusContext().versusDraft;
        if (!sock || !vd) return;

        // Optimistic update - update local state immediately
        setVersusContext((prev) => {
            if (!prev.versusDraft?.Drafts) return prev;
            return {
                ...prev,
                versusDraft: {
                    ...prev.versusDraft,
                    Drafts: prev.versusDraft.Drafts.map((d) =>
                        d.id === draftId ? { ...d, winner } : d
                    )
                }
            };
        });

        // Emit socket event for other users
        sock.emit("versusReportWinner", {
            versusDraftId: vd.id,
            draftId,
            winner
        });
    };

    const setGameSettings = (
        draftId: string,
        settings: { firstPick?: "blue" | "red"; blueSideTeam?: 1 | 2 }
    ) => {
        const sock = currentSocket();
        const versusDraftId = versusContext().versusDraft?.id;
        if (!sock || !versusDraftId) return;

        // Optimistic update so UI reacts immediately
        setVersusContext((prev) => {
            if (!prev.versusDraft?.Drafts) return prev;
            return {
                ...prev,
                versusDraft: {
                    ...prev.versusDraft,
                    Drafts: prev.versusDraft.Drafts.map((d) =>
                        d.id === draftId ? { ...d, ...settings } : d
                    )
                }
            };
        });

        sock.emit("versusSetGameSettings", {
            versusDraftId,
            draftId,
            ...settings
        });
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
        chatUserCount,
        reportWinner,
        setGameSettings,
        myTeamIdentity,
        isNewGame,
        confirmGameRole
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
