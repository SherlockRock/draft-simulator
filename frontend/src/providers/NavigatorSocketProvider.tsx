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
import { Socket } from "socket.io-client";
import {
    ConnectionStatus,
    ConnectionInfo,
    SocketContextValue,
    createAuthenticatedSocket
} from "./socketUtils";
import { useUser } from "../userProvider";
import ConnectionBanner from "../ConnectionBanner";

const NavigatorSocketContext = createContext<SocketContextValue>();

export function NavigatorSocketProvider(props: { children: JSX.Element }) {
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

    createEffect(() => {
        const currentUser = user();
        if (!currentUser) {
            setSocket(undefined);
            setConnectionStatus("disconnected");
            setReconnectAttempts(0);
            setJustReconnected(false);
            return;
        }

        const newSocket = createAuthenticatedSocket();
        let hasConnectedBefore = false;

        newSocket.on("connect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
            if (hasConnectedBefore) {
                setJustReconnected(true);
            }
            hasConnectedBefore = true;
        });

        newSocket.on("disconnect", () => {
            setConnectionStatus("disconnected");
        });

        newSocket.io.on("reconnect", () => {
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

    return (
        <NavigatorSocketContext.Provider value={contextValue}>
            <div class="flex flex-1 flex-col overflow-hidden">
                <Show when={user()}>
                    <ConnectionBanner
                        connectionStatus={connectionStatus}
                        connectionInfo={connectionInfo}
                        onReconnect={reconnect}
                    />
                </Show>
                {props.children}
            </div>
        </NavigatorSocketContext.Provider>
    );
}

export function useNavigatorSocket(): SocketContextValue {
    const context = useContext(NavigatorSocketContext);
    if (!context) {
        throw new Error("useNavigatorSocket must be used within NavigatorSocketProvider");
    }
    return context;
}
