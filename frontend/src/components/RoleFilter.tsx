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
    neutral: "ring-darius-border",
    orange: "ring-darius-ember/60",
    crimson: "ring-darius-crimson/60",
    purple: "ring-darius-purple-bright/60"
};

const activeText: Record<SelectTheme, string> = {
    neutral: "text-darius-text-primary",
    orange: "text-darius-ember",
    crimson: "text-darius-crimson",
    purple: "text-darius-purple-bright"
};

export const RoleFilter: Component<RoleFilterProps> = (props) => {
    const theme = () => props.theme ?? "orange";
    const hasSelection = () => props.selectedCategories().size > 0;

    return (
        <div class="mt-2 flex items-center gap-1.5">
            <span class="text-[9px] font-semibold uppercase tracking-widest text-darius-text-secondary">
                Role
            </span>
            <div class="flex flex-1 justify-end gap-1">
                <button
                    type="button"
                    onClick={() => props.onClearAll()}
                    title="Show all roles"
                    class={`flex h-7 items-center justify-center rounded px-3 text-[10px] font-semibold transition-all ${
                        !hasSelection()
                            ? `bg-darius-border ${activeText[theme()]}`
                            : "bg-darius-card-hover text-darius-text-secondary opacity-40 hover:opacity-70"
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
                                        ? `ring-2 ${activeRing[theme()]} bg-darius-border`
                                        : "bg-darius-card-hover opacity-40 hover:opacity-70"
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
