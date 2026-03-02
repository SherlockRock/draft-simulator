import { createMemo, createSignal, For, Show } from "solid-js";
import { X, ChevronUp } from "lucide-solid";
import { SelectTheme, getThemeColors } from "../utils/selectTheme";
import { createDropdownKeyboard } from "../utils/useDropdownKeyboard";

type props = {
    placeholder?: string;
    currentlySelected: string;
    sortOptions: string[];
    selectText: string;
    setSelectText: (newValue: string) => void;
    onValidSelect?: (newValue: string) => void;
    theme?: SelectTheme;
};

export const SearchableSelect = (props: props) => {
    const [isFocused, setIsFocused] = createSignal(false);
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const colors = () => getThemeColors(props.theme ?? "teal");

    const openDropdown = () => {
        setDropdownOpen(true);
    };

    const closeDropdown = () => {
        setDropdownOpen(false);
    };

    const onFocusOut = () => {
        setIsFocused(false);
        closeDropdown();
    };

    const onFocusIn = () => {
        setIsFocused(true);
        openDropdown();
    };

    const handleSortOptions = (sortInput: string) => {
        if (sortInput === "" || sortInput === props.currentlySelected) {
            return props.sortOptions;
        }
        return props.sortOptions.filter((option) =>
            option.toLowerCase().includes(sortInput)
        );
    };

    const holdSortOptions = createMemo(() => {
        const hold = handleSortOptions(props.selectText);
        return hold;
    });

    const handleSelect = (index: number) => {
        const options = holdSortOptions();
        if (index >= 0 && index < options.length) {
            const option = options[index];
            props.setSelectText(option);
            closeDropdown();
            if (props.onValidSelect) {
                props.onValidSelect(option);
            }
        }
    };

    const keyboard = createDropdownKeyboard({
        getItemCount: () => holdSortOptions().length,
        onSelect: handleSelect,
        onClose: closeDropdown,
        isOpen: dropdownOpen
    });

    const handleKeyDown = (e: KeyboardEvent) => {
        if (!isFocused()) return;

        // Special case: Escape clears text if dropdown is already closed
        if (e.key === "Escape" && !dropdownOpen()) {
            props.setSelectText("");
            return;
        }

        const result = keyboard.handleKeyDown(e);
        if (result === "open") {
            e.preventDefault();
            openDropdown();
            keyboard.resetIndex(0);
        }
    };

    return (
        <div
            class="relative min-w-20 shrink"
            onKeyDown={handleKeyDown}
            onFocusIn={onFocusIn}
            onFocusOut={onFocusOut}
            tabIndex={0}
        >
            <div
                class={`flex h-10 items-center rounded-md border bg-slate-800 ${colors().border}`}
            >
                <input
                    value={props.selectText}
                    onInput={(e) => {
                        keyboard.resetIndex(0);
                        setDropdownOpen(true);
                        props.setSelectText(e.target.value);
                    }}
                    placeholder={props.placeholder}
                    name="select"
                    id="select"
                    class="w-full appearance-none bg-inherit px-4 text-slate-50 outline-none placeholder:text-slate-200"
                />
                <button
                    onClick={() => {
                        props.setSelectText("");
                    }}
                    class={`cursor-pointer text-slate-50 outline-none transition-all focus:outline-none ${colors().hoverText}`}
                >
                    <X size={16} class="mx-2" />
                </button>
                <label
                    for="show_more"
                    class={`cursor-pointer border-l border-slate-500 text-slate-50 outline-none transition-all focus:outline-none ${colors().hoverText}`}
                >
                    <button class="flex h-full justify-center">
                        <ChevronUp
                            size={16}
                            class={`mx-2 transform transition-transform ${
                                dropdownOpen() ? "rotate-180" : ""
                            }`}
                        />
                    </button>
                </label>
            </div>
            {dropdownOpen() && (
                <div
                    class={`custom-scrollbar absolute z-10 w-full flex-col overflow-y-auto rounded-md border border-t-0 ${colors().dropdownBorder}`}
                >
                    <div class="max-h-80">
                        <For each={holdSortOptions()}>
                            {(option, index) => (
                                <div
                                    ref={(el) => keyboard.setItemRef(index(), el)}
                                    class="group cursor-pointer"
                                    onMouseDown={() => handleSelect(index())}
                                    onMouseEnter={() =>
                                        keyboard.setHighlightedIndex(index())
                                    }
                                >
                                    <a
                                        class={`block border-l-4 p-2 transition-colors ${
                                            props.currentlySelected === option
                                                ? `${colors().activeBorder} bg-slate-700 ${colors().text}`
                                                : index() === keyboard.highlightedIndex()
                                                  ? `${colors().activeBorder} bg-slate-700 text-slate-50`
                                                  : `border-transparent bg-slate-900 text-slate-50 group-hover:bg-slate-700 ${colors().groupHoverText} ${colors().groupHoverBorder}`
                                        }`}
                                    >
                                        <p class="inline-block w-full overflow-hidden text-ellipsis whitespace-nowrap">
                                            {option}
                                        </p>
                                    </a>
                                </div>
                            )}
                        </For>
                        <Show when={holdSortOptions().length === 0}>
                            <a class="block border-l-4 border-transparent bg-slate-900 p-2 text-slate-500">
                                None
                            </a>
                        </Show>
                    </div>
                </div>
            )}
        </div>
    );
};
