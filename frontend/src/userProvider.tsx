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
import { syncLocalCanvasToServer } from "./utils/syncLocalCanvas";
import toast from "solid-toast";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type ConnectionInfo = {
    status: ConnectionStatus;
    reconnectAttempts: number;
};

export type UserData = {
    id: string;
    name: string;
    email: string;
    picture: string;
};

export interface UserAccessor {
    (): UserData | null | undefined;
    isLoading: boolean;
    loading: boolean;
    isError: boolean;
    error: Error | null;
}

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
            setReconnectAttempts(0);
            setConnectionStatus("connecting");
            socket.connect();
        }
    };

    const isOAuthCallback = () => window.location.pathname.includes("/oauth2callback");

    const userQuery = useQuery(() => {
        const enabled = !isOAuthCallback();

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
        userQuery.refetch();

        // Check for local canvas to sync
        try {
            const syncedCanvasId = await syncLocalCanvasToServer();
            if (syncedCanvasId) {
                toast.success("Your canvas has been saved to your account!");
                navigate(`/canvas/${syncedCanvasId}`, { replace: true });
                return res?.user;
            }
        } catch (error) {
            console.error("Failed to sync local canvas:", error);
            toast.error("Couldn't save your local canvas. It's still stored locally.");
        }

        navigate(res?.returnTo ?? "/", { replace: true });
        return res?.user;
    };

    const logout = async () => {
        await handleRevoke();
        queryClient.setQueryData(["user"], null);
    };

    // Create a compatibility wrapper that mimics the old createResource API
    const userAccessor = (() => userQuery.data) as UserAccessor;
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
        const currentUser = userQuery.data;
        const isLoading = userQuery.isLoading;
        const isFetching = userQuery.isFetching;

        // Don't create socket while user is still loading or fetching
        if (isLoading || isFetching) {
            setCurrentSocket(undefined);
            setConnectionStatus("connecting");
            return;
        }

        let newSocket: Socket | undefined;
        if (currentUser) {
            newSocket = createAuthenticatedSocket();
        } else {
            newSocket = createAnonymousSocket();
        }

        newSocket.on("connect", () => {
            setConnectionStatus("connected");
            setReconnectAttempts(0);
            // Don't re-set currentSocket - it's already set and re-setting causes cleanup
        });

        newSocket.on("disconnect", () => {
            setConnectionStatus("disconnected");
        });

        // Socket.io manager events for reconnection tracking
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

        setCurrentSocket(newSocket);

        onCleanup(() => {
            if (newSocket) {
                newSocket.disconnect();
                newSocket.off("disconnect");
                newSocket.off("connect");
                // Clean up manager events
                newSocket.io.off("reconnect");
                newSocket.io.off("reconnect_attempt");
                newSocket.io.off("reconnect_failed");
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
