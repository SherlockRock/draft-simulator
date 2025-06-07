import { createContext, useContext } from "solid-js";
import { io } from "socket.io-client";
import { JSX } from "solid-js";
import { BASE_URL } from "./utils/actions";

const socket = io(BASE_URL, { withCredentials: true });

export const SocketContext = createContext(socket);

export function SocketProvider(props: { children: JSX.Element }) {
    return (
        <SocketContext.Provider value={socket}>{props.children}</SocketContext.Provider>
    );
}

export const useSocket = () => useContext(SocketContext);
