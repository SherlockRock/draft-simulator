import { Accessor, Component, JSX, Show } from "solid-js";
import { X } from "lucide-solid";

interface FilterBarProps {
    searchText: Accessor<string>;
    onSearchChange: (value: string) => void;
    searchPlaceholder?: string;
    children?: JSX.Element;
}

export const FilterBar: Component<FilterBarProps> = (props) => {
    return (
        <div class="flex rounded-md bg-slate-800">
            <input
                type="text"
                value={props.searchText()}
                onInput={(e) => props.onSearchChange(e.currentTarget.value)}
                placeholder={props.searchPlaceholder || "Search..."}
                class="w-full bg-inherit p-2 text-slate-50 placeholder:text-slate-400 focus:outline-none"
            />
            <Show when={props.searchText() !== ""}>
                <button
                    type="button"
                    onClick={() => props.onSearchChange("")}
                    class="flex items-center px-2 text-slate-400 transition-colors hover:text-slate-200"
                    title="Clear search"
                >
                    <X size={14} />
                </button>
            </Show>
            {props.children}
        </div>
    );
};
