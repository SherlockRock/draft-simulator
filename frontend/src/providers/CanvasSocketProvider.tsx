import {
    createContext,
    useContext,
    createSignal,
    createEffect,
    onCleanup,
    JSX,
    createMemo,
    Show
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { useNavigate, useParams } from "@solidjs/router";
import toast from "solid-toast";
import { Socket } from "socket.io-client";
import {
    ConnectionStatus,
    ConnectionInfo,
    SocketContextValue,
    createAuthenticatedSocket
} from "./socketUtils";
import { useUser } from "../userProvider";
import ConnectionBanner from "../ConnectionBanner";
import { validateSocketEvent } from "../utils/socketValidation";
import {
    PresenceUser,
    annotationLockDeniedSchema,
    canvasAccessRevokedSchema,
    presenceSnapshotSchema,
    presenceJoinSchema,
    presenceLeaveSchema
} from "../utils/presence";
import { RemoteViewport, createRemoteViewportTracker } from "../utils/remoteViewports";
import { createAnnotationLockTracker } from "../utils/annotationLocks";
import { CanvasDraftUpdateSchema, DraftPickAckSchema } from "@draft-sim/shared-types";
import { createDraftPickSync, type DraftPickSync } from "../utils/draftPickSync";

export type CanvasSocketContextValue = SocketContextValue & {
    pickSync: DraftPickSync;
    pickSyncVersion: () => number;
    presenceUsers: () => PresenceUser[];
    // Last-known viewport of another present user, undefined when they have
    // no live canvas viewport (never broadcast, in a draft view, or cleared).
    remoteViewportOf: (userId: string) => RemoteViewport | undefined;
    annotationLockOf: (annotationId: string) => string | undefined;
};

const CanvasSocketContext = createContext<CanvasSocketContextValue>();

export function CanvasSocketProvider(props: { children: JSX.Element }) {
    const accessor = useUser();
    const [user] = accessor();
    const params = useParams();
    const navigate = useNavigate();

    // Presence spans the whole canvas workflow: /canvas/:id and its child
    // draft view are siblings under this provider, so a user who opens a
    // draft stays present on the canvas. Local canvases have no socket.
    const presenceCanvasId = (): string | undefined => {
        const id = params.id;
        return id && id !== "local" ? id : undefined;
    };

    const [socket, setSocket] = createSignal<Socket | undefined>(undefined);
    const [connectionStatus, setConnectionStatus] =
        createSignal<ConnectionStatus>("connecting");
    const [reconnectAttempts, setReconnectAttempts] = createSignal(0);
    const [justReconnected, setJustReconnected] = createSignal(false);
    const [pickSyncVersion, setPickSyncVersion] = createSignal(0);
    const pickSync = createDraftPickSync({
        changed: () => setPickSyncVersion((version) => version + 1),
        send: (request, reply) => {
            const sock = socket();
            if (!sock?.connected) {
                reply();
                return;
            }
            sock.timeout(5000).emit(
                "updateDraftPicks",
                request,
                (error: Error | null, raw: unknown) => {
                    const result = DraftPickAckSchema.safeParse(raw);
                    reply(!error && result.success ? result.data : undefined);
                }
            );
        }
    });
    const pendingPicks = createMemo(() => {
        pickSyncVersion();
        return pickSync.pendingCount();
    });
    const pickSaveError = createMemo(() => {
        pickSyncVersion();
        return pickSync.error();
    });
    let socketOwnerId: string | undefined;
    onCleanup(() => pickSync.reset());

    const clearReconnected = () => setJustReconnected(false);

    const reconnect = () => {
        const sock = socket();
        if (sock) {
            setReconnectAttempts(0);
            setConnectionStatus("connecting");
            sock.connect();
        }
    };

    const connectionInfo = createMemo<ConnectionInfo>(() => ({
        status: connectionStatus(),
        reconnectAttempts: reconnectAttempts()
    }));

    // Only create socket for authenticated users
    // Anonymous users use local canvases which don't need real-time sync
    createEffect(() => {
        const currentUser = user();
        if (socketOwnerId !== currentUser?.id) {
            pickSync.reset();
            socketOwnerId = currentUser?.id;
        }
        if (!currentUser) {
            // No socket for anonymous users - they use local mode
            setSocket(undefined);
            setConnectionStatus("disconnected");
            return;
        }

        const newSocket = createAuthenticatedSocket();

        // Track if we've had a successful connection before
        // so we can distinguish reconnects from initial connect
        let hasConnectedBefore = false;
        // Set by reconnect_attempt: a first connection that only succeeded
        // after retries also needs a resync, because broadcasts sent between
        // the REST load and this late room join were never received.
        let connectRetried = false;

        newSocket.on("connect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
            pickSync.setConnected(true);
            if (hasConnectedBefore || connectRetried) {
                setJustReconnected(true);
            }
            hasConnectedBefore = true;
            connectRetried = false;
        });

        newSocket.on("disconnect", () => {
            pickSync.setConnected(false);
            setConnectionStatus("disconnected");
        });

        // The namespace refused us (auth rejected) after the transport came
        // up. The Manager will not retry on its own here, so the status must
        // leave "connecting" or the banner and the pick pill stay stuck.
        newSocket.on("connect_error", () => {
            if (!newSocket.active) setConnectionStatus("error");
        });

        // Only namespace connect marks us connected and requests a resync.
        // Manager reconnect fires earlier, before authentication, and caused
        // a second canvas fetch that could overwrite an in-flight pick.

        const onDraftUpdate = (raw: unknown) => {
            const data = CanvasDraftUpdateSchema.safeParse(raw);
            if (data.success && data.data.picksVersion !== undefined)
                pickSync.receive(data.data);
        };
        newSocket.on("draftUpdate", onDraftUpdate);

        newSocket.io.on("reconnect_attempt", (attemptNumber) => {
            connectRetried = true;
            setConnectionStatus("connecting");
            setReconnectAttempts(attemptNumber);
        });

        newSocket.io.on("reconnect_failed", () => {
            setConnectionStatus("error");
        });

        setSocket(newSocket);

        onCleanup(() => {
            pickSync.setConnected(false);
            newSocket.disconnect();
            newSocket.off("connect");
            newSocket.off("disconnect");
            newSocket.off("connect_error");
            newSocket.off("draftUpdate", onDraftUpdate);
            newSocket.io.off("reconnect_attempt");
            newSocket.io.off("reconnect_failed");
        });
    });

    const [presence, setPresence] = createStore<{ users: PresenceUser[] }>({
        users: []
    });

    // Last-known viewports live at provider level, not in Canvas.tsx: the
    // Share popover offers jump from anywhere in the workflow, and viewport
    // events are throttled pan/zoom-frequency (not mousemove-frequency), so
    // an always-on listener is cheap. State machine is unit-tested.
    const viewportTracker = createRemoteViewportTracker(() => user()?.id);
    const lockTracker = createAnnotationLockTracker(() => user()?.id);

    createEffect(() => {
        const sock = socket();
        if (!sock) return;

        // Late events from a previous canvas are dropped by the canvasId
        // guard rather than by listener teardown ordering.
        const onSnapshot = (data: unknown) => {
            const parsed = validateSocketEvent(
                "presenceSnapshot",
                data,
                presenceSnapshotSchema
            );
            if (!parsed || parsed.canvasId !== presenceCanvasId()) return;
            setPresence("users", reconcile(parsed.users, { key: "userId" }));
            viewportTracker.handleSnapshot(parsed.users);
            lockTracker.handleSnapshot(parsed.annotationLocks);
        };

        const onJoin = (data: unknown) => {
            const parsed = validateSocketEvent("presenceJoin", data, presenceJoinSchema);
            if (!parsed || parsed.canvasId !== presenceCanvasId()) return;
            const others = presence.users.filter((u) => u.userId !== parsed.user.userId);
            setPresence("users", reconcile([...others, parsed.user], { key: "userId" }));
        };

        const onLeave = (data: unknown) => {
            const parsed = validateSocketEvent(
                "presenceLeave",
                data,
                presenceLeaveSchema
            );
            if (!parsed || parsed.canvasId !== presenceCanvasId()) return;
            setPresence(
                "users",
                reconcile(
                    presence.users.filter((u) => u.userId !== parsed.userId),
                    { key: "userId" }
                )
            );
            // A fully departed user's viewport is no longer jumpable.
            viewportTracker.handleViewportLeave(data, parsed.canvasId);
        };

        // Viewport broadcast (slice 4): same quiet validation policy as
        // cursor events — these arrive at pan/zoom frequency.
        const onViewportMove = (data: unknown) => {
            const canvasId = presenceCanvasId();
            if (!canvasId) return;
            viewportTracker.handleViewportMove(data, canvasId);
        };

        const onViewportLeave = (data: unknown) => {
            const canvasId = presenceCanvasId();
            if (!canvasId) return;
            viewportTracker.handleViewportLeave(data, canvasId);
        };

        const onAnnotationLockChanged = (data: unknown) => {
            const canvasId = presenceCanvasId();
            if (!canvasId) return;
            lockTracker.handleLockChanged(data, canvasId);
        };

        const onAnnotationLockDenied = (data: unknown) => {
            const parsed = validateSocketEvent(
                "annotationLockDenied",
                data,
                annotationLockDeniedSchema
            );
            if (!parsed || parsed.canvasId !== presenceCanvasId()) return;
            toast.error("Someone else is editing this note");
        };

        // Server-side revocation ejection: our access was removed while we
        // were viewing this canvas (or its child draft view). The server has
        // already forced this socket out of the room; leave the dead UI.
        const onAccessRevoked = (data: unknown) => {
            const parsed = validateSocketEvent(
                "canvasAccessRevoked",
                data,
                canvasAccessRevokedSchema
            );
            if (!parsed || parsed.canvasId !== presenceCanvasId()) return;
            toast.error("Your access to this canvas was removed");
            navigate("/canvas/dashboard");
        };

        sock.on("presenceSnapshot", onSnapshot);
        sock.on("presenceJoin", onJoin);
        sock.on("presenceLeave", onLeave);
        sock.on("viewportMove", onViewportMove);
        sock.on("viewportLeave", onViewportLeave);
        sock.on("annotationLockChanged", onAnnotationLockChanged);
        sock.on("annotationLockDenied", onAnnotationLockDenied);
        sock.on("canvasAccessRevoked", onAccessRevoked);
        onCleanup(() => {
            sock.off("presenceSnapshot", onSnapshot);
            sock.off("presenceJoin", onJoin);
            sock.off("presenceLeave", onLeave);
            sock.off("viewportMove", onViewportMove);
            sock.off("viewportLeave", onViewportLeave);
            sock.off("annotationLockChanged", onAnnotationLockChanged);
            sock.off("annotationLockDenied", onAnnotationLockDenied);
            sock.off("canvasAccessRevoked", onAccessRevoked);
        });
    });

    // Gated canvas room membership (replaces the legacy joinRoom emit that
    // lived in Canvas.tsx and dropped presence when opening a draft view).
    // connectionStatus flips through disconnected → connected on reconnect,
    // so this effect also re-emits joinCanvas after a reconnect.
    createEffect(() => {
        const sock = socket();
        const canvasId = presenceCanvasId();
        if (!sock || !canvasId || connectionStatus() !== "connected") return;

        sock.emit("joinCanvas", { canvasId });
        onCleanup(() => {
            setPresence("users", reconcile([], { key: "userId" }));
            viewportTracker.reset();
            lockTracker.reset();
            if (sock.connected) {
                sock.emit("leaveCanvas", { canvasId });
            }
        });
    });

    const contextValue: CanvasSocketContextValue = {
        pickSync,
        pickSyncVersion,
        socket,
        connectionStatus,
        connectionInfo,
        reconnect,
        justReconnected,
        clearReconnected,
        presenceUsers: () => presence.users,
        remoteViewportOf: viewportTracker.viewportOf,
        annotationLockOf: lockTracker.lockedBy
    };

    // For anonymous users (local mode), skip the connection banner
    // since there's no socket to connect
    const isLocalMode = () => !user();

    return (
        <CanvasSocketContext.Provider value={contextValue}>
            <div class="flex flex-1 flex-col overflow-hidden">
                <Show when={pendingPicks() > 0}>
                    <div
                        class="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-3 rounded border border-purple-500/30 bg-slate-800 px-3 py-2 text-sm text-slate-200 shadow-lg"
                        role="status"
                        aria-live="polite"
                    >
                        <span>
                            {pickSaveError() ??
                                (connectionStatus() === "connected"
                                    ? "Saving pick changes…"
                                    : "Pick changes will save when reconnected.")}
                        </span>
                        <Show when={pickSaveError()}>
                            <button
                                type="button"
                                class="rounded px-2 py-1 text-purple-400 hover:bg-slate-700 disabled:opacity-50"
                                disabled={connectionStatus() !== "connected"}
                                onClick={() => pickSync.retry()}
                            >
                                Retry save
                            </button>
                            <button
                                type="button"
                                class="rounded px-2 py-1 hover:bg-slate-700"
                                onClick={() => pickSync.discardFailed()}
                            >
                                Discard unsaved changes
                            </button>
                        </Show>
                    </div>
                </Show>
                {!isLocalMode() && (
                    <ConnectionBanner
                        connectionStatus={connectionStatus}
                        connectionInfo={connectionInfo}
                        onReconnect={reconnect}
                    />
                )}
                {props.children}
            </div>
        </CanvasSocketContext.Provider>
    );
}

export function useCanvasSocket(): CanvasSocketContextValue {
    const context = useContext(CanvasSocketContext);
    if (!context) {
        throw new Error("useCanvasSocket must be used within CanvasSocketProvider");
    }
    return context;
}
