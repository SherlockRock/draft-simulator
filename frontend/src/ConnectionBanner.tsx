import { Show } from "solid-js";
import { useUser } from "./userProvider";

const ConnectionBanner = () => {
    const accessor = useUser();
    const [, userMethods, , connectionStatus, connectionInfo] = accessor();

    const handleReconnect = () => {
        userMethods.reconnect();
    };

    return (
        <Show when={connectionStatus() !== "connected"}>
            <div
                class="fixed left-0 right-0 top-0 z-50 flex items-center justify-center gap-4 p-3 text-center font-bold text-slate-50"
                classList={{
                    "bg-yellow-600": connectionStatus() === "connecting",
                    "bg-red-600":
                        connectionStatus() === "disconnected" ||
                        connectionStatus() === "error"
                }}
            >
                <div class="flex items-center gap-2">
                    <Show when={connectionStatus() === "connecting"}>
                        <svg
                            class="h-5 w-5 animate-spin"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                        >
                            <circle
                                class="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                stroke-width="4"
                            />
                            <path
                                class="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                        </svg>
                        <span>
                            Reconnecting to server
                            <Show when={connectionInfo().reconnectAttempts > 0}>
                                {" "}
                                (attempt {connectionInfo().reconnectAttempts})
                            </Show>
                            ...
                        </span>
                    </Show>
                    <Show when={connectionStatus() === "disconnected"}>
                        <svg
                            class="h-5 w-5"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3"
                            />
                        </svg>
                        <span>Disconnected from server</span>
                    </Show>
                    <Show when={connectionStatus() === "error"}>
                        <svg
                            class="h-5 w-5"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                            />
                        </svg>
                        <span>Connection error</span>
                    </Show>
                </div>
                <Show
                    when={
                        connectionStatus() === "error" ||
                        connectionStatus() === "disconnected"
                    }
                >
                    <button
                        onClick={handleReconnect}
                        class="rounded-md bg-white/20 px-3 py-1 text-sm font-medium transition-colors hover:bg-white/30"
                    >
                        Reconnect
                    </button>
                </Show>
            </div>
        </Show>
    );
};

export default ConnectionBanner;
