import {
    Accessor,
    createContext,
    createMemo,
    createResource,
    onMount,
    useContext,
    onCleanup,
    JSX,
    createEffect,
    createSignal
} from "solid-js";
import { fetchUserDetails } from "./utils/actions";
import { io, Socket } from "socket.io-client";

const socketOptions = {
    pingInterval: 25000,
    pingTimeout: 5000,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
};
const socketUrl = import.meta.env.VITE_API_URL;

const createAnonymousSocket = () => io(socketUrl, socketOptions);
const createAuthenticatedSocket = () =>
    io(socketUrl, { ...socketOptions, withCredentials: true });

const UserContext = createContext<Accessor<Array<any>>>();

export function UserProvider(props: { children: JSX.Element }) {
    const [user, { mutate, refetch }] = createResource(fetchUserDetails);
    const [currentSocket, setCurrentSocket] = createSignal<Socket | undefined>(undefined);
    const logout = () => {
        mutate(undefined);
    };
    const holdUser = createMemo(() => [
        user,
        {
            logout
        },
        currentSocket
    ]);

    // createEffect to manage the socket instance based on user changes
    createEffect(() => {
        const currentUser = user();
        let newSocket: Socket | undefined;
        if (currentUser) {
            newSocket = createAuthenticatedSocket();
        } else {
            newSocket = createAnonymousSocket();
        }
        setCurrentSocket(newSocket);

        onCleanup(() => {
            console.log("Cleaning up effect, disconnecting socket:", newSocket?.id);
            if (newSocket && newSocket.connected) {
                newSocket.disconnect();
            }
        });
    });

    onMount(() => {
        const interval = setInterval(
            () => {
                refetch();
            },
            24 * 60 * 60 * 1000 // 24 hours in milliseconds
        );

        onCleanup(() => {
            clearInterval(interval);
        });
    });

    return <UserContext.Provider value={holdUser}>{props.children}</UserContext.Provider>;
}

export function useUser() {
    const context = useContext(UserContext);
    if (!context) {
        throw new Error("useSignal must be used within a SignalProvider");
    }
    return context;
}
