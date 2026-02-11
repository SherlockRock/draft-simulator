import { createSignal, For, Show, Component } from "solid-js";
import { SelectTheme, getThemeColors } from "../utils/selectTheme";

export type StyledSelectOption = {
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
    const colors = () => getThemeColors(props.theme ?? "teal");

    const selectedOption = () => props.options.find((opt) => opt.value === props.value);

    const closeDropdown = () => {
        setDropdownOpen(false);
    };

    const toggleDropdown = () => {
        if (!props.disabled) {
            setDropdownOpen((prev) => !prev);
        }
    };

    const handleSelect = (value: string) => {
        props.onChange(value);
        closeDropdown();
    };

    return (
        <div
            class={`relative ${props.class ?? ""}`}
            onFocusOut={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    closeDropdown();
                }
            }}
        >
            <button
                type="button"
                onClick={toggleDropdown}
                disabled={props.disabled}
                class={`flex h-10 w-full items-center justify-between rounded-md border bg-slate-800 px-3 py-2 text-left ${colors().border} ${
                    props.disabled
                        ? "cursor-not-allowed opacity-50"
                        : `cursor-pointer ${colors().hoverBorder}`
                }`}
            >
                <span class={selectedOption() ? "text-slate-50" : "text-slate-400"}>
                    {selectedOption()?.label ?? props.placeholder ?? "Select..."}
                </span>
                <svg
                    class={`h-4 w-4 text-slate-400 transition-transform ${
                        dropdownOpen() ? "rotate-180" : ""
                    }`}
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <polyline points="6 9 12 15 18 9" />
                </svg>
            </button>

            <Show when={dropdownOpen()}>
                <div
                    class={`absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-slate-800 shadow-lg ${colors().dropdownBorder}`}
                >
                    <For each={props.options}>
                        {(option) => (
                            <button
                                type="button"
                                class={`w-full px-3 py-2 text-left transition-colors ${
                                    props.value === option.value
                                        ? `${colors().text} bg-slate-700`
                                        : `text-slate-50 hover:bg-slate-700 ${colors().hoverText}`
                                }`}
                                onClick={() => handleSelect(option.value)}
                            >
                                {option.label}
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
};
