import { Component, For, Show, createMemo } from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import type { Role } from "@draft-sim/shared-types";
import { champions } from "../../utils/constants";
import { ROLE_LABELS, championsInRole } from "../../utils/championRoles";
import { getDefaultRolePool } from "../../utils/defaultRolePools";

interface RolePoolAccordionProps {
    role: Role;
    teamColor: "blue" | "red";
    isOpen: boolean;
    onToggleOpen: () => void;
    selectedChampionIds: () => string[];
    onSelectionChange: (nextIds: string[]) => void;
}

const TEAM_ACCENT: Record<"blue" | "red", string> = {
    blue: "border-blue-500 bg-blue-500/10 text-blue-100",
    red: "border-red-500 bg-red-500/10 text-red-100"
};

const TEAM_BORDER: Record<"blue" | "red", string> = {
    blue: "border-blue-500",
    red: "border-red-500"
};

export const RolePoolAccordion: Component<RolePoolAccordionProps> = (props) => {
    const roleChampions = createMemo(() => {
        const inRole = new Set(championsInRole(props.role));
        return champions.filter((c) => inRole.has(c.id));
    });

    const isSelected = (championId: string) =>
        props.selectedChampionIds().includes(championId);

    const toggleChampion = (championId: string) => {
        const current = props.selectedChampionIds();
        if (current.includes(championId)) {
            props.onSelectionChange(current.filter((id) => id !== championId));
        } else {
            props.onSelectionChange([...current, championId]);
        }
    };

    const loadDefault = () => {
        props.onSelectionChange(getDefaultRolePool(props.role));
    };

    const clearAll = () => {
        props.onSelectionChange([]);
    };

    return (
        <div class="rounded-lg border border-slate-700 bg-slate-900/40">
            <button
                type="button"
                onClick={props.onToggleOpen}
                class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-900/60"
            >
                <div class="flex items-center gap-3">
                    <Show when={props.isOpen} fallback={<ChevronRight size={16} />}>
                        <ChevronDown size={16} />
                    </Show>
                    <span class="text-sm font-semibold text-slate-100">
                        {ROLE_LABELS[props.role]}
                    </span>
                    <span class="rounded-full border border-slate-600 bg-slate-900 px-2 py-0.5 text-xs text-slate-300">
                        {props.selectedChampionIds().length} selected
                    </span>
                </div>
            </button>
            <Show when={props.isOpen}>
                <div class="border-t border-slate-700 px-4 py-3">
                    <div class="mb-3 flex gap-3 text-xs">
                        <button
                            type="button"
                            onClick={loadDefault}
                            class="text-slate-400 underline hover:text-slate-200"
                        >
                            Load default
                        </button>
                        <button
                            type="button"
                            onClick={clearAll}
                            class="text-slate-400 underline hover:text-slate-200"
                        >
                            Clear
                        </button>
                    </div>
                    <div class="grid grid-cols-6 gap-1.5">
                        <For each={roleChampions()}>
                            {(champ) => (
                                <button
                                    type="button"
                                    onClick={() => toggleChampion(champ.id)}
                                    title={champ.name}
                                    class={`relative aspect-square overflow-hidden rounded border-2 transition-all ${
                                        isSelected(champ.id)
                                            ? TEAM_ACCENT[props.teamColor]
                                            : "border-slate-700 hover:" + TEAM_BORDER[props.teamColor]
                                    }`}
                                >
                                    <img
                                        src={champ.img}
                                        alt={champ.name}
                                        draggable={false}
                                        class="h-full w-full object-cover"
                                    />
                                </button>
                            )}
                        </For>
                    </div>
                </div>
            </Show>
        </div>
    );
};
