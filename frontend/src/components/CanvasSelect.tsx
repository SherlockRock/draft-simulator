import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import KeyEvent, { Key } from "../KeyEvent";
import { champions } from "../utils/constants";
import BlankSquare from "/src/assets/BlankSquare.webp";
import { getThemeColors } from "../utils/selectTheme";

type props = {
    pick: string;
    index: () => number;
    handlePickChange: (draftId: string, pickIndex: number, championIndex: string) => void;
    draft: {
        name: string;
        id: string;
        picks: string[];
    };
    indexToShorthand: string[];
    layoutToggle: () => boolean;
    disabled: boolean;
    focusedDraftId: () => string | null;
    focusedSelectIndex: () => number;
    onFocus: () => void;
    onSelectNext: () => void;
    onSelectPrevious: () => void;
    side?: "team1" | "team2";
};

// CanvasSelect is only used in canvas context, so always use purple theme
const colors = getThemeColors("purple");

export const CanvasSelect = (props: props) => {
    const [isFocused, setIsFocused] = createSignal(false);
    const [dropdownOpen, setDropdownOpen] = createSignal(false);
    const [dropdownIndex, setDropdownIndex] = createSignal(-1);
    const [selectText, setSelectText] = createSignal("");
    const [unavailableChampions, setUnavailableChampions] = createSignal<string[]>([]);

    // Refs for scroll management
    let dropdownRef: HTMLDivElement | undefined;
    const buttonRefs: Map<number, HTMLButtonElement> = new Map();
    let inputRef: HTMLInputElement | undefined;

    const spliceIndexToRealIndex = createMemo(() => {
        return props.layoutToggle()
            ? [0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 5, 6, 7, 8, 9]
            : [0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 5, 6, 7, 8, 9, 15, 16, 17, 18, 19];
    });

    createEffect(() => {
        setUnavailableChampions(
            props.draft.picks
                .filter((value) => value !== "")
                .map((value) => champions[Number(value)].name)
        );
    });

    createEffect(() => {
        if (props.pick !== "") {
            setSelectText(champions[Number(props.pick)].name);
        } else {
            setSelectText("");
        }
    });

    createEffect(() => {
        // Check props first to establish dependencies
        const shouldFocus =
            props.focusedDraftId() === props.draft.id &&
            props.focusedSelectIndex() === props.index() &&
            inputRef &&
            document.activeElement !== inputRef;

        if (!shouldFocus) return;

        inputRef.focus();
    });

    // Auto-scroll effect when dropdown index changes
    createEffect(() => {
        const index = dropdownIndex();
        if (dropdownOpen() && index >= 0 && buttonRefs.has(index)) {
            const button = buttonRefs.get(index);
            button?.scrollIntoView({
                block: "nearest"
            });
        }
    });

    const closeDropdown = () => {
        setDropdownOpen(false);
    };

    const onFocusOut = () => {
        setIsFocused(false);
        closeDropdown();
    };

    const onFocusIn = () => {
        if (!props.disabled) {
            setIsFocused(true);
            setDropdownOpen(true);
            props.onFocus?.();
        }
    };

    const handleSortOptions = (sortInput: string) => {
        const currentTextIsValid = champions.find(
            (value) => value.name.toLowerCase() === sortInput.toLowerCase()
        );
        if (sortInput === "" || (currentTextIsValid !== undefined && !dropdownOpen())) {
            return champions;
        }
        return champions.filter((option) =>
            option.name.toLowerCase().includes(sortInput.toLowerCase())
        );
    };

    const holdSortOptions = createMemo(() => {
        const hold = handleSortOptions(selectText());
        return hold;
    });

    const handleKeyEvent = (key: Key) => {
        if (!isFocused() || props.disabled) return;
        switch (key) {
            case "ArrowUp":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === 0) {
                            return holdSortOptions().length - 1;
                        }
                        return prevIndex - 1;
                    });
                }
                break;
            case "ArrowDown":
                if (dropdownOpen()) {
                    setDropdownIndex((prevIndex) => {
                        if (prevIndex === holdSortOptions().length - 1) {
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
                    setSelectText("");
                }
        }
    };

    const selectedChampion = () => {
        return props.pick !== "" ? champions[Number(props.pick)] : null;
    };

    const dropdownClasses = (championName: string, champNotAvailable: boolean) => {
        if (selectedChampion()?.name === championName) {
            return "border-green-600 text-green-600 bg-slate-800 cursor-not-allowed";
        }
        if (champNotAvailable) {
            return "border-slate-400 text-red-500 bg-slate-500 cursor-not-allowed";
        }
        if (
            holdSortOptions().findIndex((value) => value.name === championName) ===
            dropdownIndex()
        ) {
            return `${colors.dropdownBorder} ${colors.text} bg-slate-800 ${colors.hoverBorder} hover:bg-slate-600 ${colors.hoverText}`;
        }
        return `border-black text-slate-50 bg-slate-800 ${colors.hoverBorder} hover:bg-slate-600 ${colors.hoverText}`;
    };

    return (
        <div class="relative flex w-full justify-center">
            <KeyEvent
                onKeyUp={handleKeyEvent}
                keys={["ArrowUp", "ArrowDown", "Escape"]}
            />
            <div onFocusIn={onFocusIn} onFocusOut={onFocusOut} tabIndex={0}>
                <div
                    class="flex w-40 items-center gap-2 rounded bg-slate-800 p-1 text-left text-sm"
                    classList={{
                        "hover:bg-slate-700": !props.disabled
                    }}
                >
                    <Show
                        when={selectedChampion() !== null}
                        fallback={
                            <img src={BlankSquare} alt="blank" class="h-6 w-6 rounded" />
                        }
                    >
                        <img
                            src={selectedChampion()?.img}
                            alt={selectedChampion()?.name}
                            class="h-6 w-6 rounded"
                        />
                    </Show>
                    <input
                        ref={inputRef}
                        value={selectText() ?? props.indexToShorthand[props.index()]}
                        onInput={(e) => {
                            setDropdownIndex(0);
                            setSelectText(e.target.value);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                e.stopPropagation();
                                if (!dropdownOpen()) return;
                                if (dropdownIndex() >= 0) {
                                    const holdOptions = holdSortOptions();
                                    const holdChampName =
                                        holdOptions[dropdownIndex() % holdOptions.length]
                                            .name;
                                    const champNotAvailable =
                                        unavailableChampions().includes(holdChampName);
                                    if (!champNotAvailable) {
                                        setSelectText(holdChampName);
                                        props.handlePickChange(
                                            props.draft.id,
                                            spliceIndexToRealIndex()[props.index()],
                                            holdChampName
                                        );
                                    }
                                }
                                setDropdownOpen(false);
                                e.currentTarget.blur();
                                if (e.shiftKey) {
                                    props.onSelectPrevious?.();
                                } else {
                                    props.onSelectNext?.();
                                }
                            }
                        }}
                        onBlur={() => {
                            const inputValue = selectText().trim();
                            if (inputValue === "") {
                                setSelectText(selectedChampion()?.name || "");
                            }

                            const matchedChampion = champions.find(
                                (champ) =>
                                    champ.name.toLowerCase() === inputValue.toLowerCase()
                            );

                            if (matchedChampion) {
                                const isAvailable = !unavailableChampions().includes(
                                    matchedChampion.name
                                );
                                if (isAvailable) {
                                    setSelectText(matchedChampion.name);
                                    props.handlePickChange(
                                        props.draft.id,
                                        spliceIndexToRealIndex()[props.index()],
                                        matchedChampion.name
                                    );
                                }
                            }
                        }}
                        placeholder={props.indexToShorthand[props.index()]}
                        name="select"
                        id={`${props.draft.id}-${props.index()}-select`}
                        class="h-6 w-full appearance-none bg-inherit px-1 outline-none"
                        classList={{
                            "text-violet-300 placeholder:text-violet-300":
                                props.side === "team1",
                            "text-fuchsia-300 placeholder:text-fuchsia-300":
                                props.side === "team2",
                            "text-slate-50 placeholder:text-slate-200": !props.side
                        }}
                        disabled={props.disabled}
                    />
                    <Show when={selectedChampion() !== null}>
                        <button
                            onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            }}
                            onClick={() => {
                                setSelectText("");
                                setDropdownIndex(0);
                                props.handlePickChange(
                                    props.draft.id,
                                    spliceIndexToRealIndex()[props.index()],
                                    ""
                                );
                            }}
                            class={`cursor-pointer outline-none transition-all focus:outline-none ${
                                props.side === "team1"
                                    ? "text-violet-300 hover:text-violet-200"
                                    : props.side === "team2"
                                      ? "text-fuchsia-300 hover:text-fuchsia-200"
                                      : `text-slate-200 ${colors.hoverText}`
                            }`}
                            disabled={props.disabled}
                        >
                            <svg
                                class="h-4 w-4 fill-current"
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
                    </Show>
                </div>

                <Show when={dropdownOpen() && !props.disabled}>
                    <div
                        ref={dropdownRef}
                        class="absolute z-10 mt-1 max-h-60 w-40 overflow-auto rounded border border-slate-500 bg-white shadow-lg"
                        onWheel={(e) => e.stopPropagation()}
                    >
                        <For each={holdSortOptions()}>
                            {(champion, i) => {
                                const champNotAvailable = unavailableChampions().includes(
                                    champion.name
                                );
                                return (
                                    <button
                                        ref={(el) => buttonRefs.set(i(), el)}
                                        class={`flex w-full items-center gap-2 border-l-4 p-2 text-left text-sm ${dropdownClasses(
                                            champion.name,
                                            champNotAvailable
                                        )}`}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            if (!champNotAvailable) {
                                                setSelectText(champion.name);
                                                props.handlePickChange(
                                                    props.draft.id,
                                                    spliceIndexToRealIndex()[
                                                        props.index()
                                                    ],
                                                    champion.name
                                                );
                                                setDropdownOpen(false);
                                            }
                                        }}
                                        disabled={champNotAvailable}
                                    >
                                        <img
                                            src={champion.img}
                                            alt={champion.name}
                                            class="h-6 w-6 rounded"
                                        />
                                        <span>{champion.name}</span>
                                    </button>
                                );
                            }}
                        </For>
                    </div>
                </Show>
            </div>
        </div>
    );
};
