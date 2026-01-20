import { Component, Show, createSignal } from "solid-js";

interface WinnerReporterProps {
    draftId: string;
    blueTeamName: string;
    redTeamName: string;
    currentWinner: "blue" | "red" | null | undefined;
    canEdit: boolean;
    onReportWinner: (winner: "blue" | "red") => void;
    compact?: boolean;
}

export const WinnerReporter: Component<WinnerReporterProps> = (props) => {
    const [isChanging, setIsChanging] = createSignal(false);

    const handleSelect = (winner: "blue" | "red") => {
        props.onReportWinner(winner);
        setIsChanging(false);
    };

    const showButtons = () => !props.currentWinner || isChanging();

    return (
        <div class={props.compact ? "" : "space-y-2"}>
            <Show
                when={showButtons() && props.canEdit}
                fallback={
                    <Show when={props.currentWinner}>
                        <div
                            class={`flex items-center gap-2 ${props.compact ? "text-sm" : ""}`}
                        >
                            <span class="text-slate-400">Winner:</span>
                            <span
                                class={`font-medium ${
                                    props.currentWinner === "blue"
                                        ? "text-blue-400"
                                        : "text-red-400"
                                }`}
                            >
                                {props.currentWinner === "blue"
                                    ? props.blueTeamName
                                    : props.redTeamName}
                            </span>
                            <Show when={props.canEdit}>
                                <button
                                    onClick={() => setIsChanging(true)}
                                    class="text-xs text-slate-400 hover:text-slate-300"
                                >
                                    Change
                                </button>
                            </Show>
                        </div>
                    </Show>
                }
            >
                <div
                    class={`flex gap-2 ${props.compact ? "flex-row" : "flex-col"}`}
                >
                    <button
                        onClick={() => handleSelect("blue")}
                        class={`rounded-lg border-2 border-blue-600/50 bg-blue-600/10 font-semibold text-blue-400 transition-all hover:border-blue-500 hover:bg-blue-600/20 ${
                            props.compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"
                        }`}
                    >
                        {props.blueTeamName} Won
                    </button>
                    <button
                        onClick={() => handleSelect("red")}
                        class={`rounded-lg border-2 border-red-600/50 bg-red-600/10 font-semibold text-red-400 transition-all hover:border-red-500 hover:bg-red-600/20 ${
                            props.compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"
                        }`}
                    >
                        {props.redTeamName} Won
                    </button>
                </div>
            </Show>
        </div>
    );
};
