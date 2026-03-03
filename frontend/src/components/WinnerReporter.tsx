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
    const noneSelected = () => !props.currentWinner;

    return (
        <div onClick={handleContainerClick}>
            <div class="flex items-center gap-1.5">
                {/* Blue team button */}
                <button
                    onClick={(e) => handleSelect(e, "blue")}
                    disabled={!props.canEdit}
                    class={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                        blueSelected()
                            ? "bg-blue-500/25 text-blue-300 ring-1 ring-blue-500/40"
                            : noneSelected() && props.canEdit
                              ? "bg-slate-700/40 text-slate-400 hover:bg-blue-500/15 hover:text-blue-400"
                              : "bg-slate-700/30 text-slate-500"
                    } ${props.canEdit ? "cursor-pointer" : "cursor-default"}`}
                >
                    <span
                        class={`h-2 w-2 rounded-full transition-all ${
                            blueSelected()
                                ? "bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.5)]"
                                : "border border-slate-500"
                        }`}
                    />
                    <span class="truncate">{props.blueTeamName}</span>
                </button>

                {/* Red team button */}
                <button
                    onClick={(e) => handleSelect(e, "red")}
                    disabled={!props.canEdit}
                    class={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                        redSelected()
                            ? "bg-red-500/25 text-red-300 ring-1 ring-red-500/40"
                            : noneSelected() && props.canEdit
                              ? "bg-slate-700/40 text-slate-400 hover:bg-red-500/15 hover:text-red-400"
                              : "bg-slate-700/30 text-slate-500"
                    } ${props.canEdit ? "cursor-pointer" : "cursor-default"}`}
                >
                    <span class="truncate">{props.redTeamName}</span>
                    <span
                        class={`h-2 w-2 rounded-full transition-all ${
                            redSelected()
                                ? "bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.5)]"
                                : "border border-slate-500"
                        }`}
                    />
                </button>
            </div>
        </div>
    );
};
