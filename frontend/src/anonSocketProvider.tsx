import { createContext, useContext } from "solid-js";
import { io } from "socket.io-client";
import { JSX } from "solid-js";

const anonSocket = io(import.meta.env.VITE_API_URL);

export const AnonSocketContext = createContext(anonSocket);

export function AnonSocketProvider(props: { children: JSX.Element }) {
    return (
        <AnonSocketContext.Provider value={anonSocket}>
            {props.children}
        </AnonSocketContext.Provider>
    );
}

export const useAnonSocket = () => useContext(AnonSocketContext);
