import { Component, For, Show, createMemo } from "solid-js";
import { ChevronDown, ChevronRight } from "lucide-solid";
import type { Role } from "@draft-sim/shared-types";
import { ROLE_LABELS } from "../utils/championRoles";
import { getDefaultRolePool } from "../utils/defaultRolePools";
import { poolRoleGridEntries } from "../utils/poolCard";

interface PoolRoleAccordionProps {
    role: Role;
    isOpen: boolean;
    onToggleOpen: () => void;
    selectedChampionIds: () => string[];
    onSelectionChange: (nextIds: string[]) => void;
}

// Neutral accent, hardcoded literal strings — Tailwind's content scan only
// keeps class names that appear verbatim in source, so these can never be
// built from a concatenated/interpolated string.
const SELECTED_CLASS = "border-darius-purple-bright bg-darius-purple-bright/10";
const IDLE_CLASS = "border-slate-700 hover:border-darius-purple-bright";

/**
 * Pool-owned copy of `navigator/RolePoolAccordion` — deliberately NOT
 * reused. The navigator original filters its grid to `championsInRole(role)`
 * alone, so an off-meta champion added through the card's "+" picker (which
 * has no such filter) would be selected (counted in the bucket) but invisible
 * in this grid — and its `clearAll` would silently drop it without the user
 * ever seeing it in the panel. That invisible-but-counted shape is exactly
 * the bug this component exists to avoid, so the grid instead renders the
 * UNION of the meta-role catalog and whatever the bucket already holds.
 *
 * Accepted asymmetry: off-meta ADDS still only happen through the card's "+"
 * picker, not through this grid — this component only guarantees existing
 * off-meta entries stay visible and clearable, it does not offer a way to
 * add a new one.
 */
export const PoolRoleAccordion: Component<PoolRoleAccordionProps> = (props) => {
    // See `poolRoleGridEntries`'s doc (utils/poolCard.ts) and this
    // component's doc above for why the union, not `championsInRole` alone.
    const roleChampions = createMemo(() =>
        poolRoleGridEntries(props.role, props.selectedChampionIds())
    );

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
                    {/* Cap the panel and scroll it internally: an uncapped grid is
                        ~1000px tall, so opening one role threw every role below it
                        off-screen. Bounded, the other role headers stay reachable. */}
                    <div class="custom-scrollbar grid max-h-80 grid-cols-6 gap-1.5 overflow-y-auto">
                        <For each={roleChampions()}>
                            {(champ) => (
                                <button
                                    type="button"
                                    onClick={() => toggleChampion(champ.id)}
                                    title={champ.name}
                                    class={`relative aspect-square overflow-hidden rounded border-2 transition-all ${
                                        isSelected(champ.id) ? SELECTED_CLASS : IDLE_CLASS
                                    }`}
                                >
                                    <Show
                                        when={champ.img}
                                        fallback={
                                            <div class="flex h-full w-full items-center justify-center bg-slate-800 px-0.5 text-center text-[9px] text-slate-400">
                                                {champ.name}
                                            </div>
                                        }
                                    >
                                        {(img) => (
                                            <img
                                                src={img()}
                                                alt={champ.name}
                                                draggable={false}
                                                class="h-full w-full object-cover"
                                            />
                                        )}
                                    </Show>
                                </button>
                            )}
                        </For>
                    </div>
                </div>
            </Show>
        </div>
    );
};
