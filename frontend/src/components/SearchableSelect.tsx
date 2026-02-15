import { createMemo, createSignal, For, Show } from "solid-js";
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
            class="relative w-48 shrink-0"
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
                    <svg
                        class="mx-2 h-4 w-4 fill-current"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
                <label
                    for="show_more"
                    class={`cursor-pointer border-l border-slate-500 text-slate-50 outline-none transition-all focus:outline-none ${colors().hoverText}`}
                >
                    <button class="flex h-full justify-center">
                        <svg
                            class={`mx-2 h-4 w-4 transform fill-current transition-transform ${
                                dropdownOpen() ? "rotate-180" : ""
                            }`}
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <polyline points="18 15 12 9 6 15" />
                        </svg>
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
                                                ? "border-green-600 bg-gray-950 text-green-600"
                                                : index() === keyboard.highlightedIndex()
                                                  ? `${colors().activeBorder} bg-gray-800 text-white`
                                                  : `border-white bg-gray-950 text-white group-hover:bg-gray-800 ${colors().groupHoverText} ${colors().groupHoverBorder}`
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
                            <a class="block border-l-4 bg-gray-950 p-2 text-gray-500">
                                None
                            </a>
                        </Show>
                    </div>
                </div>
            )}
        </div>
    );
};
