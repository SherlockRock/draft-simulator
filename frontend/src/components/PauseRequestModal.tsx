import { Component, Show } from "solid-js";

interface PauseRequestModalProps {
    isOpen: boolean;
    requestType: "pause" | "resume";
    requestingTeam: "blue" | "red";
    blueTeamName: string;
    redTeamName: string;
    onApprove: () => void;
    onReject: () => void;
}

export const PauseRequestModal: Component<PauseRequestModalProps> = (props) => {
    const getTeamName = () => {
        return props.requestingTeam === "blue" ? props.blueTeamName : props.redTeamName;
    };

    const getTeamColor = () => {
        return props.requestingTeam === "blue" ? "text-blue-400" : "text-red-400";
    };

    const getIcon = () => {
        return props.requestType === "pause" ? "⏸️" : "▶️";
    };

    const getTitle = () => {
        return props.requestType === "pause" ? "Pause Requested" : "Resume Requested";
    };

    const getMessage = () => {
        const action = props.requestType === "pause" ? "pause" : "resume";
        return `has requested to ${action} the draft`;
    };

    return (
        <Show when={props.isOpen}>
            <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                <div class="w-full max-w-md rounded-lg border border-slate-700 bg-slate-800 p-8">
                    <div class="mb-6 text-center">
                        <div class="mb-4 text-6xl">{getIcon()}</div>
                        <h2 class="mb-2 text-2xl font-bold text-slate-50">
                            {getTitle()}
                        </h2>
                        <p class="text-slate-400">
                            <span class={`font-semibold ${getTeamColor()}`}>
                                {getTeamName()}
                            </span>{" "}
                            {getMessage()}
                        </p>
                    </div>

                    <div class="flex gap-3">
                        <button
                            onClick={props.onReject}
                            class="flex-1 rounded-lg border-2 border-red-600/50 bg-red-600/10 px-4 py-3 font-semibold text-red-400 transition-all hover:border-red-500 hover:bg-red-600/20"
                        >
                            Reject
                        </button>
                        <button
                            onClick={props.onApprove}
                            class="flex-1 rounded-lg border-2 border-teal-600/50 bg-teal-600/10 px-4 py-3 font-semibold text-teal-400 transition-all hover:border-teal-500 hover:bg-teal-600/20"
                        >
                            Approve
                        </button>
                    </div>
                </div>
            </div>
        </Show>
    );
};
