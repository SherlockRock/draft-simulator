import { Component } from "solid-js";

interface FirstPickToggleProps {
    draftId: string;
    blueTeamName: string;
    redTeamName: string;
    currentFirstPick: "blue" | "red";
    canEdit: boolean;
    onSetFirstPick: (draftId: string, firstPick: "blue" | "red") => void;
}

const FirstPickToggle: Component<FirstPickToggleProps> = (props) => {
    return (
        <div
            class="flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
        >
            <span class="mr-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                1st Pick
            </span>
            <button
                disabled={!props.canEdit}
                onClick={() =>
                    props.onSetFirstPick(props.draftId, "blue")
                }
                class={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                    props.currentFirstPick === "blue"
                        ? "bg-blue-500/30 text-blue-300"
                        : "text-blue-400/60 hover:bg-blue-500/10 hover:text-blue-400"
                } ${!props.canEdit ? "cursor-default opacity-60" : "cursor-pointer"}`}
            >
                {props.blueTeamName}
            </button>
            <span class="text-slate-600">|</span>
            <button
                disabled={!props.canEdit}
                onClick={() =>
                    props.onSetFirstPick(props.draftId, "red")
                }
                class={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                    props.currentFirstPick === "red"
                        ? "bg-red-500/30 text-red-300"
                        : "text-red-400/60 hover:bg-red-500/10 hover:text-red-400"
                } ${!props.canEdit ? "cursor-default opacity-60" : "cursor-pointer"}`}
            >
                {props.redTeamName}
            </button>
        </div>
    );
};

export { FirstPickToggle };
