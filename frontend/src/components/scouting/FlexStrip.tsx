import { Component, Show, createMemo } from "solid-js";
import type { AssignedPlayer, FlexChampPlayer } from "../../utils/playerStats";
import { computeFlexChamps } from "../../utils/playerStats";
import { ChampChipStrip, type ChipDetail } from "./ChampChipStrip";

interface FlexStripProps {
    label: string;
    accentClass: string;
    team: (AssignedPlayer | null)[];
    onChipClick: (players: FlexChampPlayer[], championId: string) => void;
}

// The within-team axis: champs played by 2+ teammates. Same chip grammar as
// the divider strips — hover = who/how, click = scroll to their rows.
export const FlexStrip: Component<FlexStripProps> = (props) => {
    const flex = createMemo(() => computeFlexChamps(props.team));
    const chips = createMemo<ChipDetail[]>(() =>
        flex().map((champ) => ({ kind: "flex", champ }))
    );
    return (
        <Show when={chips().length > 0}>
            <div class="flex items-center gap-3 rounded-lg border border-slate-700/50 bg-slate-800/95 px-3 py-1.5">
                <span
                    class={`shrink-0 text-[10px] font-semibold uppercase tracking-wide ${props.accentClass}`}
                >
                    {props.label} flex
                </span>
                <ChampChipStrip
                    chips={chips()}
                    onChipClick={(championId) => {
                        const champ = flex().find((f) => f.championId === championId);
                        if (champ) props.onChipClick(champ.players, championId);
                    }}
                />
            </div>
        </Show>
    );
};
