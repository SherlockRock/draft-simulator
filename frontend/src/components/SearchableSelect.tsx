import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
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
    textInput?: boolean;
    /** Same chrome, grayed out, all interaction off. */
    disabled?: boolean;
    /** Tooltip on the whole control (e.g. why it is disabled). */
    title?: string;
};

export const SearchableSelect = (props: props) => {
    const [isFocused, setIsFocused] = createSignal(false);
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [dropdownPosition, setDropdownPosition] = createSignal({
        top: 0,
        left: 0,
        width: 0
    });
    let selectRef: HTMLDivElement | undefined;
    const colors = () => getThemeColors(props.theme ?? "orange");

    const updateDropdownPosition = () => {
        if (!selectRef) return;

        const rect = selectRef.getBoundingClientRect();
        setDropdownPosition({
            top: rect.bottom,
            left: rect.left,
            width: rect.width
        });
    };

    const openDropdown = () => {
        updateDropdownPosition();
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
        if (props.disabled === true) return;
        setIsFocused(true);
        openDropdown();
    };

    createEffect(() => {
        if (!dropdownOpen()) return;

        updateDropdownPosition();
        window.addEventListener("resize", updateDropdownPosition);
        window.addEventListener("scroll", updateDropdownPosition, true);

        onCleanup(() => {
            window.removeEventListener("resize", updateDropdownPosition);
            window.removeEventListener("scroll", updateDropdownPosition, true);
        });
    });

    const handleSortOptions = (sortInput: string) => {
        if (sortInput === "" || sortInput === props.currentlySelected) {
            return props.sortOptions;
        }
        const needle = sortInput.toLowerCase();
        return props.sortOptions.filter((option) =>
            option.toLowerCase().includes(needle)
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
        isOpen: dropdownOpen,
        textInput: () => props.textInput
    });

    const handleKeyDown = (e: KeyboardEvent) => {
        if (props.disabled === true || !isFocused()) return;

        // Special case: Escape clears text if dropdown is already closed
        if (e.key === "Escape" && !dropdownOpen()) {
            props.setSelectText("");
            return;
        }

        const result = keyboard.handleKeyDown(e);
        if (result === "open") {
            e.preventDefault();
            e.stopPropagation();
            openDropdown();
            keyboard.resetIndex(0);
        }
    };

    return (
        <div
            ref={selectRef}
            class="relative min-w-20 shrink"
            title={props.title}
            onKeyDown={handleKeyDown}
            onFocusIn={onFocusIn}
            onFocusOut={onFocusOut}
            tabIndex={props.disabled === true ? -1 : 0}
        >
            <div
                class={`flex h-10 items-center rounded-md border bg-darius-card ${
                    props.disabled === true
                        ? "cursor-not-allowed border-darius-disabled opacity-60"
                        : colors().border
                }`}
            >
                <input
                    value={props.selectText}
                    disabled={props.disabled === true}
                    onInput={(e) => {
                        keyboard.resetIndex(0);
                        setDropdownOpen(true);
                        props.setSelectText(e.target.value);
                    }}
                    placeholder={props.placeholder}
                    name="select"
                    id="select"
                    class="w-full select-text appearance-none bg-inherit px-4 outline-none disabled:cursor-not-allowed"
                    classList={{
                        "text-darius-text-primary": props.disabled !== true,
                        "text-darius-text-secondary": props.disabled === true
                    }}
                />
                <button
                    disabled={props.disabled === true}
                    onClick={() => {
                        props.setSelectText("");
                    }}
                    class={`outline-none transition-all focus:outline-none ${
                        props.disabled === true
                            ? "cursor-not-allowed text-darius-text-secondary"
                            : `cursor-pointer text-darius-text-primary ${colors().hoverText}`
                    }`}
                >
                    <X size={16} class="mx-2" />
                </button>
                <label
                    for="show_more"
                    class={`border-l border-darius-border outline-none transition-all focus:outline-none ${
                        props.disabled === true
                            ? "cursor-not-allowed text-darius-text-secondary"
                            : `cursor-pointer text-darius-text-primary ${colors().hoverText}`
                    }`}
                >
                    <button
                        disabled={props.disabled === true}
                        class="flex h-full justify-center disabled:cursor-not-allowed"
                    >
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
                <Portal>
                    <div
                        class={`custom-scrollbar fixed z-[100] flex-col overflow-y-auto rounded-md border border-t-0 ${colors().dropdownBorder}`}
                        style={{
                            top: `${dropdownPosition().top}px`,
                            left: `${dropdownPosition().left}px`,
                            width: `${dropdownPosition().width}px`
                        }}
                    >
                        <div class="max-h-80">
                            <For each={holdSortOptions()}>
                                {(option, index) => (
                                    <div
                                        ref={(el) => keyboard.setItemRef(index(), el)}
                                        class="group cursor-pointer"
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            handleSelect(index());
                                        }}
                                        onMouseEnter={() =>
                                            keyboard.setHighlightedIndex(index())
                                        }
                                    >
                                        <a
                                            class={`block border-l-4 p-2 transition-colors ${
                                                props.currentlySelected === option
                                                    ? `${colors().activeBorder} bg-darius-card-hover ${colors().text}`
                                                    : index() ===
                                                        keyboard.highlightedIndex()
                                                      ? `${colors().activeBorder} bg-darius-card-hover text-darius-text-primary`
                                                      : `border-transparent bg-darius-bg text-darius-text-primary group-hover:bg-darius-card-hover ${colors().groupHoverText} ${colors().groupHoverBorder}`
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
                                <a class="block border-l-4 border-transparent bg-darius-bg p-2 text-darius-text-secondary">
                                    None
                                </a>
                            </Show>
                        </div>
                    </div>
                </Portal>
            )}
        </div>
    );
};
