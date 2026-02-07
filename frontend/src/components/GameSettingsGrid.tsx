import { Component, createMemo } from "solid-js";

interface GameSettingsGridProps {
    draftId: string;
    teamOneName: string;
    teamTwoName: string;
    blueSideTeam: 1 | 2;
    firstPick: "blue" | "red";
    canEdit: boolean;
    onSettingsChange: (
        draftId: string,
        settings: { firstPick?: "blue" | "red"; blueSideTeam?: 1 | 2 }
    ) => void;
}

const GameSettingsGrid: Component<GameSettingsGridProps> = (props) => {
    // Which team is currently on blue side
    const blueSideIsTeamOne = createMemo(() => props.blueSideTeam === 1);

    // Which team currently has first pick
    // firstPick is "blue"/"red" (side), so map through blueSideTeam to get team
    const firstPickIsTeamOne = createMemo(() => {
        if (props.blueSideTeam === 1) {
            return props.firstPick === "blue";
        }
        return props.firstPick === "red";
    });

    const handleBlueSide = (teamOne: boolean) => {
        if (!props.canEdit) return;
        const newBst: 1 | 2 = teamOne ? 1 : 2;
        if (newBst === props.blueSideTeam) return;

        // Flip firstPick to keep it pinned to the same team.
        // The model stores first pick as a side ("blue"/"red"), so swapping
        // which team is on blue means the firstPick value must also flip.
        // Both are sent atomically to avoid race conditions from two separate socket events.
        const newFirstPick: "blue" | "red" = props.firstPick === "blue" ? "red" : "blue";
        props.onSettingsChange(props.draftId, {
            blueSideTeam: newBst,
            firstPick: newFirstPick
        });
    };

    const handleFirstPick = (teamOne: boolean) => {
        if (!props.canEdit) return;
        // Map team selection back to "blue"/"red" side
        const newFirstPick: "blue" | "red" =
            props.blueSideTeam === 1
                ? teamOne
                    ? "blue"
                    : "red"
                : teamOne
                  ? "red"
                  : "blue";
        props.onSettingsChange(props.draftId, { firstPick: newFirstPick });
    };

    const cellClass = (selected: boolean) =>
        `flex items-center justify-center py-1.5 transition-colors ${
            props.canEdit ? "cursor-pointer" : "cursor-default"
        } ${
            selected
                ? "bg-orange-500/[0.08]"
                : props.canEdit
                  ? "hover:bg-slate-600/30"
                  : ""
        }`;

    const dotClass = (selected: boolean) =>
        `h-2 w-2 rounded-full transition-all ${
            selected
                ? "border-[1.5px] border-orange-400 bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.4)]"
                : "border-[1.5px] border-slate-500"
        }`;

    return (
        <div
            class="grid overflow-hidden rounded-lg"
            style={{
                "grid-template-columns": "auto 1fr 1fr",
                gap: "2px",
                background: "rgba(51, 65, 85, 0.3)"
            }}
            onClick={(e) => e.stopPropagation()}
        >
            {/* Header row */}
            <div class="bg-slate-800/60 px-3 py-1.5" />
            <div
                class={`bg-slate-800/60 px-3 py-1.5 text-center text-[11px] font-semibold ${blueSideIsTeamOne() ? "text-blue-400" : "text-red-400"}`}
            >
                {props.teamOneName}
            </div>
            <div
                class={`bg-slate-800/60 px-3 py-1.5 text-center text-[11px] font-semibold ${blueSideIsTeamOne() ? "text-red-400" : "text-blue-400"}`}
            >
                {props.teamTwoName}
            </div>

            {/* Blue Side row */}
            <div class="flex items-center bg-slate-800/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Blue Side
            </div>
            <div
                class={cellClass(blueSideIsTeamOne())}
                style={{
                    background: blueSideIsTeamOne()
                        ? "rgba(251, 146, 60, 0.08)"
                        : "rgba(30, 41, 59, 0.6)"
                }}
                onClick={() => handleBlueSide(true)}
            >
                <div class={dotClass(blueSideIsTeamOne())} />
            </div>
            <div
                class={cellClass(!blueSideIsTeamOne())}
                style={{
                    background: !blueSideIsTeamOne()
                        ? "rgba(251, 146, 60, 0.08)"
                        : "rgba(30, 41, 59, 0.6)"
                }}
                onClick={() => handleBlueSide(false)}
            >
                <div class={dotClass(!blueSideIsTeamOne())} />
            </div>

            {/* 1st Pick row */}
            <div class="flex items-center bg-slate-800/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                1st Pick
            </div>
            <div
                class={cellClass(firstPickIsTeamOne())}
                style={{
                    background: firstPickIsTeamOne()
                        ? "rgba(251, 146, 60, 0.08)"
                        : "rgba(30, 41, 59, 0.6)"
                }}
                onClick={() => handleFirstPick(true)}
            >
                <div class={dotClass(firstPickIsTeamOne())} />
            </div>
            <div
                class={cellClass(!firstPickIsTeamOne())}
                style={{
                    background: !firstPickIsTeamOne()
                        ? "rgba(251, 146, 60, 0.08)"
                        : "rgba(30, 41, 59, 0.6)"
                }}
                onClick={() => handleFirstPick(false)}
            >
                <div class={dotClass(!firstPickIsTeamOne())} />
            </div>
        </div>
    );
};

export { GameSettingsGrid };
