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
    /** Element to measure dropdown width from (defaults to the trigger button) */
    dropdownWidthRef?: HTMLElement;
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
    const colors = () => getThemeColors(props.theme ?? "orange");

    const selectedOption = () => props.options.find((opt) => opt.value === props.value);

    const optionClass = (option: StyledSelectOption, index: number) => {
        const isSelected = props.value === option.value;
        const isHighlighted = index === keyboard.highlightedIndex();

        if (isSelected) {
            return `${colors().activeBorder} ${colors().text} bg-darius-card-hover`;
        }

        if (isHighlighted) {
            return `${colors().activeBorder} bg-darius-card-hover text-darius-text-primary`;
        }

        return `border-transparent bg-darius-card text-darius-text-primary ${colors().hoverText} ${colors().hoverBorderLight}`;
    };

    const updateDropdownPosition = () => {
        if (buttonRef) {
            const rect = buttonRef.getBoundingClientRect();
            const widthRect = props.dropdownWidthRef?.getBoundingClientRect();
            setDropdownPosition({
                top: rect.bottom + 4, // 4px gap (mt-1 equivalent)
                left: widthRect?.left ?? rect.left,
                width: widthRect?.width ?? rect.width
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
                aria-haspopup="listbox"
                aria-expanded={dropdownOpen()}
                class={`flex h-10 w-full items-center justify-between rounded-md border bg-darius-card px-3 py-2 text-left focus:outline-none focus:ring-2 ${colors().border} ${colors().focusBorder} ${colors().ring} ${
                    props.disabled
                        ? "cursor-not-allowed opacity-50"
                        : `cursor-pointer ${colors().hoverBorder}`
                }`}
            >
                <span
                    class={`truncate ${selectedOption() ? "text-darius-text-primary" : "text-darius-text-secondary"}`}
                >
                    {selectedOption()?.label ?? props.placeholder ?? "Select..."}
                </span>
                <ChevronDown
                    size={16}
                    class={`text-darius-text-secondary transition-transform ${
                        dropdownOpen() ? "rotate-180" : ""
                    }`}
                />
            </button>

            <Show when={dropdownOpen()}>
                <Portal>
                    <div
                        ref={dropdownRef}
                        role="listbox"
                        class={`custom-scrollbar fixed z-[100] max-h-60 overflow-auto rounded-md border bg-darius-card shadow-lg ${colors().dropdownBorder}`}
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
                                    role="option"
                                    aria-selected={props.value === option.value}
                                    class={`w-full truncate border-l-4 px-3 py-2 text-left transition-colors hover:bg-darius-card-hover focus:bg-darius-card-hover focus:outline-none ${optionClass(
                                        option,
                                        index()
                                    )}`}
                                    onClick={() => handleSelect(option.value)}
                                    onMouseEnter={() =>
                                        keyboard.setHighlightedIndex(index())
                                    }
                                    onFocus={() => keyboard.setHighlightedIndex(index())}
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
