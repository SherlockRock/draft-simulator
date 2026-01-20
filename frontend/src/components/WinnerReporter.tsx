import { Component, Show, createSignal, JSX } from "solid-js";

interface WinnerReporterProps {
    draftId: string;
    blueTeamName: string;
    redTeamName: string;
    currentWinner: "blue" | "red" | null | undefined;
    canEdit: boolean;
    onReportWinner: (winner: "blue" | "red") => void;
}

export const WinnerReporter: Component<WinnerReporterProps> = (props) => {
    const [isChanging, setIsChanging] = createSignal(false);

    const handleSelect = (e: MouseEvent, winner: "blue" | "red") => {
        e.stopPropagation();
        e.preventDefault();
        props.onReportWinner(winner);
        setIsChanging(false);
    };

    const handleChangeClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (e) => {
        e.stopPropagation();
        e.preventDefault();
        setIsChanging(true);
    };

    const handleContainerClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = (e) => {
        e.stopPropagation();
    };

    const showButtons = () => !props.currentWinner || isChanging();

    return (
        <div onClick={handleContainerClick} class="inline-flex items-center">
            <Show
                when={showButtons() && props.canEdit}
                fallback={
                    <Show when={props.currentWinner}>
                        <div class="flex items-center gap-1.5">
                            {/* Winner indicator pill */}
                            <div
                                class={`flex items-center gap-1.5 rounded-full py-0.5 pl-1.5 pr-2 text-xs font-medium ${
                                    props.currentWinner === "blue"
                                        ? "bg-blue-500/20 text-blue-300"
                                        : "bg-red-500/20 text-red-300"
                                }`}
                            >
                                <span
                                    class={`h-1.5 w-1.5 rounded-full ${
                                        props.currentWinner === "blue"
                                            ? "bg-blue-400"
                                            : "bg-red-400"
                                    }`}
                                />
                                <span>
                                    {props.currentWinner === "blue"
                                        ? props.blueTeamName
                                        : props.redTeamName}
                                </span>
                            </div>
                            <Show when={props.canEdit}>
                                <button
                                    onClick={handleChangeClick}
                                    class="rounded px-1.5 py-0.5 text-[10px] font-medium text-slate-500 transition-colors hover:bg-slate-700 hover:text-slate-300"
                                >
                                    edit
                                </button>
                            </Show>
                        </div>
                    </Show>
                }
            >
                {/* Segmented toggle control */}
                <div class="flex items-center overflow-hidden rounded-lg border border-slate-600/50 bg-slate-900/80">
                    <button
                        onClick={(e) => handleSelect(e, "blue")}
                        class="group/btn flex items-center gap-1.5 border-r border-slate-600/50 px-2.5 py-1 text-xs font-medium text-blue-400 transition-all hover:bg-blue-500/20"
                    >
                        <span class="h-1.5 w-1.5 rounded-full bg-blue-500 opacity-60 transition-opacity group-hover/btn:opacity-100" />
                        <span class="max-w-[60px] truncate">
                            {props.blueTeamName}
                        </span>
                    </button>
                    <button
                        onClick={(e) => handleSelect(e, "red")}
                        class="group/btn flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-red-400 transition-all hover:bg-red-500/20"
                    >
                        <span class="max-w-[60px] truncate">{props.redTeamName}</span>
                        <span class="h-1.5 w-1.5 rounded-full bg-red-500 opacity-60 transition-opacity group-hover/btn:opacity-100" />
                    </button>
                </div>
            </Show>
        </div>
    );
};
