import { createMemo, createSignal, For, Setter, Show } from "solid-js";
import KeyEvent, { Key } from "../KeyEvent";
import { sortOptions } from "../utils/constants";

type props = {
    placeholder?: string;
    currentlySelected: string;
    sortOptions: string[];
    selectText: string;
    setSelectText: Setter<string>;
    onValidSelect?: (newValue: string) => void;
};

export const SearchableSelect = (props: props) => {
    const [isFocused, setIsFocused] = createSignal(false);
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [dropdownIndex, setDropdownIndex] = createSignal(-1);

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

    const handleKeyEvent = (key: Key) => {
        if (!isFocused()) return;
        switch (key) {
            case "Enter":
                if (dropdownOpen() && dropdownIndex() >= 0) {
                    const hold = holdSortOptions();
                    props.setSelectText(hold[dropdownIndex() % hold.length]);
                    setDropdownOpen(false);
                    if (props.onValidSelect) {
                        props.onValidSelect(hold[dropdownIndex() % hold.length]);
                    }
                }
                break;
            case "ArrowUp":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === 0) {
                            return sortOptions.length - 1;
                        }
                        return prevIndex - 1;
                    });
                }
                break;
            case "ArrowDown":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === sortOptions.length - 1) {
                            return 0;
                        }
                        return prevIndex + 1;
                    });
                } else {
                    setDropdownOpen(true);
                }
                break;
            case "Escape":
                if (dropdownOpen()) {
                    setDropdownOpen(false);
                } else {
                    props.setSelectText("");
                }
        }
    };

    const handleSortOptions = (sortInput: string) => {
        const currentTextIsValid = props.sortOptions.includes(sortInput);
        if (sortInput === "" || currentTextIsValid) {
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
    const holdSelectedIndex = createMemo(() => {
        return props.sortOptions.indexOf(props.currentlySelected);
    });

    return (
        <div class="relative">
            <KeyEvent
                onKeyUp={handleKeyEvent}
                keys={["Enter", "ArrowUp", "ArrowDown", "Escape"]}
            />
            <div
                class="flex h-10 items-center rounded-md border border-teal-700 bg-slate-800"
                onFocusIn={onFocusIn}
                onFocusOut={onFocusOut}
                tabIndex={0}
            >
                <input
                    value={props.selectText}
                    onInput={(e) => {
                        setDropdownIndex(0);
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
                    class="cursor-pointer text-slate-50 outline-none transition-all hover:text-teal-700 focus:outline-none"
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
                    class="cursor-pointer border-l border-slate-500 text-slate-50 outline-none transition-all hover:text-teal-700 focus:outline-none"
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
                <div class="custom-scrollbar absolute z-10 w-full flex-col overflow-y-auto rounded-md border border-t-0 border-teal-400">
                    <div class="max-h-80">
                        <For each={holdSortOptions()}>
                            {(option, index) => (
                                <div
                                    class="group cursor-pointer"
                                    onMouseDown={() => {
                                        props.setSelectText(option);
                                        closeDropdown();
                                        if (props.onValidSelect) {
                                            props.onValidSelect(option);
                                        }
                                    }}
                                >
                                    <a
                                        class={`block border-l-4 bg-gray-950 p-2 transition-colors group-hover:border-blue-600 group-hover:bg-gray-800 group-hover:text-teal-400
                                        ${
                                            holdSelectedIndex() === index()
                                                ? "border-green-600 text-green-600"
                                                : "border-white text-white"
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
