import { Component, JSX } from "solid-js";

interface WinnerReporterProps {
    draftId: string;
    blueTeamName: string;
    redTeamName: string;
    currentWinner: "blue" | "red" | null | undefined;
    canEdit: boolean;
    onReportWinner: (winner: "blue" | "red") => void;
}

export const WinnerReporter: Component<WinnerReporterProps> = (props) => {
    const handleSelect = (e: MouseEvent, winner: "blue" | "red") => {
        e.stopPropagation();
        e.preventDefault();
        if (props.canEdit) {
            props.onReportWinner(winner);
        }
    };

    const handleContainerClick: JSX.EventHandler<HTMLDivElement, MouseEvent> = (e) => {
        e.stopPropagation();
    };

    const blueSelected = () => props.currentWinner === "blue";
    const redSelected = () => props.currentWinner === "red";

    return (
        <div onClick={handleContainerClick} class="inline-flex items-center">
            <div class="flex items-center overflow-hidden rounded-lg border border-slate-600/50 bg-slate-900/80">
                <button
                    onClick={(e) => handleSelect(e, "blue")}
                    disabled={!props.canEdit}
                    class={`group/btn flex items-center gap-1.5 border-r border-slate-600/50 px-2.5 py-1 text-xs font-medium transition-all ${
                        blueSelected()
                            ? "bg-blue-500/30 text-blue-300"
                            : props.canEdit
                              ? "text-blue-400/60 hover:bg-blue-500/20 hover:text-blue-400"
                              : "text-blue-400/40"
                    } ${props.canEdit ? "cursor-pointer" : "cursor-default"}`}
                >
                    <span
                        class={`h-1.5 w-1.5 rounded-full transition-opacity ${
                            blueSelected()
                                ? "bg-blue-400"
                                : "bg-blue-500 opacity-40 group-hover/btn:opacity-70"
                        }`}
                    />
                    <span class="max-w-[60px] truncate">{props.blueTeamName}</span>
                </button>
                <button
                    onClick={(e) => handleSelect(e, "red")}
                    disabled={!props.canEdit}
                    class={`group/btn flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition-all ${
                        redSelected()
                            ? "bg-red-500/30 text-red-300"
                            : props.canEdit
                              ? "text-red-400/60 hover:bg-red-500/20 hover:text-red-400"
                              : "text-red-400/40"
                    } ${props.canEdit ? "cursor-pointer" : "cursor-default"}`}
                >
                    <span class="max-w-[60px] truncate">{props.redTeamName}</span>
                    <span
                        class={`h-1.5 w-1.5 rounded-full transition-opacity ${
                            redSelected()
                                ? "bg-red-400"
                                : "bg-red-500 opacity-40 group-hover/btn:opacity-70"
                        }`}
                    />
                </button>
            </div>
        </div>
    );
};
