import {
    createContext,
    useContext,
    createSignal,
    createEffect,
    onCleanup,
    JSX,
    createMemo,
    Accessor
} from "solid-js";
import { Socket } from "socket.io-client";
import {
    ConnectionStatus,
    ConnectionInfo,
    SocketContextValue,
    createAuthenticatedSocket
} from "./socketUtils";
import ConnectionBanner from "../ConnectionBanner";

const CanvasSocketContext = createContext<SocketContextValue>();

export function CanvasSocketProvider(props: { children: JSX.Element }) {
    const [socket, setSocket] = createSignal<Socket | undefined>(undefined);
    const [connectionStatus, setConnectionStatus] =
        createSignal<ConnectionStatus>("connecting");
    const [reconnectAttempts, setReconnectAttempts] = createSignal(0);

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

    createEffect(() => {
        const newSocket = createAuthenticatedSocket();

        newSocket.on("connect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
        });

        newSocket.on("disconnect", () => {
            setConnectionStatus("disconnected");
        });

        newSocket.io.on("reconnect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
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
        reconnect
    };

    return (
        <CanvasSocketContext.Provider value={contextValue}>
            <ConnectionBanner
                connectionStatus={connectionStatus}
                connectionInfo={connectionInfo}
                onReconnect={reconnect}
            />
            {props.children}
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
