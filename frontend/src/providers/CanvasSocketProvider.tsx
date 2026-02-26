import {
    createContext,
    useContext,
    createSignal,
    createEffect,
    onCleanup,
    JSX,
    createMemo
} from "solid-js";
import { Socket } from "socket.io-client";
import {
    ConnectionStatus,
    ConnectionInfo,
    SocketContextValue,
    createAuthenticatedSocket
} from "./socketUtils";
import { useUser } from "../userProvider";
import ConnectionBanner from "../ConnectionBanner";

const CanvasSocketContext = createContext<SocketContextValue>();

export function CanvasSocketProvider(props: { children: JSX.Element }) {
    const accessor = useUser();
    const [user] = accessor();

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

    const contextValue: SocketContextValue = {
        socket,
        connectionStatus,
        connectionInfo,
        reconnect,
        justReconnected,
        clearReconnected
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

export function useCanvasSocket(): SocketContextValue {
    const context = useContext(CanvasSocketContext);
    if (!context) {
        throw new Error("useCanvasSocket must be used within CanvasSocketProvider");
    }
    return context;
}
