import { Accessor, Component } from "solid-js";
import { SearchableSelect } from "./SearchableSelect";
import { SelectTheme } from "../utils/selectTheme";

interface FilterBarProps {
    searchText: Accessor<string>;
    onSearchChange: (value: string) => void;
    selectedCategory: Accessor<string>;
    onCategoryChange: (value: string) => void;
    categories: string[];
    searchPlaceholder?: string;
    categoryPlaceholder?: string;
    theme?: SelectTheme;
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
            <SearchableSelect
                placeholder={props.categoryPlaceholder || "Filter"}
                currentlySelected={props.selectedCategory()}
                sortOptions={props.categories}
                selectText={props.selectedCategory()}
                setSelectText={props.onCategoryChange}
                onValidSelect={props.onCategoryChange}
                theme={props.theme}
            />
        </div>
    );
};
