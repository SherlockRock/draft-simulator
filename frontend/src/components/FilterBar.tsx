import { Accessor, Component, JSX } from "solid-js";
import { X } from "lucide-solid";

const accentStyles = {
    orange: {
        active: "border-orange-500",
        idle: "border-transparent focus-within:border-orange-400"
    },
    purple: {
        active: "border-purple-500",
        idle: "border-transparent focus-within:border-purple-400"
    },
    teal: {
        active: "border-teal-500",
        idle: "border-transparent focus-within:border-teal-400"
    }
} as const;

interface FilterBarProps {
    searchText: Accessor<string>;
    onSearchChange: (value: string) => void;
    searchPlaceholder?: string;
    children?: JSX.Element;
    inputRef?: (el: HTMLInputElement) => void;
    accent?: keyof typeof accentStyles;
}

export const FilterBar: Component<FilterBarProps> = (props) => {
    const accent = () => (props.accent ? accentStyles[props.accent] : null);

    return (
        <div
            class={`flex w-full min-w-0 overflow-hidden bg-inherit transition-all duration-200 ${
                accent()
                    ? `rounded-b-sm rounded-t-md border-b-2 ${props.searchText() !== "" ? accent()!.active : accent()!.idle}`
                    : "rounded-md"
            }`}
        >
            <input
                ref={props.inputRef}
                type="text"
                value={props.searchText()}
                onInput={(e) => props.onSearchChange(e.currentTarget.value)}
                placeholder={props.searchPlaceholder || "Search..."}
                class="min-w-0 flex-1 bg-inherit p-2 text-slate-50 placeholder:text-slate-400 focus:outline-none"
            />
            <button
                type="button"
                onClick={() => props.onSearchChange("")}
                class={`flex items-center px-2 transition-colors ${
                    props.searchText() !== ""
                        ? "text-slate-400 hover:text-slate-200"
                        : "pointer-events-none invisible"
                }`}
                title="Clear search"
            >
                <X size={14} />
            </button>
            {props.children}
        </div>
    );
};
