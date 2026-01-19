import {
    Accessor,
    createContext,
    createMemo,
    useContext,
    onCleanup,
    JSX,
    createEffect,
    createSignal
} from "solid-js";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { fetchUserDetails, handleGoogleLogin, handleRevoke } from "./utils/actions";
import { io, Socket } from "socket.io-client";
import { useNavigate } from "@solidjs/router";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type ConnectionInfo = {
    status: ConnectionStatus;
    reconnectAttempts: number;
};

const socketOptions = {
    pingInterval: 25000,
    pingTimeout: 5000,
    reconnection: true,
    reconnectionAttempts: 3,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
};
const socketUrl = import.meta.env.VITE_API_URL;

const createAnonymousSocket = () => io(socketUrl, socketOptions);
const createAuthenticatedSocket = () =>
    io(socketUrl, { ...socketOptions, withCredentials: true });

const UserContext = createContext<Accessor<Array<any>>>();

export function UserProvider(props: { children: JSX.Element }) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [currentSocket, setCurrentSocket] = createSignal<Socket | undefined>(undefined);
    const [connectionStatus, setConnectionStatus] =
        createSignal<ConnectionStatus>("connecting");
    const [reconnectAttempts, setReconnectAttempts] = createSignal(0);

    // Manual reconnect function - forces a new socket connection
    const manualReconnect = () => {
        const socket = currentSocket();
        if (socket) {
            console.log(">>> Manual reconnect triggered");
            setReconnectAttempts(0);
            setConnectionStatus("connecting");
            socket.connect();
        }
    };

    const isOAuthCallback = () => window.location.pathname.includes("/oauth2callback");

    const userQuery = useQuery(() => {
        const enabled = !isOAuthCallback();
        console.log(
            ">>> Creating query, enabled:",
            enabled,
            "path:",
            window.location.pathname
        );

        return {
            queryKey: ["user"],
            queryFn: fetchUserDetails,
            enabled: enabled,
            staleTime: 1000 * 60 * 60 * 24, // 24 hours
            retry: false
        };
    });

    const login = async (code: string, state: string) => {
        const res = await handleGoogleLogin(code, state);
        console.log("User logged in:", res);
        userQuery.refetch();
        console.log("Redirecting to:", res?.returnTo ?? "/");
        navigate(res?.returnTo ?? "/", { replace: true });
        return res?.user;
    };

    const logout = async () => {
        await handleRevoke();
        queryClient.setQueryData(["user"], null);
    };

    // Create a compatibility wrapper that mimics the old createResource API
    const userAccessor = () => userQuery.data;
    // Add query state properties to the accessor function for advanced usage
    Object.defineProperty(userAccessor, "loading", {
        get: () => userQuery.isLoading
    });
    Object.defineProperty(userAccessor, "error", {
        get: () => userQuery.error
    });
    Object.defineProperty(userAccessor, "isLoading", {
        get: () => userQuery.isLoading
    });
    Object.defineProperty(userAccessor, "isError", {
        get: () => userQuery.isError
    });

    const connectionInfo = createMemo<ConnectionInfo>(() => ({
        status: connectionStatus(),
        reconnectAttempts: reconnectAttempts()
    }));

    const holdUser = createMemo(() => [
        userAccessor,
        {
            login,
            logout,
            refetch: userQuery.refetch,
            reconnect: manualReconnect
        },
        currentSocket,
        connectionStatus,
        connectionInfo
    ]);

    createEffect(() => {
        // Explicitly track query status to ensure effect re-runs
        const status = userQuery.status;
        const currentUser = userQuery.data;
        const isLoading = userQuery.isLoading;
        const isError = userQuery.isError;
        const isFetching = userQuery.isFetching;

        console.log(
            ">>> UserProvider effect running",
            "status:",
            status,
            "currentUser:",
            currentUser?.id || "anonymous",
            "isLoading:",
            isLoading,
            "isFetching:",
            isFetching,
            "isError:",
            isError
        );

        // Don't create socket while user is still loading or fetching
        if (isLoading || isFetching) {
            console.log(">>> User still loading/fetching, skipping socket creation");
            setCurrentSocket(undefined);
            setConnectionStatus("connecting");
            return;
        }

        // Handle error state (treat as anonymous)
        if (isError) {
            console.log(">>> User fetch error, treating as anonymous");
        }

        console.log(">>> User loaded successfully, creating socket");

        let newSocket: Socket | undefined;
        if (currentUser) {
            console.log(">>> Creating authenticated socket");
            newSocket = createAuthenticatedSocket();
        } else {
            console.log(">>> Creating anonymous socket");
            newSocket = createAnonymousSocket();
        }

        newSocket.on("connect", () => {
            console.log("Socket.IO: Connected! ID:", newSocket.id);
            console.log(">>> UserProvider: Socket connected, updating connection status");
            setConnectionStatus("connected");
            setReconnectAttempts(0);
            // Don't re-set currentSocket - it's already set and re-setting causes cleanup
        });

        newSocket.on("disconnect", (reason) => {
            console.warn("Socket.IO: Disconnected! Reason:", reason);
            setConnectionStatus("disconnected");
        });

        newSocket.on("connect_error", (err) => {
            console.error("Socket.IO: Connection Error!", err.message);
            // Don't set status to "error" here - let auto-reconnect continue
            // Status will be set to "error" by reconnect_failed after all attempts exhausted
        });

        // Socket.io manager events for reconnection tracking
        newSocket.io.on("reconnect", (attemptNumber) => {
            console.log("Socket.IO: Reconnected after", attemptNumber, "attempts");
            setConnectionStatus("connected");
            setReconnectAttempts(0);
        });

        newSocket.io.on("reconnect_attempt", (attemptNumber) => {
            console.log("Socket.IO: Reconnect attempt", attemptNumber);
            setConnectionStatus("connecting");
            setReconnectAttempts(attemptNumber);
        });

        newSocket.io.on("reconnect_failed", () => {
            console.error("Socket.IO: Reconnection Failed Permanently!");
            setConnectionStatus("error");
        });

        console.log(
            ">>> UserProvider: Setting currentSocket to:",
            newSocket?.id,
            "connected:",
            newSocket?.connected
        );
        setCurrentSocket(newSocket);

        onCleanup(() => {
            console.log(">>> UserProvider cleanup running!");
            console.log(
                ">>> Cleaning up socket:",
                newSocket?.id,
                "connected:",
                newSocket?.connected
            );
            if (newSocket) {
                newSocket.disconnect();
                newSocket.off("disconnect");
                newSocket.off("connect_error");
                newSocket.off("connect");
                // Clean up manager events
                newSocket.io.off("reconnect");
                newSocket.io.off("reconnect_attempt");
                newSocket.io.off("reconnect_failed");
                console.log(">>> Socket disconnected and cleaned up");
            }
        });
    });

    // TanStack Query handles refetching automatically with staleTime

    return (
        <UserContext.Provider value={holdUser}>
            <div class="h-full">{props.children}</div>
        </UserContext.Provider>
    );
}

export function useUser() {
    const context = useContext(UserContext);
    if (!context) {
        throw new Error("useSignal must be used within a SignalProvider");
    }
    return context;
}
