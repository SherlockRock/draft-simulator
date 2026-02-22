import { io, Socket } from "socket.io-client";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export type ConnectionInfo = {
    status: ConnectionStatus;
    reconnectAttempts: number;
};

export type SocketContextValue = {
    socket: () => Socket | undefined;
    connectionStatus: () => ConnectionStatus;
    connectionInfo: () => ConnectionInfo;
    reconnect: () => void;
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

export const createAnonymousSocket = () => io(socketUrl, socketOptions);
export const createAuthenticatedSocket = () =>
    io(socketUrl, { ...socketOptions, withCredentials: true });
