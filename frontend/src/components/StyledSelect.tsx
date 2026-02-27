import { createSignal, createEffect, For, Show, Component, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronDown } from "lucide-solid";
import { SelectTheme, getThemeColors } from "../utils/selectTheme";
import { createDropdownKeyboard } from "../utils/useDropdownKeyboard";

type StyledSelectOption = {
    value: string;
    label: string;
};

type StyledSelectProps = {
    value: string;
    onChange: (value: string) => void;
    options: StyledSelectOption[];
    placeholder?: string;
    theme?: SelectTheme;
    disabled?: boolean;
    class?: string;
};

export const StyledSelect: Component<StyledSelectProps> = (props) => {
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [dropdownPosition, setDropdownPosition] = createSignal({
        top: 0,
        left: 0,
        width: 0
    });
    let buttonRef: HTMLButtonElement | undefined;
    let dropdownRef: HTMLDivElement | undefined;
    const colors = () => getThemeColors(props.theme ?? "teal");

    const selectedOption = () => props.options.find((opt) => opt.value === props.value);

    const updateDropdownPosition = () => {
        if (buttonRef) {
            const rect = buttonRef.getBoundingClientRect();
            setDropdownPosition({
                top: rect.bottom + 4, // 4px gap (mt-1 equivalent)
                left: rect.left,
                width: rect.width
            });
        }
    };

    const openDropdown = () => {
        if (!props.disabled) {
            updateDropdownPosition();
            setDropdownOpen(true);
            // Start at currently selected item, or first item
            const currentIndex = props.options.findIndex(
                (opt) => opt.value === props.value
            );
            keyboard.resetIndex(currentIndex >= 0 ? currentIndex : 0);
        }
    };

    const closeDropdown = () => {
        setDropdownOpen(false);
    };

    // Click-outside handler for Portal dropdown
    createEffect(() => {
        if (dropdownOpen()) {
            const handleClickOutside = (e: MouseEvent) => {
                const target = e.target as Node;
                if (
                    buttonRef &&
                    !buttonRef.contains(target) &&
                    dropdownRef &&
                    !dropdownRef.contains(target)
                ) {
                    closeDropdown();
                }
            };
            document.addEventListener("mousedown", handleClickOutside);
            onCleanup(() =>
                document.removeEventListener("mousedown", handleClickOutside)
            );
        }
    });

    const toggleDropdown = () => {
        if (dropdownOpen()) {
            closeDropdown();
        } else {
            openDropdown();
        }
    };

    const handleSelect = (value: string) => {
        props.onChange(value);
        closeDropdown();
    };

    const keyboard = createDropdownKeyboard({
        getItemCount: () => props.options.length,
        onSelect: (index) => handleSelect(props.options[index].value),
        onClose: closeDropdown,
        isOpen: dropdownOpen
    });

    const handleKeyDown = (e: KeyboardEvent) => {
        const result = keyboard.handleKeyDown(e);
        if (result === "open") {
            e.preventDefault();
            openDropdown();
        }
    };

    return (
        <div class={`relative ${props.class ?? ""}`}>
            <button
                ref={buttonRef}
                type="button"
                onClick={toggleDropdown}
                onKeyDown={handleKeyDown}
                disabled={props.disabled}
                class={`flex h-10 w-full items-center justify-between rounded-md border bg-slate-800 px-3 py-2 text-left ${colors().border} ${
                    props.disabled
                        ? "cursor-not-allowed opacity-50"
                        : `cursor-pointer ${colors().hoverBorder}`
                }`}
            >
                <span
                    class={`truncate ${selectedOption() ? "text-slate-50" : "text-slate-400"}`}
                >
                    {selectedOption()?.label ?? props.placeholder ?? "Select..."}
                </span>
                <ChevronDown
                    size={16}
                    class={`text-slate-400 transition-transform ${
                        dropdownOpen() ? "rotate-180" : ""
                    }`}
                />
            </button>

            <Show when={dropdownOpen()}>
                <Portal>
                    <div
                        ref={dropdownRef}
                        class={`custom-scrollbar fixed z-[100] max-h-60 overflow-auto rounded-md border bg-slate-800 shadow-lg ${colors().dropdownBorder}`}
                        style={{
                            top: `${dropdownPosition().top}px`,
                            left: `${dropdownPosition().left}px`,
                            width: `${dropdownPosition().width}px`
                        }}
                    >
                        <For each={props.options}>
                            {(option, index) => (
                                <button
                                    ref={(el) => keyboard.setItemRef(index(), el)}
                                    type="button"
                                    class={`w-full truncate px-3 py-2 text-left transition-colors ${
                                        props.value === option.value
                                            ? `${colors().text} bg-slate-700`
                                            : index() === keyboard.highlightedIndex()
                                              ? "bg-slate-700 text-slate-50"
                                              : `text-slate-50 hover:bg-slate-700 ${colors().hoverText}`
                                    }`}
                                    onClick={() => handleSelect(option.value)}
                                    onMouseEnter={() =>
                                        keyboard.setHighlightedIndex(index())
                                    }
                                >
                                    {option.label}
                                </button>
                            )}
                        </For>
                    </div>
                </Portal>
            </Show>
        </div>
    );
};
