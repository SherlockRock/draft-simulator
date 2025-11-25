import { Show } from "solid-js";
import { useUser } from "./userProvider";

const ConnectionBanner = () => {
    const accessor = useUser();
    const connectionStatus = accessor()[3];

    return (
        <Show when={connectionStatus() !== "connected"}>
            <div
                class="fixed left-0 right-0 top-0 z-50 p-3 text-center font-bold text-slate-50"
                classList={{
                    "bg-yellow-500": connectionStatus() === "connecting",
                    "bg-red-500":
                        connectionStatus() === "disconnected" ||
                        connectionStatus() === "error"
                }}
            >
                <Show when={connectionStatus() === "connecting"}>
                    Reconnecting to server...
                </Show>
                <Show when={connectionStatus() === "disconnected"}>
                    Disconnected from server. Attempting to reconnect...
                </Show>
                <Show when={connectionStatus() === "error"}>
                    Connection error! Please check your internet or try refreshing.
                </Show>
            </div>
        </Show>
    );
};

export default ConnectionBanner;
