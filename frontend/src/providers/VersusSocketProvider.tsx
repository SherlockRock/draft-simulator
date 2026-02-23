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
    createAuthenticatedSocket,
    createAnonymousSocket
} from "./socketUtils";
import { useUser } from "../userProvider";
import ConnectionBanner from "../ConnectionBanner";

const VersusSocketContext = createContext<SocketContextValue>();

export function VersusSocketProvider(props: { children: JSX.Element }) {
    const accessor = useUser();
    const [user] = accessor();

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
        // Create authenticated socket if user is logged in, anonymous otherwise
        const currentUser = user();
        const newSocket = currentUser
            ? createAuthenticatedSocket()
            : createAnonymousSocket();

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
        <VersusSocketContext.Provider value={contextValue}>
            <div class="flex flex-1 flex-col overflow-hidden">
                <ConnectionBanner
                    connectionStatus={connectionStatus}
                    connectionInfo={connectionInfo}
                    onReconnect={reconnect}
                />
                {props.children}
            </div>
        </VersusSocketContext.Provider>
    );
}

export function useVersusSocket(): SocketContextValue {
    const context = useContext(VersusSocketContext);
    if (!context) {
        throw new Error("useVersusSocket must be used within VersusSocketProvider");
    }
    return context;
}
