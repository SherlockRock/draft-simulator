import {
    createContext,
    useContext,
    createSignal,
    createEffect,
    onCleanup,
    JSX,
    createMemo
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { useParams } from "@solidjs/router";
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
    presenceSnapshotSchema,
    presenceJoinSchema,
    presenceLeaveSchema
} from "../utils/presence";

export type CanvasSocketContextValue = SocketContextValue & {
    presenceUsers: () => PresenceUser[];
};

const CanvasSocketContext = createContext<CanvasSocketContextValue>();

export function CanvasSocketProvider(props: { children: JSX.Element }) {
    const accessor = useUser();
    const [user] = accessor();
    const params = useParams();

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

        newSocket.on("connect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
            // Set justReconnected if this is a reconnect (not initial connection)
            if (hasConnectedBefore) {
                setJustReconnected(true);
            }
            hasConnectedBefore = true;
        });

        newSocket.on("disconnect", () => {
            setConnectionStatus("disconnected");
        });

        newSocket.io.on("reconnect", () => {
            // This fires for auto-reconnects by the Manager
            // The connect handler above also handles manual reconnects
            setConnectionStatus("connected");
            setReconnectAttempts(0);
            setJustReconnected(true);
        });

        newSocket.io.on("reconnect_attempt", (attemptNumber) => {
            setConnectionStatus("connecting");
            setReconnectAttempts(attemptNumber);
        });

        newSocket.io.on("reconnect_failed", () => {
            setConnectionStatus("error");
        });

        setSocket(newSocket);

        onCleanup(() => {
            newSocket.disconnect();
            newSocket.off("connect");
            newSocket.off("disconnect");
            newSocket.io.off("reconnect");
            newSocket.io.off("reconnect_attempt");
            newSocket.io.off("reconnect_failed");
        });
    });

    const [presence, setPresence] = createStore<{ users: PresenceUser[] }>({
        users: []
    });

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
        };

        sock.on("presenceSnapshot", onSnapshot);
        sock.on("presenceJoin", onJoin);
        sock.on("presenceLeave", onLeave);
        onCleanup(() => {
            sock.off("presenceSnapshot", onSnapshot);
            sock.off("presenceJoin", onJoin);
            sock.off("presenceLeave", onLeave);
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
            if (sock.connected) {
                sock.emit("leaveCanvas", { canvasId });
            }
        });
    });

    const contextValue: CanvasSocketContextValue = {
        socket,
        connectionStatus,
        connectionInfo,
        reconnect,
        justReconnected,
        clearReconnected,
        presenceUsers: () => presence.users
    };

    // For anonymous users (local mode), skip the connection banner
    // since there's no socket to connect
    const isLocalMode = () => !user();

    return (
        <CanvasSocketContext.Provider value={contextValue}>
            <div class="flex flex-1 flex-col overflow-hidden">
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
