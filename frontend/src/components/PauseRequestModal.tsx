import { Component, Show } from "solid-js";
import { X } from "lucide-solid";
import { getSideTeamName } from "../utils/versusPermissions";

interface PauseRequestModalProps {
    isOpen: boolean;
    requestType: "pause" | "resume";
    requestingTeam: "blue" | "red";
    blueSideTeam: number;
    blueTeamName: string;
    redTeamName: string;
    onApprove: () => void;
    onReject: () => void;
    onClose?: () => void;
}

export const PauseRequestModal: Component<PauseRequestModalProps> = (props) => {
    const getTeamName = () => {
        return getSideTeamName(
            props.requestingTeam,
            props.blueSideTeam,
            props.blueTeamName,
            props.redTeamName
        );
    };

    const getTeamColor = () => {
        return props.requestingTeam === "blue"
            ? "text-darius-crimson"
            : "text-darius-ember";
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
                <div class="relative w-full max-w-md rounded-lg border border-darius-border bg-darius-card p-8 pt-10">
                    <Show when={props.onClose}>
                        <button
                            type="button"
                            onClick={() => props.onClose?.()}
                            class="absolute right-4 top-4 text-darius-text-primary text-darius-text-secondary transition-colors"
                            aria-label="Close dialog"
                        >
                            <X size={20} />
                        </button>
                    </Show>
                    <div class="mb-6 text-center">
                        <div class="mb-4 text-6xl">{getIcon()}</div>
                        <h2 class="mb-2 text-2xl font-bold text-darius-text-primary">
                            {getTitle()}
                        </h2>
                        <p class="text-darius-text-secondary">
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
                            class="flex-1 rounded-lg border-2 border-darius-crimson/50 bg-darius-crimson/10 px-4 py-3 font-semibold text-darius-crimson transition-all hover:border-darius-crimson hover:bg-darius-crimson/20"
                        >
                            Approve
                        </button>
                    </div>
                </div>
            </div>
        </Show>
    );
};
