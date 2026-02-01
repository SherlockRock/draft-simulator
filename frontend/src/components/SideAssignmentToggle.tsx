import { Component } from "solid-js";

interface SideAssignmentToggleProps {
    draftId: string;
    teamOneName: string;
    teamTwoName: string;
    blueSideTeam: 1 | 2;
    canEdit: boolean;
    onSetBlueSideTeam: (draftId: string, blueSideTeam: 1 | 2) => void;
}

const SideAssignmentToggle: Component<SideAssignmentToggleProps> = (props) => {
    const blueSideName = () =>
        props.blueSideTeam === 1
            ? props.teamOneName
            : props.teamTwoName;

    return (
        <div
            class="flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
        >
            <span class="text-[10px] font-medium text-blue-400">
                Blue:
            </span>
            <span class="text-[10px] text-slate-300">
                {blueSideName()}
            </span>
            <button
                disabled={!props.canEdit}
                onClick={() =>
                    props.onSetBlueSideTeam(
                        props.draftId,
                        props.blueSideTeam === 1 ? 2 : 1
                    )
                }
                class={`ml-1 rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-400 transition-colors ${
                    props.canEdit
                        ? "cursor-pointer hover:border-slate-500 hover:bg-slate-700 hover:text-slate-300"
                        : "cursor-default opacity-60"
                }`}
                title="Swap sides"
            >
                ⇄
            </button>
        </div>
    );
};

export { SideAssignmentToggle };
