import { Show, Accessor } from "solid-js";
import { Loader2, WifiOff, AlertTriangle } from "lucide-solid";
import { ConnectionStatus, ConnectionInfo } from "./providers/socketUtils";

type Props = {
    connectionStatus: Accessor<ConnectionStatus>;
    connectionInfo: Accessor<ConnectionInfo>;
    onReconnect: () => void;
};

const ConnectionBanner = (props: Props) => {
    // Only show banner when:
    // - Reconnecting (not initial connect) - connecting with attempts > 0
    // - Disconnected or error state
    const shouldShow = () => {
        const status = props.connectionStatus();
        if (status === "disconnected" || status === "error") return true;
        if (status === "connecting" && props.connectionInfo().reconnectAttempts > 0)
            return true;
        return false;
    };

    return (
        <Show when={shouldShow()}>
            <div
                class="flex items-center justify-center gap-4 p-3 text-center font-bold text-slate-50"
                classList={{
                    "bg-yellow-600": props.connectionStatus() === "connecting",
                    "bg-red-600":
                        props.connectionStatus() === "disconnected" ||
                        props.connectionStatus() === "error"
                }}
            >
                <div class="flex items-center gap-2">
                    <Show when={props.connectionStatus() === "connecting"}>
                        <Loader2 size={20} class="animate-spin" />
                        <span>
                            Reconnecting to server
                            <Show when={props.connectionInfo().reconnectAttempts > 0}>
                                {" "}
                                (attempt {props.connectionInfo().reconnectAttempts})
                            </Show>
                            ...
                        </span>
                    </Show>
                    <Show when={props.connectionStatus() === "disconnected"}>
                        <WifiOff size={20} />
                        <span>Disconnected from server</span>
                    </Show>
                    <Show when={props.connectionStatus() === "error"}>
                        <AlertTriangle size={20} />
                        <span>Connection error</span>
                    </Show>
                </div>
                <Show
                    when={
                        props.connectionStatus() === "error" ||
                        props.connectionStatus() === "disconnected"
                    }
                >
                    <button
                        onClick={props.onReconnect}
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
