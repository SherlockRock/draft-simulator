import { Accessor, Component, For } from "solid-js";
import { SelectTheme } from "../utils/selectTheme";

interface RoleFilterProps {
    categories: string[];
    selectedCategories: Accessor<Set<string>>;
    onToggle: (category: string) => void;
    onClearAll: () => void;
    theme?: SelectTheme;
}

const CDN_BASE =
    "https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/svg";

const roleIconSlug: Record<string, string> = {
    Top: "position-top",
    Jungle: "position-jungle",
    Mid: "position-middle",
    Bot: "position-bottom",
    Support: "position-utility"
};

const activeRing: Record<SelectTheme, string> = {
    orange: "ring-orange-500/60",
    purple: "ring-purple-500/60",
    teal: "ring-teal-500/60"
};

const activeText: Record<SelectTheme, string> = {
    orange: "text-orange-400",
    purple: "text-purple-400",
    teal: "text-teal-400"
};

export const RoleFilter: Component<RoleFilterProps> = (props) => {
    const theme = () => props.theme ?? "teal";
    const hasSelection = () => props.selectedCategories().size > 0;

    return (
        <div class="mt-2 flex items-center gap-1.5">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-slate-500">
                Role
            </span>
            <div class="flex flex-1 justify-end gap-1">
                <button
                    type="button"
                    onClick={() => props.onClearAll()}
                    title="Show all roles"
                    class={`flex h-7 items-center justify-center rounded px-3 text-[10px] font-semibold transition-all ${
                        !hasSelection()
                            ? `bg-slate-600 ${activeText[theme()]}`
                            : "bg-slate-700 text-slate-400 opacity-40 hover:opacity-70"
                    }`}
                >
                    All
                </button>
                <For each={props.categories}>
                    {(category) => {
                        const isActive = () => props.selectedCategories().has(category);
                        const slug = roleIconSlug[category];

                        return (
                            <button
                                type="button"
                                onClick={() => props.onToggle(category)}
                                title={category}
                                class={`flex h-7 w-7 items-center justify-center rounded transition-all ${
                                    isActive()
                                        ? `ring-2 ${activeRing[theme()]} bg-slate-600`
                                        : "bg-slate-700 opacity-40 hover:opacity-70"
                                }`}
                            >
                                <img
                                    src={`${CDN_BASE}/${slug}.svg`}
                                    alt={category}
                                    class="h-[18px] w-[18px]"
                                />
                            </button>
                        );
                    }}
                </For>
            </div>
        </div>
    );
};
