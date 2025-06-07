import { createContext, useContext } from "solid-js";
import { io } from "socket.io-client";
import { JSX } from "solid-js";
import { BASE_URL } from "./utils/actions";

const anonSocket = io(BASE_URL);

export const AnonSocketContext = createContext(anonSocket);

export function AnonSocketProvider(props: { children: JSX.Element }) {
    return (
        <AnonSocketContext.Provider value={anonSocket}>
            {props.children}
        </AnonSocketContext.Provider>
    );
}

export const useAnonSocket = () => useContext(AnonSocketContext);
