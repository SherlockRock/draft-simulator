import {
    Accessor,
    createContext,
    createMemo,
    createResource,
    useContext
} from "solid-js";
import { JSX } from "solid-js";
import { AnonSocketProvider, useAnonSocket } from "./anonSocketProvider";
import { SocketProvider, useSocket } from "./socketProvider";
import { fetchUserDetails } from "./utils/actions";

const UserContext = createContext<Accessor<Array<any>>>();

export function UserProvider(props: { children: JSX.Element }) {
    const socket = useSocket();
    const anonSocket = useAnonSocket();
    const [user, { mutate }] = createResource(fetchUserDetails);
    const holdUser = createMemo(() => [
        user,
        {
            logout() {
                mutate(undefined);
            }
        },
        user() !== undefined ? socket : anonSocket
    ]);

    return (
        <UserContext.Provider value={holdUser}>
            {user() !== undefined ? (
                <SocketProvider>{props.children}</SocketProvider>
            ) : (
                <AnonSocketProvider>{props.children}</AnonSocketProvider>
            )}
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
