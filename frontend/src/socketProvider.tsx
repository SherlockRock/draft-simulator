import { createContext, useContext } from "solid-js";
import { io } from "socket.io-client";
import { JSX } from "solid-js";

const socket = io(import.meta.env.VITE_API_URL, { withCredentials: true });

export const SocketContext = createContext(socket);

export function SocketProvider(props: { children: JSX.Element }) {
    return (
        <SocketContext.Provider value={socket}>{props.children}</SocketContext.Provider>
    );
}

export const useSocket = () => useContext(SocketContext);
